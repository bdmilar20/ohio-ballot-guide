// Runs the expensive county adapter and conservative projector as one manual,
// reviewable refresh. Production data is never edited: a successful run emits
// a candidate elections file alongside the source snapshots and projections.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { electionIdFromKey, ingestCounty, parseArgs } from "./ingest/vtrapp.mjs";
import { officeLabeller, readPatterns, surveyedTitlesFor } from "./map-office-titles.mjs";
import { certifiedIssueText, projectCounty } from "./project-vtrapp.mjs";

export const REFRESH_MANIFEST_SCHEMA_VERSION = 1;
// Bumped from 2 when `inputs` became required. A schema 2 bundle carried only
// the manifest, so there is no way to verify what it read; the gate refuses it
// by version rather than reporting a missing field on a bundle that predates
// the field.
export const REFRESH_BUNDLE_SCHEMA_VERSION = 3;

/**
 * Every data file beside the manifest that a projection decision depends on.
 *
 * The certified issue text keeps a statewide amendment from publishing as
 * county content, the patterns name the office, and the survey is what bounds
 * the titles a pattern may label. Each can change a published office, so each
 * has to be carried into the bundle and verified on replay.
 */
export const REFRESH_INPUT_FILES = [
  "statewide-issue-text.json",
  "office-title-patterns.json",
  "vtrapp-contest-survey.json",
];
export const CANDIDATE_ELECTIONS_FILE = "elections.candidate.json";
export const REFRESH_MANIFEST_FILE = "manifest.json";

