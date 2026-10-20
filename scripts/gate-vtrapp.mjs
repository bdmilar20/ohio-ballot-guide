// Decides which counties may be published, from the stamp log rather than from
// a chosen age limit. See scripts/vtrapp-stamp-log.mjs for why.
//
// Report what the log currently supports:
//
//   npm run gate:vtrapp
//
// Gate a finished refresh bundle before applying its candidate diff. Every
// county in the bundle must be settled, at the stamp the walk actually saw:
//
//   npm run gate:vtrapp -- --refresh .cache/vtrapp-refresh-2026-10-20
//
// Exits nonzero when any county in a bundle fails, so it can sit in front of
// publishing without anyone having to read its output.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./ingest/vtrapp.mjs";
import {
  CANDIDATE_ELECTIONS_FILE,
  candidateDigest,
  manifestDigest,
  REFRESH_BUNDLE_SCHEMA_VERSION,
  REFRESH_INPUT_FILES,
  REFRESH_MANIFEST_FILE,
  validateCandidateText,
} from "./refresh-vtrapp.mjs";
import { assertSettled, assertStampLog, DEFAULT_QUIET_HOURS, settlement } from "./vtrapp-stamp-log.mjs";

const STATUS_ORDER = ["settled", "unsettled", "moving", "seen-once", "unobserved", "inconsistent"];

export function formatSettlement(counties) {
  const byStatus = new Map(STATUS_ORDER.map((status) => [status, []]));
  for (const result of Object.values(counties)) {
    if (!byStatus.has(result.status)) byStatus.set(result.status, []);
    byStatus.get(result.status).push(result);
  }
  const lines = [];
  for (const [status, results] of byStatus) {
    if (results.length === 0) continue;
    lines.push(`${status} (${results.length}): ${results.map((result) => result.county_id).join(", ")}`);
  }
  return lines;
}

/**
 * Checks a refresh bundle's artifact-level claims before any publication
 * decision reads it.
 *
 * `inputTexts` is the bundle's own copies of the projection inputs, keyed by
 * filename. When given, each recorded digest is verified against the bytes
 * beside it: without that, `summary.inputs` is a claim about a file nobody
 * compared, and an edited bundled input would pass the gate. `manifest.json`
 * is accepted in the same map and checked the same way, by the semantic digest
 * the refresh records.
 */
export function assertRefreshBundle(summary, candidateText, inputTexts = null) {
  if (summary?.schema_version !== REFRESH_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`refresh summary must be schema ${REFRESH_BUNDLE_SCHEMA_VERSION}`);
  }
  if (summary.status !== "complete") throw new Error("refresh summary is not complete");
  if (!Array.isArray(summary.jobs) || summary.jobs.length === 0) {
    throw new Error("refresh summary has no jobs to gate");
  }
  if (summary.completed_jobs !== summary.jobs.length) {
    throw new Error("refresh summary completed_jobs does not match its jobs");
  }
  if (summary.candidate_elections_file !== CANDIDATE_ELECTIONS_FILE) {
    throw new Error(`refresh summary must name ${CANDIDATE_ELECTIONS_FILE} as its candidate file`);
  }
  if (typeof summary.validation !== "string" || !summary.validation.trim()) {
    throw new Error("refresh summary has no recorded candidate validation result");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(summary.candidate_sha256)) {
    throw new Error("refresh summary has no valid candidate_sha256");
  }
  if (typeof candidateText !== "string") {
    throw new Error(`refresh bundle has no readable ${CANDIDATE_ELECTIONS_FILE}`);
  }
  const actual = candidateDigest(candidateText);
  if (actual !== summary.candidate_sha256) {
    throw new Error(
      `candidate file digest is ${actual}, but this refresh summary records ${summary.candidate_sha256}`,
    );
  }
  assertRefreshManifest(summary, inputTexts);
  assertRefreshInputs(summary, inputTexts);
  return summary;
}

