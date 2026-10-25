// Re-derives which Ohio counties the shared vendor application enumerates a
// complete precinct list for, and writes it as a generated artifact.
//
// The point is that "which counties can we read?" is a question about the
// source, not a list either of us typed. It changes whenever a board loads a
// new election or the vendor changes a row, so it has to be rebuildable:
//
//   npm run survey:vtrapp -- --election 20261103G
//
// Up to three requests per county -- a county not on the vendor answers the
// first GET with a placeholder and costs nothing further, so the whole state
// came to 232 requests, not 264. Cheap next to an ingest, but it still talks to
// a live government server and so is run by hand, never from CI.
//
// **The field is `enumerable`, and it is deliberately weaker than
// "ingestable."** The survey stops after the precinct listing; a real ingest
// then walks every accessible ballot and parses every contest in it. So this
// artifact proves a county has a complete, adapter-compatible precinct list --
// the precondition for an ingest -- and says nothing about whether the walk
// would finish. Proving that would cost the walk, which would defeat the
// survey. The gates it does apply come from assertEnumeration and
// requireSameStamp in the adapter rather than from copies here, because a
// second copy would drift and the drift would read as coverage.

import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertEnumeration,
  classifyCountyResponse,
  createVendorClient,
  electionIdFromKey,
  hiddenFields,
  listingUrl,
  parseArgs,
  parseListing,
  parsePrecincts,
  requireSameStamp,
  vendorSlug,
  VendorTransportError,
} from "./ingest/vtrapp.mjs";
import { appendObservation, emptyLog, observationFromCoverage } from "./vtrapp-stamp-log.mjs";

export const SURVEY_SCHEMA_VERSION = 2;
export const PARTIAL_SCHEMA_VERSION = 1;
export const PARTIAL_MAX_AGE_HOURS = 24;

const SETTLED_RESPONSES = new Set(["served", "not-a-customer"]);

export function isSettledCountyRecord(record) {
  return Boolean(record) &&
    SETTLED_RESPONSES.has(record.response) &&
    !record.transport_error &&
    !record.retryable_error;
}

export class StalePartialSurveyError extends Error {
  constructor(message, countyIds) {
    super(message);
    this.name = "StalePartialSurveyError";
    this.countyIds = countyIds;
  }
}

/**
 * Surveys one county with the same requests the adapter opens with.
 *
 * Nothing here throws on an unservable county: a county that cannot be
 * enumerated is a finding to record, not a failure of the survey. The *reason*
 * comes from the adapter's gates, so a county blocked by something nobody has
 * seen yet is described rather than silently dropped.
 */