export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function candidateDigest(text) {
  invariant(typeof text === "string", "candidate elections content must be text");
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * The same value with every object's keys in sorted order, recursively.
 *
 * Key order carries no meaning in JSON, so two manifests that differ only in
 * it describe the same decisions and a replay of either is the same replay.
 * Comparing raw bytes would refuse a reformatted copy of the very manifest the
 * bundle was built from, which is a false refusal; what has to refuse is a
 * changed decision.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

/**
 * Identifies a manifest by the decisions it makes rather than by its bytes.
 *
 * Found in review: the bundle copied its manifest but nothing ever read that
 * copy back, so replaying a complete bundle with a different `--manifest`
 * silently republished the same snapshot under a different office. The
 * candidate and all three data inputs verified clean, because none of them is
 * where an office mapping lives.
 */
export function manifestDigest(manifest) {
  return candidateDigest(jsonText(canonicalJson(manifest)));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function snapshotFilename({ county, election }) {
  return `${county}-${election}-snapshot.json`;
}

export function projectionFilename({ county, election }) {
  return `${county}-${election}-projection.json`;
}

export function validateRefreshManifest(manifest) {
  invariant(isRecord(manifest), "refresh manifest must be an object");
  invariant(
    manifest.schema_version === REFRESH_MANIFEST_SCHEMA_VERSION,
    `refresh manifest schema_version must be ${REFRESH_MANIFEST_SCHEMA_VERSION}`,
  );
  invariant(Array.isArray(manifest.jobs) && manifest.jobs.length > 0, "refresh manifest needs at least one job");

  const identities = new Set();
  for (const [index, job] of manifest.jobs.entries()) {
    const label = `refresh job ${index + 1}`;
    invariant(isRecord(job), `${label} must be an object`);
    invariant(typeof job.county === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.county), `${label} has an invalid county id`);
    invariant(typeof job.election === "string", `${label} needs a vendor election key`);
    electionIdFromKey(job.election);
    invariant(isRecord(job.projection), `${label} needs projection decisions`);
    invariant(
      Number.isFinite(job.projection.max_source_age_hours) && job.projection.max_source_age_hours >= 0,
      `${label} needs a nonnegative max_source_age_hours`,
    );
    for (const key of ["office_mappings", "statewide_race_mappings", "statewide_issue_mappings"]) {
      if (job.projection[key] !== undefined) {
        invariant(isRecord(job.projection[key]), `${label} ${key} must be an object`);
      }
    }

    const identity = `${job.county}\0${job.election.toUpperCase()}`;
    invariant(!identities.has(identity), `${label} duplicates ${job.county} ${job.election}`);
    identities.add(identity);
  }
  return manifest;
}

function countCounty(county) {
  return {
    races: county?.races?.length ?? 0,
    issues: county?.issues?.length ?? 0,
    coverage_status: county?.coverage?.status ?? null,
    coverage_method: county?.coverage?.method ?? null,
  };
}

function projectionOptions(
  job,
  electionId,
  reviewedAt,
  statewideIssueText,
  officeTitlePatterns = { patterns: [], corrections: [] },
  contestSurvey = null,
) {
  return {
    maxSourceAgeHours: job.projection.max_source_age_hours,
    officeMappings: job.projection.office_mappings,
    statewideRaceMappings: job.projection.statewide_race_mappings,
    statewideIssueMappings: job.projection.statewide_issue_mappings,
    statewideIssueText,
    // Without this the curated patterns are a file nobody reads, and every
    // county still needs its own office table written out by hand.
    labelOffice: officeLabeller({
      ...officeTitlePatterns,
      countyName: job.projection.county_name,
      // Bound to the titles the committed survey saw this county print on
      // this election's ballot. With no survey, or a survey of another
      // election, this is empty and nothing is labelled, which is the right
      // default: a label with no measurement behind it is a guess.
      //
      // It cannot under-cover. The survey reads one precinct, and a contest
      // common to every precinct is by definition on that one, so the
      // surveyed titles are a superset of the titles a projection publishes.
      // What it excludes is a title that appeared after the survey ran, which
      // is exactly the case that should stop and be looked at.
      allowedTitles: surveyedTitlesFor(contestSurvey, job.county, electionId),
    }),
    countyName: job.projection.county_name,
    reviewedAt,
  };
}

/**
 * Refreshes every manifest job serially. The vendor is deliberately paced and
 * stateful, so running county walks concurrently would increase load and make
 * failures harder to attribute.
 */
export async function refreshVtrapp({
  manifest,
  electionData,
  statewideIssueText = {},
  officeTitlePatterns = { patterns: [], corrections: [] },
  contestSurvey = null,
  ingest = ({ countyId, electionKey, electionId }) => ingestCounty({ countyId, electionKey, electionId }),
  now = () => new Date(),
  onSnapshot = async () => {},
  onProjection = async () => {},
}) {
  validateRefreshManifest(manifest);
  invariant(Array.isArray(electionData?.elections), "elections data needs an elections array");

  const candidate = structuredClone(electionData);
  const jobs = [];

  for (const job of manifest.jobs) {
    const electionId = electionIdFromKey(job.election);
    const election = candidate.elections.find(({ id }) => id === electionId);
    invariant(election, `${job.county}: election ${electionId} is absent from elections data`);

    const snapshot = await ingest({
      countyId: job.county,
      electionKey: job.election,
      electionId,
    });
    invariant(snapshot?.county?.id === job.county, `${job.county}: adapter returned a different county`);
    invariant(snapshot?.election?.id === electionId, `${job.county}: adapter returned a different election`);
    await onSnapshot({ job, snapshot });

    const reviewedAtValue = now();
    const reviewedAt = reviewedAtValue instanceof Date ? reviewedAtValue : new Date(reviewedAtValue);
    invariant(Number.isFinite(reviewedAt.getTime()), `${job.county}: refresh clock returned an invalid time`);
    const projection = projectCounty(
      snapshot,
      election,
      projectionOptions(job, electionId, reviewedAt, statewideIssueText, officeTitlePatterns, contestSurvey),
    );
    const before = structuredClone(election.counties?.[job.county] ?? { races: [], issues: [] });
    election.counties ??= {};
    election.counties[job.county] = structuredClone(projection.county);
    await onProjection({ job, projection });

    jobs.push({
      county_id: job.county,
      election_id: electionId,
      vendor_election_key: job.election,
      snapshot_file: snapshotFilename(job),
      projection_file: projectionFilename(job),
      source_updated_at: snapshot.source.source_updated_at,
      fetched_at: snapshot.source.fetched_at,
      precincts: snapshot.precincts.length,
      distinct_ballots: Object.keys(snapshot.ballots).length,
      common_to_all_precincts: projection.review.summary.common_to_all_precincts,
      precinct_specific: projection.review.summary.precinct_specific,
      removed_statewide_duplicates: projection.removed_statewide_duplicates.map(({ id }) => id),
      before: countCounty(before),
      after: countCounty(projection.county),
      reviewed_at: reviewedAt.toISOString(),
    });
  }

  return {
    candidate,
    summary: {
      schema_version: REFRESH_BUNDLE_SCHEMA_VERSION,
      status: "complete",
      completed_jobs: jobs.length,
      candidate_elections_file: CANDIDATE_ELECTIONS_FILE,
      candidate_sha256: candidateDigest(jsonText(candidate)),
      // The office mappings and age limits this run projected under. Recorded
      // so a replay can be held to them; see manifestDigest.
      manifest_sha256: manifestDigest(manifest),
      jobs,
    },
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, jsonText(value));
}

/**
 * The data files the canonical validator reads positionally, in its order.
 *
 * The three projection inputs are overridable because projection and
 * validation have to read the same bytes. They did not: projection could read
 * a bundled or explicitly named pattern file while the validator re-read the
 * repository's, so a malformed-but-shaped bundled pattern drove publication
 * and the good repository copy is what got checked.
 *
 * The coverage survey and stamp log are not overridable here. They are not
 * projection inputs --- nothing in a projection decision reads them --- so
 * there is no divergence to close, and the validator checks them against the
 * committed repository for self-consistency.
 */
export function validatorArguments(candidatePath, projectRoot, inputPaths = {}) {
  const repository = (file) => join(projectRoot, "data", file);
  return [
    candidatePath,
    repository("locations.json"),
    repository("offices.json"),
    repository("county-boards.json"),
    repository("vtrapp-coverage.json"),
    repository("vtrapp-stamp-log.json"),
    inputPaths["statewide-issue-text.json"] ?? repository("statewide-issue-text.json"),
    inputPaths["vtrapp-contest-survey.json"] ?? repository("vtrapp-contest-survey.json"),
    inputPaths["office-title-patterns.json"] ?? repository("office-title-patterns.json"),
  ];
}

function validateCandidateFile(candidatePath, projectRoot, inputPaths) {
  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts", "validate-data.mjs"),
    ...validatorArguments(candidatePath, projectRoot, inputPaths),
  ], { encoding: "utf8" });
  const failure =
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `validator exited with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}`;
  invariant(
    result.status === 0,
    `candidate elections data failed validation: ${failure}`,
  );
  return result.stdout.trim();
}

