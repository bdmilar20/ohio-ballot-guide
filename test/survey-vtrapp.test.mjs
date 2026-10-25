import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createVendorClient, VendorTransportError } from "../scripts/ingest/vtrapp.mjs";
import {
  applyObservationRange,
  appendPartialObservations,
  commitSurveyArtifacts,
  completedJournalPaths,
  isSettledCountyRecord,
  PARTIAL_MAX_AGE_HOURS,
  PARTIAL_SCHEMA_VERSION,
  readPartial,
  StalePartialSurveyError,
  SURVEY_SCHEMA_VERSION,
  summarize,
  surveyCounty,
  surveyVtrapp,
} from "../scripts/survey-vtrapp.mjs";
import { emptyLog } from "../scripts/vtrapp-stamp-log.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => readFile(join(projectRoot, "test", "fixtures", "vtrapp", `${name}.html`), "utf8");

const LISTING = `<html>
  Election data last updated: 10/12/26 02:32:40 PM<br/>
  <select name="cmbelectionlist"><option value="NONE">Select an Election Date</option>
  <option value="20261103G">11/3/2026 General Election</option></select>
  <input type="hidden" name="__VIEWSTATE" value="pos:0" /></html>`;

const precinctRow = (id) => `<tr><td headers="Precinct_Split">${id}</td><td headers="Precinct_Name">P ${id}</td>
  <td headers="Style">X - NONPARTISAN</td><td headers="Link">
    <a href='getballot.aspx?elect=20261103G&prsid=${id}&bpty=X'>View Ballot</a>
    <a href='xmlview.aspx?bpty=x&elec=20261103g&prsid=${id}&lang=en'>View Accessible Ballot</a>
  </td></tr>`;

const STAMP = "10/12/26 02:32:40 PM";

/**
 * The precinct-list response as the vendor actually returns it: carrying its
 * own copy of the update stamp. The fixture used to omit it, which is why the
 * survey could skip the adapter's source-version gate and nothing noticed.
 */
const table = (rows, stamp = STAMP) => `<html>
  ${stamp === null ? "" : `Election data last updated: ${stamp}<br/>`}
  <table id="tblvtrlist">
  <tr><th id="Precinct_Split">s</th><th id="Precinct_Name">n</th><th id="Style">y</th><th id="Link">l</th></tr>
  ${rows}</table></html>`;

/**
 * A vendor that answers only the three requests a survey makes, so a survey
 * that started walking ballots would fail here rather than quietly cost 500
 * requests per county.
 */
function fakeVendor({
  listingBody = LISTING,
  selectedBody = listingBody,
  listingStatus = 200,
  precinctBody = table(precinctRow("01____1")),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const body = init.body ? new URLSearchParams(init.body) : null;
    if (!url.includes("ballotlist.aspx")) throw new Error(`a survey must not request ${url}`);
    if (!body) return respond(listingStatus, listingBody);
    if (body.has("btnsubmit")) return respond(200, precinctBody);
    return respond(200, selectedBody);
  };
  return { fetchImpl, calls };
}

const respond = (status, body) => ({ status, ok: status < 400, text: async () => body });

const clientFor = (vendor) => createVendorClient({ fetchImpl: vendor.fetchImpl, delayMs: 0 });

test("records an enumerable county with the evidence that it was enumerable", async () => {
  const vendor = fakeVendor({ precinctBody: table(precinctRow("01____1") + precinctRow("01____2")) });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });

  assert.equal(record.enumerable, true);
  assert.equal(record.blocked, undefined);
  assert.equal(record.response, "served");
  assert.equal(record.precinct_rows_listed, 2);
  assert.equal(record.precinct_rows_parsed, 2);
  assert.equal(record.source_updated_at, "2026-10-12T14:32:40-04:00");
  assert.deepEqual(record.skipped_row_reasons, {});
  assert.deepEqual(record.unexplained_row_reasons, {});
});

test("records the requested election stamp when the opening page defaults elsewhere", async () => {
  const requestedStamp = "09/30/26 08:14:14 AM";
  const vendor = fakeVendor({
    listingBody: LISTING.replace(STAMP, "10/19/26 09:49:23 AM").replace(
      '<option value="20261103G">',
      '<option selected value="20261103S">11/3/2026 Special Election</option><option value="20261103G">',
    ),
    selectedBody: LISTING.replace(STAMP, requestedStamp),
    precinctBody: table(precinctRow("01____1"), requestedStamp),
  });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "miami", electionKey: "20261103G" });

  assert.equal(record.enumerable, true);
  assert.equal(record.source_updated_at, "2026-09-30T08:14:14-04:00");
});

