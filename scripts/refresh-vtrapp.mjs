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
import { projectCounty } from "./project-vtrapp.mjs";

export const REFRESH_MANIFEST_SCHEMA_VERSION = 1;
export const REFRESH_BUNDLE_SCHEMA_VERSION = 2;
export const CANDIDATE_ELECTIONS_FILE = "elections.candidate.json";

export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function candidateDigest(text) {
  invariant(typeof text === "string", "candidate elections content must be text");
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
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

function projectionOptions(job, reviewedAt) {
  return {
    maxSourceAgeHours: job.projection.max_source_age_hours,
    officeMappings: job.projection.office_mappings,
    statewideRaceMappings: job.projection.statewide_race_mappings,
    statewideIssueMappings: job.projection.statewide_issue_mappings,
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
    const projection = projectCounty(snapshot, election, projectionOptions(job, reviewedAt));
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

async function validateCandidate(candidate, projectRoot) {
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-refresh-validation-"));
  try {
    const candidatePath = join(directory, "elections.json");
    await writeJson(candidatePath, candidate);
    const result = spawnSync(process.execPath, [
      join(projectRoot, "scripts", "validate-data.mjs"),
      candidatePath,
      join(projectRoot, "data", "locations.json"),
      join(projectRoot, "data", "offices.json"),
      join(projectRoot, "data", "county-boards.json"),
    ], { encoding: "utf8" });
    invariant(result.status === 0, `candidate elections data failed validation: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function prepareOutputDirectory(outputDirectory, manifest) {
  await mkdir(dirname(outputDirectory), { recursive: true });
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`output directory already exists: ${outputDirectory}`);
    throw error;
  }
  await writeJson(join(outputDirectory, "manifest.json"), manifest);
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
    outputDirectory = resolve(args.out);
    await prepareOutputDirectory(outputDirectory, manifest);
    outputPrepared = true;

    const ingest = snapshotsDirectory
      ? async ({ countyId, electionKey }) => readJson(join(snapshotsDirectory, snapshotFilename({ county: countyId, election: electionKey })))
      : ({ countyId, electionKey, electionId }) => ingestCounty({ countyId, electionKey, electionId });

    const result = await refreshVtrapp({
      manifest,
      electionData,
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

    const validation = await validateCandidate(result.candidate, projectRoot);
    result.summary.validation = validation;
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