export async function validateCandidateText(candidateText, projectRoot, inputPaths) {
  invariant(typeof candidateText === "string", "candidate elections content must be text");
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-refresh-validation-"));
  try {
    const candidatePath = join(directory, "elections.json");
    await writeFile(candidatePath, candidateText);
    return validateCandidateFile(candidatePath, projectRoot, inputPaths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function validateCandidate(candidate, projectRoot, inputPaths) {
  return validateCandidateText(jsonText(candidate), projectRoot, inputPaths);
}

async function prepareOutputDirectory(outputDirectory, manifest) {
  await mkdir(dirname(outputDirectory), { recursive: true });
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`output directory already exists: ${outputDirectory}`);
    throw error;
  }
  await writeJson(join(outputDirectory, REFRESH_MANIFEST_FILE), manifest);
  await writeJson(join(outputDirectory, "status.json"), {
    schema_version: REFRESH_BUNDLE_SCHEMA_VERSION,
    status: "running",
    completed_jobs: [],
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let outputDirectory = null;
  let outputPrepared = false;
  const completedJobs = [];
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.manifest) throw new Error("--manifest is required");
    if (!args.out) throw new Error("--out is required and must name a new directory");

    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const manifest = validateRefreshManifest(await readJson(resolve(args.manifest)));
    const electionPath = resolve(args.elections ?? join(projectRoot, "data", "elections.json"));
    const electionData = await readJson(electionPath);
    const snapshotsDirectory = args.snapshots ? resolve(args.snapshots) : null;

    // The bundle being replayed describes, in its own summary, the exact bytes
    // its run read. That record is the only thing that makes a replay a
    // replay: recording a fresh digest of whatever now sits in the snapshot
    // directory proves nothing, because an edited input simply yields a new
    // digest and a different candidate without a word of complaint.
    //
    // Loaded before any input is read so a mismatch stops the run at the
    // start rather than after a walk.
    const replaySummary = snapshotsDirectory
      ? await readJson(join(snapshotsDirectory, "summary.json")).then(
          (summary) => summary,
          (error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        )
      : null;
    if (replaySummary) {
      invariant(
        replaySummary.schema_version === REFRESH_BUNDLE_SCHEMA_VERSION,
        `${snapshotsDirectory} holds a schema ${replaySummary.schema_version} bundle; ` +
          `only schema ${REFRESH_BUNDLE_SCHEMA_VERSION} records the input digests a replay is verified against`,
      );
      invariant(Array.isArray(replaySummary.inputs), `${snapshotsDirectory}/summary.json has no inputs to verify`);
    }
    const recordedInputs = new Map((replaySummary?.inputs ?? []).map((entry) => [entry.file, entry]));
    for (const file of replaySummary ? REFRESH_INPUT_FILES : []) {
      invariant(
        recordedInputs.has(file),
        `${snapshotsDirectory}/summary.json records no digest for ${file}, so that bundle cannot be replayed verifiably`,
      );
    }

    // The manifest is a projection input too --- it is where an office mapping
    // and an age limit live --- and verifying the three data files left it the
    // one decision a replay could change undetected. The bundle's own copy is
    // the record; `--manifest` has to be that manifest.
    if (replaySummary) {
      const recorded = replaySummary.manifest_sha256;
      invariant(
        typeof recorded === "string" && /^sha256:[0-9a-f]{64}$/.test(recorded),
        `${snapshotsDirectory}/summary.json records no manifest_sha256, so its projection decisions cannot be replayed verifiably`,
      );
      const bundledManifestPath = join(snapshotsDirectory, REFRESH_MANIFEST_FILE);
      const bundledManifest = await readJson(bundledManifestPath).then(
        (value) => value,
        (error) => {
          if (error.code === "ENOENT") {
            throw new Error(
              `${snapshotsDirectory}/summary.json records a manifest, but the bundle holds no ${REFRESH_MANIFEST_FILE} to replay`,
            );
          }
          throw error;
        },
      );
      const bundled = manifestDigest(validateRefreshManifest(bundledManifest));
      invariant(
        bundled === recorded,
        `${bundledManifestPath} is ${bundled}, but that bundle's summary records ${recorded}; ` +
          "the bundled manifest has been edited since the run it describes",
      );
      const passed = manifestDigest(manifest);
      invariant(
        passed === recorded,
        `--manifest is ${passed}, but ${snapshotsDirectory}/summary.json records ${recorded}; ` +
          "a replay projects under the manifest its bundle carries. To project saved snapshots under " +
          "different decisions, point --snapshots at a directory holding only the snapshot files",
      );
    }

    const inputs = [];
    async function readInput(file, flag) {
      const explicit = args[flag] ? resolve(args[flag]) : null;
      const recorded = recordedInputs.get(file);
      // A recorded input is a decision the bundle already carries. Pointing a
      // flag at some other file is not a replay of that bundle, so it refuses
      // rather than quietly producing a different candidate from the same
      // manifest and snapshots.
      invariant(
        !(explicit && recorded),
        `--${flag} conflicts with the ${file} recorded in ${snapshotsDirectory}/summary.json; ` +
          "a replay reads the bundle's own copy",
      );
      const replayed = snapshotsDirectory ? join(snapshotsDirectory, file) : null;
      // A replay prefers the copy inside the bundle it is replaying, so the
      // run reproduces that bundle rather than today's working tree.
      const fromBundle = replayed && (await readFile(replayed, "utf8").then(() => true, () => false));
      const path = explicit ?? (fromBundle ? replayed : join(projectRoot, "data", file));
      const text = await readFile(path, "utf8");
      const sha256 = candidateDigest(text);
      if (recorded) {
        invariant(
          fromBundle,
          `${snapshotsDirectory}/summary.json records ${file}, but the bundle holds no copy of it to replay`,
        );
        invariant(
          sha256 === recorded.sha256,
          `${join(snapshotsDirectory, file)} is ${sha256}, but that bundle's summary records ${recorded.sha256}; ` +
            "the bundled input has been edited since the run it describes",
        );
      }
      inputs.push({ file, sha256, source: explicit ? "explicit" : fromBundle ? "bundle" : "repository", text, path });
      return JSON.parse(text);
    }

    const statewideIssueText = certifiedIssueText(await readInput("statewide-issue-text.json", "issue-text"));
    const officeTitlePatterns = readPatterns(await readInput("office-title-patterns.json", "office-title-patterns"));
    const contestSurvey = await readInput("vtrapp-contest-survey.json", "contest-survey");

    outputDirectory = resolve(args.out);
    await prepareOutputDirectory(outputDirectory, manifest);
    outputPrepared = true;
    // Copied byte for byte, so the digest recorded in the summary is a digest
    // of what the bundle actually holds.
    for (const input of inputs) await writeFile(join(outputDirectory, input.file), input.text);

    const ingest = snapshotsDirectory
      ? async ({ countyId, electionKey }) => readJson(join(snapshotsDirectory, snapshotFilename({ county: countyId, election: electionKey })))
      : ({ countyId, electionKey, electionId }) => ingestCounty({ countyId, electionKey, electionId });

    const result = await refreshVtrapp({
      manifest,
      electionData,
      statewideIssueText,
      officeTitlePatterns,
      contestSurvey,
      ingest,
      onSnapshot: ({ job, snapshot }) => writeJson(join(outputDirectory, snapshotFilename(job)), snapshot),
      onProjection: async ({ job, projection }) => {
        await writeJson(join(outputDirectory, projectionFilename(job)), projection);
        completedJobs.push(`${job.county}:${job.election}`);
        await writeJson(join(outputDirectory, "status.json"), {
          schema_version: REFRESH_BUNDLE_SCHEMA_VERSION,
          status: "running",
          completed_jobs: completedJobs,
        });
      },
    });

    // Validated against the bundle's own copies, not the repository's. These
    // are the bytes the projection above read, and the bytes a later gate run
    // will read; checking a different file would validate data that never
    // drove a decision.
    const bundledInputPaths = Object.fromEntries(inputs.map(({ file }) => [file, join(outputDirectory, file)]));
    const validation = await validateCandidate(result.candidate, projectRoot, bundledInputPaths);
    result.summary.validation = validation;
    result.summary.inputs = inputs.map(({ file, sha256, source }) => ({ file, sha256, source }));
    await writeJson(join(outputDirectory, CANDIDATE_ELECTIONS_FILE), result.candidate);
    await writeJson(join(outputDirectory, "summary.json"), result.summary);
    await writeJson(join(outputDirectory, "status.json"), {
      schema_version: REFRESH_BUNDLE_SCHEMA_VERSION,
      status: "complete",
      completed_jobs: completedJobs,
      summary_file: "summary.json",
      candidate_elections_file: CANDIDATE_ELECTIONS_FILE,
    });
    console.log(`Wrote complete refresh bundle to ${outputDirectory}: ${completedJobs.length} job(s)`);
  } catch (error) {
    if (outputPrepared) {
      try {
        await rm(join(outputDirectory, CANDIDATE_ELECTIONS_FILE), { force: true });
        await writeJson(join(outputDirectory, "status.json"), {
          schema_version: REFRESH_BUNDLE_SCHEMA_VERSION,
          status: "failed",
          completed_jobs: completedJobs,
          error: error.message,
        });
      } catch {
        // The original error is more useful when output setup itself failed.
      }
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}