test("uses the vendor slug, not the county id, so van-wert is surveyed at all", async () => {
  const vendor = fakeVendor();
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "van-wert", electionKey: "20261103G" });
  assert.equal(record.vendor_slug, "vanwert");
  assert.match(record.listing_url, /\/vtrapp\/vanwert\/ballotlist\.aspx$/);
});

// A survey whose first unservable county aborted the run would report the
// counties before it and nothing after, which reads as a short county list
// rather than as a failure.
test("records an unservable county as a finding rather than throwing", async () => {
  const vendor = fakeVendor({ listingBody: await fixture("not-a-customer") });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "wyandot", electionKey: "20261103G" });

  assert.equal(record.enumerable, false);
  assert.equal(record.response, "not-a-customer");
  assert.match(record.blocked, /not a served county/);
  assert.equal(record.precinct_rows_listed, undefined);
});

test("separates a county that is served from one that carries this election", async () => {
  const vendor = fakeVendor({ listingBody: LISTING.replace("20261103G", "20250506P") });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });

  assert.equal(record.response, "served");
  assert.equal(record.election_offered, false);
  assert.equal(record.enumerable, false);
  assert.match(record.blocked, /election 20261103G is absent/);
});

// The point of calling assertEnumeration rather than restating its rules: a
// row the adapter refuses to parse has to block the county here too, or the
// survey advertises coverage the adapter will decline to produce.
test("blocks a county on the adapter's own enumeration gate, not a second copy of it", async () => {
  const vendor = fakeVendor({
    precinctBody: table(`${precinctRow("01____1")}<tr><td colspan="4">1 <a href="#">2</a></td></tr>`),
  });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });

  assert.equal(record.enumerable, false);
  assert.match(record.blocked, /row\(s\) this adapter does not parse/);
  // The adapter names the county; the record is already keyed by it.
  assert.doesNotMatch(record.blocked, /^adams: /);
  assert.deepEqual(record.unexplained_row_reasons, { "neither the header row nor a precinct row": 1 });
});

test("keeps the row evidence on a blocked county so the reason can be diagnosed", async () => {
  const vendor = fakeVendor({
    precinctBody: table(`${precinctRow("01____1")}<tr><td headers="Precinct_Split">02____1</td>
      <td headers="Precinct_Name">P</td><td headers="Style">X</td><td headers="Link">no links</td></tr>`),
  });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });

  assert.equal(record.enumerable, false);
  assert.equal(record.precinct_rows_listed, 2);
  assert.equal(record.precinct_rows_parsed, 1);
  assert.deepEqual(record.skipped_row_reasons, { "no ballot links in the Link cell": 1 });
});

// The survey applies requireSameStamp at the same boundary ingestCounty does.
// Without it a board editing between the opening GET and the precinct-list POST
// is surveyed as fine and then refused by the adapter, which is the drift
// direction that reads as coverage.
test("blocks a county whose source stamp changed mid-flow", async () => {
  const vendor = fakeVendor({
    precinctBody: table(precinctRow("01____1"), "10/17/26 09:15:00 AM"),
  });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });

  assert.equal(record.enumerable, false);
  assert.match(record.blocked, /source changed during the run \("10\/12\/26 02:32:40 PM" -> "10\/17\/26 09:15:00 AM"\) at the precinct list/);
  // Still a finding, not a throw, and the row evidence survives for diagnosis.
  assert.equal(record.precinct_rows_parsed, 1);
});

test("blocks a county whose precinct list carries no stamp at all", async () => {
  // Absence is missing identity evidence, not agreement, so it fails closed.
  const vendor = fakeVendor({ precinctBody: table(precinctRow("01____1"), null) });
  const record = await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });

  assert.equal(record.enumerable, false);
  assert.match(record.blocked, /the precinct list carries no "Election data last updated" stamp/);
});

test("surveys three listing requests per county and never walks a ballot", async () => {
  const vendor = fakeVendor();
  await surveyCounty({ client: clientFor(vendor), countyId: "adams", electionKey: "20261103G" });
  assert.equal(vendor.calls.length, 3);
  assert.equal(vendor.calls.filter((call) => call.startsWith("POST")).length, 2);
});

test("summarizes a mixed run by outcome and by scale", () => {
  const summary = summarize({
    adams: { response: "served", enumerable: true, precinct_rows_parsed: 27 },
    "van-wert": { response: "served", enumerable: true, precinct_rows_parsed: 47 },
    wyandot: { response: "not-a-customer", enumerable: false },
    nowhere: { response: "unknown-slug", enumerable: false },
  });

  assert.deepEqual(summary, {
    counties: 4,
    served: 2,
    not_a_customer: 1,
    unknown_slug: 0,
    transport_errors: 1,
    enumerable: 2,
    blocked: 2,
    precinct_splits: 74,
  });
});