export async function surveyCounty({ client, countyId, electionKey }) {
  const slug = vendorSlug(countyId);
  const listing = listingUrl(slug, client.base);
  const record = { vendor_slug: slug, listing_url: listing, enumerable: false };

  const first = await client.request(listing);
  record.response = classifyCountyResponse(first);
  if (record.response !== "served") {
    record.blocked = `the vendor response is "${record.response}", not a served county`;
    return record;
  }

  const initialListing = parseListing(first.body);
  record.elections_offered = initialListing.elections.length;
  record.election_offered = initialListing.elections.some((option) => option.value === electionKey);
  if (!record.election_offered) {
    record.blocked = `election ${electionKey} is absent from the listing`;
    return record;
  }

  await client.pause();
  const selected = await client.post(listing, {
    ...hiddenFields(first.body),
    cmbelectionlist: electionKey,
    __EVENTTARGET: "cmbelectionlist",
    __EVENTARGUMENT: "",
  });
  if (selected.status !== 200) {
    record.retryable_error = true;
    record.blocked = `selecting election ${electionKey} returned HTTP ${selected.status}`;
    return record;
  }
  // Update stamps belong to elections, not counties. The opening page may
  // default to a different election, so the selected response is the first
  // timestamp that identifies the requested precinct listing.
  const parsedListing = parseListing(selected.body);
  record.source_updated_at = parsedListing.sourceUpdatedAt?.iso ?? null;
  if (!record.source_updated_at) {
    record.blocked = 'the selected election has no "Election data last updated" stamp';
    return record;
  }

  await client.pause();
  const listedResponse = await client.post(listing, {
    ...hiddenFields(selected.body),
    cmbelectionlist: electionKey,
    cmbDistrictCat: "",
    btnsubmit: "Find Ballots",
  });
  if (listedResponse.status !== 200) {
    record.retryable_error = true;
    record.blocked = `listing precincts returned HTTP ${listedResponse.status}`;
    return record;
  }

  const enumeration = parsePrecincts(listedResponse.body);
  record.precinct_rows_listed = enumeration.listed;
  record.precinct_rows_parsed = enumeration.precincts.length;
  try {
    // The adapter's source-version gate, applied at the same boundary it
    // applies it. Without this a board that edits between the opening GET and
    // this POST is surveyed as fine and then rejected by ingestCounty, and the
    // survey would be advertising a county the adapter refuses.
    requireSameStamp(countyId, parsedListing.sourceUpdatedRaw, listedResponse.body, "the precinct list");
    assertEnumeration({ countyId, electionKey, ...enumeration });
    record.enumerable = true;
  } catch (error) {
    // The adapter names the county in its messages; the record is already keyed
    // by it, so strip the prefix rather than repeating it.
    const prefix = `${countyId}: `;
    record.blocked = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  // Keep the row-level evidence either way. On a blocked county it is the
  // diagnosis; on an enumerable one it is proof there was nothing to diagnose.
  record.skipped_row_reasons = tally(enumeration.skipped);
  record.unexplained_row_reasons = tally(enumeration.unexplained);
  return record;
}

function tally(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

export function summarize(counties) {
  const records = Object.values(counties);
  const enumerable = records.filter((record) => record.enumerable);
  return {
    counties: records.length,
    served: records.filter(
      (record) => record.response === "served" && isSettledCountyRecord(record),
    ).length,
    not_a_customer: records.filter(
      (record) => record.response === "not-a-customer" && isSettledCountyRecord(record),
    ).length,
    unknown_slug: records.filter(
      (record) => record.response === "unknown-slug" && isSettledCountyRecord(record),
    ).length,
    // A county the survey could not reach has no vendor response to classify.
    // Counting it keeps the response categories summing to `counties`, so a
    // reader cannot lose a county between the lines of the summary -- which is
    // exactly what happened on the run that produced this file: Ottawa timed
    // out, and served + not_a_customer + unknown_slug came to 87 of 88.
    // Includes unanswered requests and HTTP responses that are not durable
    // evidence about a board (for example a temporary 403 or 500 edge page).
    transport_errors: records.filter((record) => !isSettledCountyRecord(record)).length,
    enumerable: enumerable.length,
    blocked: records.length - enumerable.length,
    precinct_splits: enumerable.reduce((total, record) => total + record.precinct_rows_parsed, 0),
  };
}

/**
 * Reads whole county records left by earlier attempts at the same survey.
 *
 * The journal is scoped to one election and records the start time of the run
 * that actually observed each county. A resumed survey can therefore append
 * truthful, per-attempt stamp observations instead of pretending counties
 * read hours or days apart were all seen at the final restart time.
 */
export async function readPartial(path, electionKey, {
  now = new Date(),
  maxAgeHours = Infinity,
  latestCommittedAt = null,
} = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { counties: {}, observations: [] };
    throw error;
  }

  const counties = {};
  const observations = [];
  let current = null;
  let previousObservedAt = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`${path}: a partial survey line is not valid JSON; delete the file to start the survey over`);
    }
    if (entry.schema_version !== PARTIAL_SCHEMA_VERSION) {
      throw new Error(`${path}: partial survey must be schema ${PARTIAL_SCHEMA_VERSION}`);
    }
    if (entry.election !== electionKey) {
      throw new Error(`${path}: holds election ${entry.election}, not ${electionKey}`);
    }
    if (typeof entry.county !== "string" || !entry.county) {
      throw new Error(`${path}: a partial survey line does not name a county`);
    }
    if (!entry.record || typeof entry.record !== "object" || Array.isArray(entry.record)) {
      throw new Error(`${path}: ${entry.county} has no county record`);
    }
    if (!isSettledCountyRecord(entry.record)) {
      throw new Error(`${path}: ${entry.county} records a retryable response; unsettled requests must be retried`);
    }
    if (counties[entry.county]) {
      throw new Error(`${path}: records ${entry.county} more than once`);
    }
    const observedAt = Date.parse(entry.observed_at);
    if (!Number.isFinite(observedAt)) {
      throw new Error(`${path}: ${entry.county} has an invalid observed_at timestamp`);
    }
    if (previousObservedAt !== null && observedAt < previousObservedAt) {
      throw new Error(`${path}: observations are not in chronological order`);
    }
    previousObservedAt = observedAt;

    counties[entry.county] = entry.record;
    if (!current || current.observed_at !== entry.observed_at) {
      current = {
        observed_at: entry.observed_at,
        election: electionKey,
        source: "scripts/survey-vtrapp.mjs",
        surveyed: [],
        stamps: {},
      };
      observations.push(current);
    }
    current.surveyed.push(entry.county);
    if (entry.record.source_updated_at) current.stamps[entry.county] = entry.record.source_updated_at;
  }
  if (observations.length > 0) {
    const countyIds = Object.keys(counties);
    const oldest = Date.parse(observations[0].observed_at);
    const latest = Date.parse(observations.at(-1).observed_at);
    const nowInstant = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowInstant)) throw new Error("partial journal comparison time must be valid");
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
      if (maxAgeHours !== Infinity) throw new Error("partial journal maxAgeHours must be nonnegative");
    } else if (nowInstant - oldest > maxAgeHours * 3_600_000) {
      throw new StalePartialSurveyError(
        `${path}: partial survey is older than ${maxAgeHours}h; discarding ${countyIds.join(", ")}`,
        countyIds,
      );
    }
    if (latestCommittedAt !== null) {
      const committed = Date.parse(latestCommittedAt);
      if (!Number.isFinite(committed)) throw new Error("latest committed observation must be a timestamp");
      if (latest < committed) {
        throw new StalePartialSurveyError(
          `${path}: partial survey predates the committed observation at ${latestCommittedAt}; discarding ${countyIds.join(", ")}`,
          countyIds,
        );
      }
    }
  }
  return { counties, observations };
}

