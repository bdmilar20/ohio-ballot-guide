// Re-derives which Ohio counties the shared vendor application can actually
// serve a machine-readable ballot for, and writes it as a generated artifact.
//
// The point is that "which counties can we ingest?" is a question about the
// source, not a list either of us typed. It changes whenever a board loads a
// new election or the vendor changes a row, so it has to be rebuildable:
//
//   npm run survey:vtrapp -- --election 20261103G
//
// Three requests per county, so it is cheap next to an ingest, but it still
// talks to a live government server and so is run by hand, never from CI.
//
// A county is reported ingestable when the adapter's own enumeration gates
// pass. This calls assertEnumeration rather than restating the rules, because
// a second copy of them would drift and the drift would read as coverage.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  vendorSlug,
} from "./ingest/vtrapp.mjs";

export const SURVEY_SCHEMA_VERSION = 1;

/**
 * Surveys one county with the same three requests the adapter opens with.
 *
 * Nothing here throws on an unservable county: a county that cannot be ingested
 * is a finding to record, not a failure of the survey. The *reason* comes from
 * the adapter's gate, so a county blocked by something nobody has seen yet is
 * described rather than silently dropped.
 */
export async function surveyCounty({ client, countyId, electionKey }) {
  const slug = vendorSlug(countyId);
  const listing = listingUrl(slug, client.base);
  const record = { vendor_slug: slug, listing_url: listing, ingestable: false };

  const first = await client.request(listing);
  record.response = classifyCountyResponse(first);
  if (record.response !== "served") {
    record.blocked = `the vendor response is "${record.response}", not a served county`;
    return record;
  }

  const parsedListing = parseListing(first.body);
  record.elections_offered = parsedListing.elections.length;
  record.election_offered = parsedListing.elections.some((option) => option.value === electionKey);
  record.source_updated_at = parsedListing.sourceUpdatedAt?.iso ?? null;
  if (!record.election_offered) {
    record.blocked = `election ${electionKey} is absent from the listing`;
    return record;
  }
  if (!record.source_updated_at) {
    record.blocked = 'the listing has no "Election data last updated" stamp';
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
    record.blocked = `selecting election ${electionKey} returned HTTP ${selected.status}`;
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
    record.blocked = `listing precincts returned HTTP ${listedResponse.status}`;
    return record;
  }

  const enumeration = parsePrecincts(listedResponse.body);
  record.precinct_rows_listed = enumeration.listed;
  record.precinct_rows_parsed = enumeration.precincts.length;
  try {
    assertEnumeration({ countyId, electionKey, ...enumeration });
    record.ingestable = true;
  } catch (error) {
    // The adapter names the county in its messages; the record is already keyed
    // by it, so strip the prefix rather than repeating it.
    const prefix = `${countyId}: `;
    record.blocked = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  // Keep the row-level evidence either way. On a blocked county it is the
  // diagnosis; on an ingestable one it is proof there was nothing to diagnose.
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
  const ingestable = records.filter((record) => record.ingestable);
  return {
    counties: records.length,
    served: records.filter((record) => record.response === "served").length,
    not_a_customer: records.filter((record) => record.response === "not-a-customer").length,
    unknown_slug: records.filter((record) => record.response === "unknown-slug").length,
    ingestable: ingestable.length,
    blocked: records.length - ingestable.length,
    precinct_splits: ingestable.reduce((total, record) => total + record.precinct_rows_parsed, 0),
  };
}

/** Surveys every county serially, because the vendor is paced and stateful. */
export async function surveyVtrapp({
  countyIds,
  electionKey,
  client = createVendorClient(),
  survey = surveyCounty,
  now = () => new Date(),
  onCounty = () => {},
}) {
  if (!Array.isArray(countyIds) || countyIds.length === 0) {
    throw new Error("a survey needs at least one county id");
  }
  const electionId = electionIdFromKey(electionKey);
  const counties = {};
  for (const countyId of countyIds) {
    const record = await survey({ client, countyId, electionKey });
    counties[countyId] = record;
    await onCounty({ countyId, record });
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

    const out = args.out ? resolve(args.out) : fileURLToPath(new URL("../data/vtrapp-coverage.json", import.meta.url));

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
      onCounty: ({ countyId, record }) => {
        const scale = record.ingestable ? `${record.precinct_rows_parsed} splits` : (record.blocked ?? "blocked");
        console.error(`${countyId.padEnd(12)} ${record.ingestable ? "ok     " : "BLOCKED"} ${scale}`);
      },
    });
    await writeFile(out, `${JSON.stringify(survey, null, 2)}\n`);
    const { ingestable, counties, precinct_splits: splits } = survey.meta.summary;
    console.log(`Wrote ${out}: ${ingestable} of ${counties} counties ingestable, ${splits} precinct splits`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