test("writes a dated, versioned artifact that names how to rebuild it", async () => {
  const survey = await surveyVtrapp({
    countyIds: ["adams", "wyandot"],
    electionKey: "20261103G",
    client: createVendorClient({ fetchImpl: fakeVendor().fetchImpl, delayMs: 0 }),
    survey: async ({ countyId }) => ({ enumerable: countyId === "adams", response: "served", precinct_rows_parsed: 3 }),
    now: () => new Date("2026-10-18T22:10:00Z"),
  });

  assert.equal(survey.meta.schema_version, SURVEY_SCHEMA_VERSION);
  assert.equal(survey.meta.generated_by, "scripts/survey-vtrapp.mjs");
  assert.equal(survey.meta.generated_on, "2026-10-18");
  assert.match(survey.meta.note, /Do not hand-edit/);
  assert.deepEqual(survey.meta.election, { id: "2026-11-03-general", vendor_key: "20261103G" });
  assert.deepEqual(Object.keys(survey.counties), ["adams", "wyandot"]);
  assert.equal(survey.meta.summary.enumerable, 1);
});

// The stamp is read in Ohio's time zone, not the surveying host's. Run from a
// machine west of Ohio, a UTC date would name the previous day.
test("dates the artifact by Ohio's day, not the host's", async () => {
  const survey = await surveyVtrapp({
    countyIds: ["adams"],
    electionKey: "20261103G",
    client: createVendorClient({ fetchImpl: fakeVendor().fetchImpl, delayMs: 0 }),
    survey: async () => ({ enumerable: true, response: "served", precinct_rows_parsed: 1 }),
    now: () => new Date("2026-10-19T03:10:00Z"),
  });
  assert.equal(survey.meta.generated_on, "2026-10-18");
});

test("resumes whole county records without requesting them again", async () => {
  const attempted = [];
  const result = await surveyVtrapp({
    countyIds: ["adams", "allen"],
    electionKey: "20261103G",
    client: clientFor(fakeVendor()),
    resumedCounties: {
      adams: { enumerable: true, response: "served", precinct_rows_parsed: 27 },
    },
    survey: async ({ countyId }) => {
      attempted.push(countyId);
      return { enumerable: true, response: "served", precinct_rows_parsed: 114 };
    },
  });

  assert.deepEqual(attempted, ["allen"]);
  assert.deepEqual(Object.keys(result.counties), ["adams", "allen"]);
  assert.equal(result.meta.summary.precinct_splits, 141);
});

test("a partial journal preserves each attempt's stamp observation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obg-vtrapp-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "survey.ndjson");
  const lines = [
    {
      schema_version: PARTIAL_SCHEMA_VERSION,
      election: "20261103G",
      observed_at: "2026-10-22T12:00:00.000Z",
      county: "adams",
      record: {
        enumerable: true,
        response: "served",
        precinct_rows_parsed: 27,
        source_updated_at: "2026-10-12T14:32:40-04:00",
      },
    },
    {
      schema_version: PARTIAL_SCHEMA_VERSION,
      election: "20261103G",
      observed_at: "2026-10-24T12:00:00.000Z",
      county: "allen",
      record: {
        enumerable: true,
        response: "served",
        precinct_rows_parsed: 114,
        source_updated_at: "2026-10-13T09:00:00-04:00",
      },
    },
  ];
  await writeFile(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const partial = await readPartial(path, "20261103G");
  assert.deepEqual(Object.keys(partial.counties), ["adams", "allen"]);
  assert.equal(partial.observations.length, 2);
  assert.deepEqual(partial.observations[0].surveyed, ["adams"]);
  assert.deepEqual(partial.observations[1].surveyed, ["allen"]);

  const log = appendPartialObservations(
    emptyLog({ election: { id: "2026-11-03-general", vendor_key: "20261103G" } }),
    partial.observations,
  );
  assert.equal(log.observations.length, 2);
  assert.equal(log.observations[0].observed_at, "2026-10-22T12:00:00.000Z");
  assert.equal(log.observations[1].observed_at, "2026-10-24T12:00:00.000Z");
});