/**
 * Replays observations recovered from a partial journal into the append-only
 * stamp log. An exact observation already present means a prior finalization
 * wrote the log but died before deleting the journal, so it is safe to skip.
 */
export function appendPartialObservations(log, observations) {
  let next = log;
  for (const observation of observations) {
    const existing = next.observations.find((candidate) => candidate.observed_at === observation.observed_at);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(observation)) {
        throw new Error(
          `the stamp log already has a different observation at ${observation.observed_at}; refusing to rewrite history`,
        );
      }
      continue;
    }
    next = appendObservation(next, observation);
  }
  return next;
}

export function applyObservationRange(survey, observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error("a completed survey needs at least one observation");
  }
  const observedFrom = observations[0].observed_at;
  const observedThrough = observations.at(-1).observed_at;
  const finalInstant = new Date(observedThrough);
  if (!Number.isFinite(finalInstant.getTime())) {
    throw new Error("a completed survey's final observation must be a timestamp");
  }
  survey.meta.observed_from = observedFrom;
  survey.meta.observed_through = observedThrough;
  survey.meta.generated_on = ohioDate(finalInstant);
  return survey;
}

export async function commitSurveyArtifacts({
  coveragePath,
  coverage,
  logPath = null,
  log = null,
  write = writeFile,
}) {
  if (logPath) {
    if (!log) throw new Error("committing a stamp log requires its content");
    await write(logPath, `${JSON.stringify(log, null, 2)}\n`);
  }
  await write(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
}

export function completedJournalPaths({
  partialPath,
  defaultPartialPath,
  isWholeState,
  bypassedPartial,
  transportErrors,
}) {
  if (transportErrors > 0) return [];
  const paths = new Set(partialPath ? [partialPath] : []);
  if (isWholeState && bypassedPartial) paths.add(defaultPartialPath);
  return [...paths];
}

/** Surveys every county serially, because the vendor is paced and stateful. */
export async function surveyVtrapp({
  countyIds,
  electionKey,
  client = createVendorClient(),
  survey = surveyCounty,
  resumedCounties = {},
  now = () => new Date(),
  onCounty = () => {},
}) {
  if (!Array.isArray(countyIds) || countyIds.length === 0) {
    throw new Error("a survey needs at least one county id");
  }
  const electionId = electionIdFromKey(electionKey);
  const requested = new Set(countyIds);
  for (const countyId of Object.keys(resumedCounties)) {
    if (!requested.has(countyId)) throw new Error(`partial survey contains unrequested county ${countyId}`);
  }
  const counties = {};
  for (const countyId of countyIds) {
    if (resumedCounties[countyId]) {
      const record = resumedCounties[countyId];
      counties[countyId] = record;
      await onCounty({ countyId, record, resumed: true });
      continue;
    }
    // A survey of the whole state is ~232 requests over several minutes, so one
    // slow response is expected rather than exceptional. Letting it propagate
    // cost a 30-county run in testing: the vendor timed out on one county and
    // every county already surveyed went with it. Transport and temporary HTTP
    // failures are kept in the diagnostic result but never treated as settled
    // source evidence.
    let record;
    try {
      record = await survey({ client, countyId, electionKey });
    } catch (error) {
      // Only an unanswered request survives as a finding. Catching everything
      // here would file a parser regression or a bug in this file as 88
      // counties flagged `transport_error`, whose documented remedy is "run it
      // again" -- advice that cannot fix either one, on an artifact that would
      // ship looking like a bad afternoon at the vendor. Those stop the run.
      if (!(error instanceof VendorTransportError)) throw error;
      // Flagged separately because it is not evidence about the county. The
      // vendor declining to serve a ballot is a finding that stays true until
      // the board changes something; failing to reach it is answered by running
      // the survey again.
      record = {
        vendor_slug: vendorSlug(countyId),
        listing_url: listingUrl(vendorSlug(countyId), client.base),
        enumerable: false,
        transport_error: true,
        blocked: `the request failed rather than answering: ${error.message}`,
      };
    }
    if (!isSettledCountyRecord(record) && !record.transport_error) {
      record = {
        ...record,
        retryable_error: true,
        blocked: `${record.blocked ?? `the vendor response is "${record.response}"`} (temporary response; retry required)`,
      };
    }
    counties[countyId] = record;
    await onCounty({ countyId, record, resumed: false });
    await client.pause();
  }
  return {
    meta: {
      schema_version: SURVEY_SCHEMA_VERSION,
      generated_by: "scripts/survey-vtrapp.mjs",
      generated_on: ohioDate(now()),
      note: "Generated file. Do not hand-edit; re-run npm run survey:vtrapp.",
      vendor_base: client.base,
      election: { id: electionId, vendor_key: electionKey },
      summary: summarize(counties),
    },
    counties,
  };
}

/** The vendor's day in Ohio's time zone, matching the other generated files. */
function ohioDate(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.election) throw new Error("--election is required (a vendor key, e.g. 20261103G)");

    // The county list comes from the board directory rather than from a list in
    // this file, so a survey covers whatever the repo says Ohio's counties are.
    const boardsUrl = new URL("../data/county-boards.json", import.meta.url);
    const { counties: boards } = JSON.parse(await readFile(boardsUrl, "utf8"));
    const countyIds = args.counties ? args.counties.split(",").map((id) => id.trim()) : Object.keys(boards);
    for (const countyId of countyIds) {
      if (!boards[countyId]) throw new Error(`${countyId} is not a county in data/county-boards.json`);
    }

    const isWholeState = !args.counties;
    if (!isWholeState && !args.out) {
      throw new Error("--counties is a partial survey and requires --out so it cannot replace canonical coverage");
    }
    if (!isWholeState && args.log !== "none") {
      throw new Error("--counties cannot append a statewide stamp observation; pass --log none");
    }
    const out = args.out ? resolve(args.out) : fileURLToPath(new URL("../data/vtrapp-coverage.json", import.meta.url));
    const defaultPartialPath = fileURLToPath(
      new URL(`../.cache/vtrapp-survey-${args.election}.ndjson`, import.meta.url),
    );
    const partialPath =
      args.partial === "none"
        ? null
        : args.partial
          ? resolve(args.partial)
          : isWholeState
            ? defaultPartialPath
            : null;
    const logPath = args.log === "none"
      ? null
      : args.log
        ? resolve(args.log)
        : fileURLToPath(new URL("../data/vtrapp-stamp-log.json", import.meta.url));
    const initialLog = logPath
      ? await readFile(logPath, "utf8").then(JSON.parse, (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })
      : null;
    const observedAt = new Date();
    if (partialPath) await mkdir(dirname(partialPath), { recursive: true });
    let partial = { counties: {}, observations: [] };
    if (partialPath) {
      try {
        partial = await readPartial(partialPath, args.election, {
          now: observedAt,
          maxAgeHours: PARTIAL_MAX_AGE_HOURS,
          latestCommittedAt: initialLog?.observations?.at(-1)?.observed_at ?? null,
        });
      } catch (error) {
        if (!(error instanceof StalePartialSurveyError)) throw error;
        await unlink(partialPath);
        console.error(`${error.message}. Starting a fresh survey.`);
      }
    }

    // A NaN delay silently removes the pacing from a loop that hits a
    // government server 88 times, so it is rejected rather than coerced.
    const delayMs = Number(args.delay ?? 600);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`--delay must be a nonnegative number of milliseconds, not ${JSON.stringify(args.delay)}`);
    }
    const client = createVendorClient({ delayMs });
    const survey = await surveyVtrapp({
      countyIds,
      electionKey: args.election,
      client,
      resumedCounties: partial.counties,
      now: () => observedAt,
      onCounty: async ({ countyId, record, resumed }) => {
        if (resumed) {
          console.error(`${countyId.padEnd(12)} resumed`);
          return;
        }
        const scale = record.enumerable ? `${record.precinct_rows_parsed} splits` : (record.blocked ?? "blocked");
        console.error(`${countyId.padEnd(12)} ${record.enumerable ? "ok     " : "BLOCKED"} ${scale}`);
        // Only an adapter-readable response is evidence about the board. A
        // temporary 403/500 is an answered HTTP request, but it is still edge
        // weather and must be retried rather than frozen into the journal.
        if (partialPath && isSettledCountyRecord(record)) {
          await appendFile(
            partialPath,
            `${JSON.stringify({
              schema_version: PARTIAL_SCHEMA_VERSION,
              election: args.election,
              observed_at: observedAt.toISOString(),
              county: countyId,
              record,
            })}\n`,
          );
        }
      },
    });
    if (survey.meta.summary.transport_errors > 0) {
      if (!args.out) {
        throw new Error(
          `${survey.meta.summary.transport_errors} request(s) did not produce durable source evidence; ` +
            `canonical coverage was not replaced. Re-run the same command to resume completed counties ` +
            `and retry only unsettled requests.`,
        );
      }
      if (args.log !== "none") {
        throw new Error("an incomplete diagnostic survey cannot add freshness evidence; pass --log none");
      }
    }
    const completed = partialPath ? await readPartial(partialPath, args.election) : null;
    const observations = completed?.observations.length
      ? completed.observations
      : [observationFromCoverage(survey, { observedAt })];
    // A resumed artifact can span more than one process and more than one day.
    // Naming that range prevents a resumed run from reading as though every
    // county was observed at the final restart. generated_on follows the final
    // source observation too: a cleanup-only restart can happen the next day.
    applyObservationRange(survey, observations);

    // Coverage answers "can we read this county?" and is rebuilt from scratch
    // each run. Whether its data is settled is a question about change over
    // time, which no single run can answer, so the stamps are also appended to
    // a log. Opting out with --log none keeps a throwaway survey out of the
    // timeline the publication gate reads.
    //
    // One timestamp covers the whole run, though the counties were read over
    // several minutes. Either choice of instant can misstate a county's quiet
    // span by at most the run's duration, which is minutes against a window
    // measured in days, so per-county observation times would be false
    // precision rather than more accuracy.
    let logMessage;
    let nextLog = null;
    if (args.log === "none") {
      logMessage = "Skipped the stamp log (--log none); this run contributes no settlement evidence.";
    } else {
      const existing = await readFile(logPath, "utf8").then(JSON.parse, (error) => {
        if (error.code === "ENOENT") return emptyLog({ election: survey.meta.election });
        throw error;
      });
      nextLog = completed
        ? appendPartialObservations(existing, observations)
        : appendObservation(existing, observations[0]);
      logMessage = `Appended observation ${nextLog.observations.length} to ${logPath}; run npm run gate:vtrapp to see what it settles.`;
    }

    // The append-only evidence is committed before the replaceable coverage
    // view. If coverage writing then fails, the journal remains and the next
    // run replays the exact observation idempotently before trying the write
    // again. Reversing these writes can publish coverage the log never saw.
    await commitSurveyArtifacts({ coveragePath: out, coverage: survey, logPath, log: nextLog });
    const { enumerable, counties, precinct_splits: splits } = survey.meta.summary;
    console.log(`Wrote ${out}: ${enumerable} of ${counties} counties enumerable, ${splits} precinct splits`);
    console.log(logMessage);

    for (const path of completedJournalPaths({
      partialPath,
      defaultPartialPath,
      isWholeState,
      bypassedPartial: args.partial === "none",
      transportErrors: survey.meta.summary.transport_errors,
    })) {
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
