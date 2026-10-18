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

import { parseArgs } from "./ingest/vtrapp.mjs";
import { assertSettled, DEFAULT_QUIET_HOURS, settlement } from "./vtrapp-stamp-log.mjs";

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
 * Gates every job in a refresh summary.
 *
 * The walk's own stamp and fetch time are used as the final sighting, which is
 * what closes the gap between the last survey and the ingest: a board that
 * edited in that window moved the stamp, and the job fails rather than
 * publishing data nobody watched settle.
 */
export function gateRefresh(log, summary, { quietHours = DEFAULT_QUIET_HOURS } = {}) {
  if (!Array.isArray(summary?.jobs) || summary.jobs.length === 0) {
    throw new Error("refresh summary has no jobs to gate");
  }
  // refreshVtrapp writes summary.json only after every job succeeded, so a
  // readable summary is already evidence of a complete bundle. What is worth
  // checking is that each job carries the three fields this gate reads: a
  // missing one would otherwise surface as the county being "unsettled",
  // which reads as a finding about a board rather than a malformed bundle.
  for (const [index, job] of summary.jobs.entries()) {
    const label = `refresh job ${index + 1}`;
    if (!job?.county_id) throw new Error(`${label} does not name a county`);
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

    if (!args.refresh) {
      const counties = settlement(log, { quietHours });
      for (const line of formatSettlement(counties)) console.log(line);
      console.log(
        `${log.observations.length} observation(s) in the log; a county needs two agreeing ${quietHours}h apart to publish.`,
      );
    } else {
      const summaryPath = join(resolve(args.refresh), "summary.json");
      const results = gateRefresh(log, JSON.parse(await readFile(summaryPath, "utf8")), { quietHours });
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