test("a partial journal refuses wrong-election, duplicate, transport, and truncated records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obg-vtrapp-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "survey.ndjson");
  const entry = {
    schema_version: PARTIAL_SCHEMA_VERSION,
    election: "20261103G",
    observed_at: "2026-10-22T12:00:00.000Z",
    county: "adams",
    record: { enumerable: true, response: "served", precinct_rows_parsed: 27 },
  };

  assert.deepEqual(await readPartial(path, "20261103G"), { counties: {}, observations: [] });
  await writeFile(path, `${JSON.stringify(entry)}\n`);
  await assert.rejects(() => readPartial(path, "20260505P"), /holds election 20261103G/);
  await writeFile(path, `${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`);
  await assert.rejects(() => readPartial(path, "20261103G"), /records adams more than once/);
  await writeFile(path, `${JSON.stringify({ ...entry, record: { transport_error: true } })}\n`);
  await assert.rejects(() => readPartial(path, "20261103G"), /retryable response/);
  await writeFile(path, `${JSON.stringify({ ...entry, record: { enumerable: false, response: "error" } })}\n`);
  await assert.rejects(() => readPartial(path, "20261103G"), /retryable response/);
  await writeFile(path, `${JSON.stringify(entry)}\n{"schema_version":1`);
  await assert.rejects(() => readPartial(path, "20261103G"), /not valid JSON/);
});

test("partial observation finalization is idempotent but refuses a conflicting timestamp", () => {
  const observation = {
    observed_at: "2026-10-22T12:00:00.000Z",
    election: "20261103G",
    source: "scripts/survey-vtrapp.mjs",
    surveyed: ["adams"],
    stamps: { adams: "2026-10-12T14:32:40-04:00" },
  };
  const empty = emptyLog({ election: { id: "2026-11-03-general", vendor_key: "20261103G" } });
  const once = appendPartialObservations(empty, [observation]);
  const twice = appendPartialObservations(once, [observation]);
  assert.equal(twice.observations.length, 1);
  assert.throws(
    () => appendPartialObservations(once, [{ ...observation, surveyed: ["allen"], stamps: {} }]),
    /different observation/,
  );
});

test("final coverage dates follow the source observation rather than a later cleanup restart", () => {
  const survey = { meta: { generated_on: "2026-10-25" } };
  applyObservationRange(survey, [
    { observed_at: "2026-10-22T12:00:00.000Z" },
    { observed_at: "2026-10-24T03:30:00.000Z" },
  ]);

  assert.equal(survey.meta.observed_from, "2026-10-22T12:00:00.000Z");
  assert.equal(survey.meta.observed_through, "2026-10-24T03:30:00.000Z");
  assert.equal(survey.meta.generated_on, "2026-10-23", "03:30Z is still the prior day in Ohio");
});

test("partial journals expire and cannot predate newer committed evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obg-vtrapp-stale-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "survey.ndjson");
  const entry = {
    schema_version: PARTIAL_SCHEMA_VERSION,
    election: "20261103G",
    observed_at: "2026-10-22T12:00:00.000Z",
    county: "adams",
    record: { enumerable: true, response: "served", precinct_rows_parsed: 27 },
  };
  await writeFile(path, `${JSON.stringify(entry)}\n`);

  await assert.rejects(
    () => readPartial(path, "20261103G", {
      now: "2026-10-24T12:00:00.001Z",
      maxAgeHours: PARTIAL_MAX_AGE_HOURS,
    }),
    (error) => {
      assert.ok(error instanceof StalePartialSurveyError);
      assert.deepEqual(error.countyIds, ["adams"]);
      assert.match(error.message, /discarding adams/);
      return true;
    },
  );
  await assert.rejects(
    () => readPartial(path, "20261103G", {
      now: "2026-10-22T13:00:00.000Z",
      maxAgeHours: PARTIAL_MAX_AGE_HOURS,
      latestCommittedAt: "2026-10-22T12:00:00.001Z",
    }),
    /predates the committed observation.*discarding adams/,
  );
});

test("commits stamp evidence before replaceable coverage", async () => {
  const writes = [];
  const write = async (path) => {
    writes.push(path);
    if (path === "log.json") throw new Error("log unavailable");
  };
  await assert.rejects(
    () => commitSurveyArtifacts({
      coveragePath: "coverage.json",
      coverage: { meta: {} },
      logPath: "log.json",
      log: { observations: [] },
      write,
    }),
    /log unavailable/,
  );
  assert.deepEqual(writes, ["log.json"], "coverage must stay untouched when the log append fails");

  writes.length = 0;
  await commitSurveyArtifacts({
    coveragePath: "coverage.json",
    coverage: { meta: {} },
    logPath: "log.json",
    log: { observations: [] },
    write: async (path) => writes.push(path),
  });
  assert.deepEqual(writes, ["log.json", "coverage.json"]);
});