/**
 * The manifest holds the office mappings and age limits the run projected
 * under. It is verified by semantic digest rather than bytes, for the reason
 * canonicalJson gives: reformatting changes no decision, and a changed
 * decision is what must fail.
 */
function assertRefreshManifest(summary, inputTexts) {
  if (!/^sha256:[0-9a-f]{64}$/.test(summary.manifest_sha256)) {
    throw new Error("refresh summary has no valid manifest_sha256, so its projection decisions are unrecorded");
  }
  if (!inputTexts) return;
  const text = inputTexts[REFRESH_MANIFEST_FILE];
  if (typeof text !== "string") throw new Error(`refresh bundle has no readable ${REFRESH_MANIFEST_FILE}`);
  let digest;
  try {
    digest = manifestDigest(JSON.parse(text));
  } catch (error) {
    throw new Error(`refresh bundle has an unreadable ${REFRESH_MANIFEST_FILE}: ${error.message}`);
  }
  if (digest !== summary.manifest_sha256) {
    throw new Error(
      `${REFRESH_MANIFEST_FILE} in this refresh bundle is ${digest}, but its summary records ${summary.manifest_sha256}`,
    );
  }
}

function assertRefreshInputs(summary, inputTexts) {
  if (!Array.isArray(summary.inputs)) {
    throw new Error("refresh summary records no inputs; it cannot be replayed or verified");
  }
  const recorded = new Map(summary.inputs.map((entry) => [entry?.file, entry]));
  for (const file of REFRESH_INPUT_FILES) {
    const entry = recorded.get(file);
    if (!entry) throw new Error(`refresh summary records no digest for ${file}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`refresh summary has no valid sha256 for ${file}`);
    }
    if (!inputTexts) continue;
    const text = inputTexts[file];
    if (typeof text !== "string") throw new Error(`refresh bundle has no readable ${file}`);
    const digest = candidateDigest(text);
    if (digest !== entry.sha256) {
      throw new Error(`${file} in this refresh bundle is ${digest}, but its summary records ${entry.sha256}`);
    }
  }
}

/**
 * Gates every job in a refresh summary.
 *
 * The walk's own stamp and fetch time are used as the final sighting, which is
 * what closes the gap between the last survey and the ingest: a board that
 * edited in that window moved the stamp, and the job fails rather than
 * publishing data nobody watched settle.
 */
export function gateRefresh(log, summary, { quietHours = DEFAULT_QUIET_HOURS, candidateText } = {}) {
  assertRefreshBundle(summary, candidateText);
  // The artifact-level checks above prove this is a complete bundle and that
  // its summary describes the exact candidate file beside it. Each job must
  // also carry the four fields the settlement decision reads: a missing one
  // would otherwise surface as the county being "unsettled", which reads as a
  // finding about a board rather than a malformed bundle.
  //
  // The election key is the one whose absence is not merely confusing. A stamp
  // is only comparable to another stamp for the same election, and nothing
  // downstream notices the mismatch: the settlement rule compares the strings
  // it is given, so a log of November stamps will happily settle a May bundle
  // whose stamp happens to match, and report it as watched evidence. That is a
  // malformed bundle, not an unsettled county, so it fails here -- before any
  // county's settlement is evaluated.
  const logElection = log?.meta?.election?.vendor_key;
  if (!logElection) throw new Error("the stamp log does not name the election it observes");
  for (const [index, job] of summary.jobs.entries()) {
    const label = `refresh job ${index + 1}`;
    if (!job?.county_id) throw new Error(`${label} does not name a county`);
    if (!job.vendor_election_key) {
      throw new Error(`${label} (${job.county_id}) does not name the vendor election it walked`);
    }
    if (job.vendor_election_key !== logElection) {
      throw new Error(
        `${label} (${job.county_id}) walked election ${job.vendor_election_key},` +
          ` but this stamp log observes ${logElection}; a stamp is only evidence about its own election`,
      );
    }
    if (!job.source_updated_at) throw new Error(`${label} (${job.county_id}) has no source_updated_at to gate on`);
    if (!job.fetched_at) throw new Error(`${label} (${job.county_id}) has no fetched_at, so its walk cannot be placed in time`);
  }
  return summary.jobs.map((job) => {
    try {
      const result = assertSettled(log, {
        countyId: job.county_id,
        stamp: job.source_updated_at,
        observedAt: job.fetched_at,
        quietHours,
      });
      return { county_id: job.county_id, passed: true, ...result };
    } catch (error) {
      return { county_id: job.county_id, passed: false, detail: error.message };
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const quietHours = Number(args["quiet-hours"] ?? DEFAULT_QUIET_HOURS);
    if (!Number.isFinite(quietHours) || quietHours < 0) {
      throw new Error(`--quiet-hours must be a nonnegative number, not ${JSON.stringify(args["quiet-hours"])}`);
    }
    const logPath = args.log ? resolve(args.log) : new URL("../data/vtrapp-stamp-log.json", import.meta.url);
    const log = JSON.parse(await readFile(logPath, "utf8"));

    // `npm run check` validates the committed log, but --log takes any file and
    // this command makes a publication decision from it. Validating here means
    // the gate cannot read a log that never went through check: the same rules,
    // from the same function, so the two cannot drift apart.
    const boardsUrl = new URL("../data/county-boards.json", import.meta.url);
    const { counties: boards } = JSON.parse(await readFile(boardsUrl, "utf8"));
    assertStampLog(log, { countyIds: Object.keys(boards) });

    if (!args.refresh) {
      const counties = settlement(log, { quietHours });
      for (const line of formatSettlement(counties)) console.log(line);
      console.log(
        `${log.observations.length} observation(s) in the log; a county needs two agreeing ${quietHours}h apart to publish.`,
      );
    } else {
      const refreshDirectory = resolve(args.refresh);
      const summaryPath = join(refreshDirectory, "summary.json");
      const summary = JSON.parse(await readFile(summaryPath, "utf8"));
      let candidateText;
      const candidatePath = join(refreshDirectory, CANDIDATE_ELECTIONS_FILE);
      try {
        candidateText = await readFile(candidatePath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new Error(`refresh bundle is missing ${CANDIDATE_ELECTIONS_FILE}`);
        }
        throw error;
      }
      // The digest proves this is the candidate described by the refresh, but
      // a hand-built summary could still claim that invalid data was checked.
      // Re-run the canonical offline validator against the exact file before
      // any source-stamp evidence is allowed to approve it.
      // The bundle's own input copies, so the digests in its summary are
      // compared against bytes rather than taken on trust, and so the
      // validator below reads the same files the projection did.
      const inputTexts = {};
      const inputPaths = {};
      for (const file of [...REFRESH_INPUT_FILES, REFRESH_MANIFEST_FILE]) {
        const path = join(refreshDirectory, file);
        // The manifest is verified here but is not one of the validator's
        // positional data files, so it is deliberately absent from inputPaths.
        if (file !== REFRESH_MANIFEST_FILE) inputPaths[file] = path;
        inputTexts[file] = await readFile(path, "utf8").then(
          (text) => text,
          (error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
      }
      assertRefreshBundle(summary, candidateText, inputTexts);
      await validateCandidateText(candidateText, fileURLToPath(new URL("..", import.meta.url)), inputPaths);
      const results = gateRefresh(log, summary, { quietHours, candidateText });
      for (const result of results) {
        console.log(`${result.passed ? "ok     " : "BLOCKED"} ${result.county_id.padEnd(12)} ${result.detail}`);
      }
      const blocked = results.filter((result) => !result.passed);
      if (blocked.length > 0) {
        throw new Error(`${blocked.length} of ${results.length} counties in ${args.refresh} are not settled enough to publish`);
      }
      console.log(`All ${results.length} counties in ${args.refresh} are settled at the stamp they were walked at.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