test("a clean partial bypass retires the skipped default journal", () => {
  assert.deepEqual(
    completedJournalPaths({
      partialPath: null,
      defaultPartialPath: ".cache/default.ndjson",
      isWholeState: true,
      bypassedPartial: true,
      transportErrors: 0,
    }),
    [".cache/default.ndjson"],
  );
  assert.deepEqual(
    completedJournalPaths({
      partialPath: ".cache/custom.ndjson",
      defaultPartialPath: ".cache/default.ndjson",
      isWholeState: false,
      bypassedPartial: false,
      transportErrors: 1,
    }),
    [],
    "a diagnostic run with an unanswered request must keep its resumable journal",
  );
});

test("refuses a survey with no counties rather than writing an empty artifact", async () => {
  await assert.rejects(
    surveyVtrapp({ countyIds: [], electionKey: "20261103G" }),
    /at least one county/,
  );
});

test("records an unanswered request as one county's finding and keeps surveying", async () => {
  // The failure this is here for: a single vendor timeout used to propagate out
  // of the loop and discard every county already surveyed.
  const attempted = [];
  const survey = async ({ countyId }) => {
    attempted.push(countyId);
    if (countyId === "ottawa") {
      throw new VendorTransportError("https://vendor.example/ballotlist.aspx", new Error("The operation was aborted due to timeout"));
    }
    return { enumerable: true, response: "served", precinct_rows_parsed: 2 };
  };

  const result = await surveyVtrapp({
    countyIds: ["adams", "ottawa", "wyandot"],
    electionKey: "20261103G",
    client: clientFor(fakeVendor()),
    survey,
  });

  assert.deepEqual(attempted, ["adams", "ottawa", "wyandot"], "a timeout must not end the run");
  assert.equal(result.counties.ottawa.transport_error, true);
  assert.equal(result.counties.ottawa.enumerable, false);
  assert.match(result.counties.ottawa.blocked, /failed rather than answering/);
  assert.equal(result.counties.adams.enumerable, true);
  assert.equal(result.counties.wyandot.enumerable, true);
  assert.equal(result.meta.summary.transport_errors, 1);
});

test("treats temporary HTTP and unknown-slug responses as retryable rather than journal evidence", async () => {
  const result = await surveyVtrapp({
    countyIds: ["allen", "van-wert", "wyandot"],
    electionKey: "20261103G",
    client: clientFor(fakeVendor()),
    survey: async ({ countyId }) => {
      if (countyId === "allen") {
        return { enumerable: false, response: "error", blocked: "the vendor response is error" };
      }
      if (countyId === "van-wert") {
        return { enumerable: false, response: "served", retryable_error: true, blocked: "selecting returned HTTP 403" };
      }
      return { enumerable: false, response: "unknown-slug", blocked: "the vendor response is unknown-slug" };
    },
  });

  assert.equal(isSettledCountyRecord(result.counties.allen), false);
  assert.equal(result.counties.allen.retryable_error, true);
  assert.match(result.counties.allen.blocked, /temporary response; retry required/);
  assert.equal(result.counties["van-wert"].retryable_error, true);
  assert.equal(result.counties.wyandot.retryable_error, true);
  assert.equal(result.meta.summary.served, 0, "a failed later request cannot also count as served");
  assert.equal(result.meta.summary.transport_errors, 3);
  assert.equal(result.meta.summary.unknown_slug, 0);
});

test("lets a parse failure end the run instead of filing it as a timeout", async () => {
  // `transport_error` means the vendor never answered, and the artifact tells a
  // reader to re-run. A parser regression answers every re-run the same way, so
  // recording it under that field would ship a broken adapter as 88 counties
  // of weather.
  await assert.rejects(
    surveyVtrapp({
      countyIds: ["adams", "wyandot"],
      electionKey: "20261103G",
      client: clientFor(fakeVendor()),
      survey: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'precincts')");
      },
    }),
    /Cannot read properties of undefined/,
  );
});

test("every surveyed county lands in exactly one response category", () => {
  // Without transport_errors a county goes missing between the summary's
  // lines. A real run hit this: Ottawa timed out, and served plus
  // not-a-customer plus unknown-slug came to 87 of 88 with nothing objecting.
  const summary = summarize({
    adams: { response: "served", enumerable: true, precinct_rows_parsed: 27 },
    wyandot: { response: "not-a-customer", enumerable: false },
    nowhere: { response: "unknown-slug", enumerable: false },
    ottawa: { enumerable: false, transport_error: true },
  });

  assert.equal(summary.unknown_slug, 0);
  assert.equal(summary.transport_errors, 2);
  assert.equal(
    summary.served + summary.not_a_customer + summary.unknown_slug + summary.transport_errors,
    summary.counties,
    "the response categories must account for every record",
  );
});
