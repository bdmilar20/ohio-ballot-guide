import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ballotId, SCHEMA_VERSION as SNAPSHOT_SCHEMA_VERSION } from "../scripts/ingest/vtrapp.mjs";
import {
  analyzeSnapshot,
  assertCompleteSnapshot,
  contestContentId,
  projectCounty,
} from "../scripts/project-vtrapp.mjs";

function office(title, order, choices, overrides = {}) {
  const normalizedChoices = choices.map(([name, party = null, writeIn = false]) => ({
    name,
    party,
    write_in: writeIn,
    raw_lines: party ? [name, party] : [name],
  }));
  return {
    order,
    kind: "office",
    title,
    subtitles: [],
    instructions: ["(Vote for not more than 1)"],
    vote_for: 1,
    issue_text_lines: null,
    choices: normalizedChoices,
    allows_write_in: normalizedChoices.some((choice) => choice.write_in),
    source_url: `https://example.gov/ballot?p=${order}`,
    raw: {
      heading_lines: [title, "(Vote for not more than 1)"],
      choice_lines: normalizedChoices.map((choice) => choice.raw_lines),
    },
    uncertain: [],
    ...overrides,
  };
}

function issue(title, order, text, overrides = {}) {
  const choices = [
    { name: "For the Levy", party: null, write_in: false, raw_lines: ["For the Levy"] },
    { name: "Against the Levy", party: null, write_in: false, raw_lines: ["Against the Levy"] },
  ];
  return {
    order,
    kind: "issue",
    title,
    subtitles: [],
    instructions: [],
    vote_for: null,
    issue_text_lines: [text],
    choices,
    allows_write_in: false,
    source_url: `https://example.gov/ballot?p=${order}`,
    raw: { heading_lines: [title], choice_lines: choices.map((choice) => choice.raw_lines) },
    uncertain: [],
    ...overrides,
  };
}

function fixture() {
  const governor = office("For Governor and Lieutenant Governor", 1, [
    ["Amy Acton and David Pepper", "Democratic"],
    ["Vivek Ramaswamy and Robert A. McColley", "Republican"],
    ["Write-in", null, true],
  ]);
  const commissioner = office("For County Commissioner", 2, [
    ["Ada Lovelace", "Democratic"],
    ["Grace Hopper", "Republican"],
    ["Write-in", null, true],
  ], { instructions: ["(Full term commencing 1-1-2027)", "(Vote for not more than 1)"] });
  const stateIssue = issue("Issue 3", 3, "Statewide amendment text", {
    subtitles: ["Proposed Constitutional Amendment"],
    choices: [
      { name: "YES", party: null, write_in: false, raw_lines: ["YES"] },
      { name: "NO", party: null, write_in: false, raw_lines: ["NO"] },
    ],
  });
  const countyLevy = issue("Proposed Tax Levy (Additional)", 4, "A countywide levy for children services.");
  const precinctMayor = office("For Village Mayor", 5, [["Katherine Johnson", null]]);
  const common = [governor, commissioner, stateIssue, countyLevy];
  const first = structuredClone([...common, precinctMayor]);
  const second = structuredClone(common);
  const firstId = ballotId(first);
  const secondId = ballotId(second);
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    election: { id: "2026-11-03-general", vendor_key: "20261103G" },
    county: { id: "adams", vendor_slug: "adams" },
    source: {
      listing_url: "https://lookup.boe.ohio.gov/vtrapp/adams/ballotlist.aspx",
      fetched_at: "2026-10-16T18:00:00.000Z",
      source_updated_at: "2026-10-16T02:00:00-04:00",
      source_age_hours: 12,
    },
    enumeration: { listed_precincts: 2, parsed_precincts: 2, skipped: [], unexplained_rows: [] },
    precincts: [
      { id: "01____1", ballot_id: firstId },
      { id: "02____1", ballot_id: secondId },
    ],
    ballots: {
      [firstId]: { contests: first },
      [secondId]: { contests: second },
    },
  };
  const election = {
    id: "2026-11-03-general",
    statewide_races: [
      {
        id: "governor",
        office: "Governor & Lieutenant Governor",
        candidates: [
          { name: "Vivek Ramaswamy & Robert A. McColley", party: "Republican" },
          { name: "Amy Acton & David Pepper", party: "Democratic" },
          { name: "Qualified Person", party: "Write-in" },
        ],
      },
    ],
    issues: [{ id: "state-issue-3", label: "State Issue 3" }],
  };
  return { snapshot, election };
}

function rehashSnapshot(snapshot) {
  const ballots = {};
  const ids = new Map();
  for (const [previousId, ballot] of Object.entries(snapshot.ballots)) {
    const nextId = ballotId(ballot.contests);
    ids.set(previousId, nextId);
    ballots[nextId] = ballot;
  }
  snapshot.ballots = ballots;
  for (const precinct of snapshot.precincts) precinct.ballot_id = ids.get(precinct.ballot_id);
}

test("fingerprints complete normalized content but not source position", () => {
  const first = office("For County Commissioner", 2, [["Ada Lovelace", "Democratic"]]);
  const moved = structuredClone(first);
  moved.order = 12;
  moved.source_url = "https://example.gov/another-precinct";
  assert.equal(contestContentId(first), contestContentId(moved));

  const changed = structuredClone(first);
  changed.choices[0].raw_lines.push("Incumbent");
  assert.notEqual(contestContentId(first), contestContentId(changed));

  const futureField = structuredClone(first);
  futureField.reviewer_note = "Retained normalized content added in schema v2";
  assert.notEqual(contestContentId(first), contestContentId(futureField));

  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(contestContentId(first), contestContentId(reordered));
});

test("refuses incomplete, inconsistent, and altered snapshots", () => {
  const { snapshot } = fixture();
  assert.equal(assertCompleteSnapshot(snapshot), snapshot);

  const skipped = structuredClone(snapshot);
  skipped.enumeration.skipped.push({ reason: "bad row" });
  assert.throws(() => assertCompleteSnapshot(skipped), /skipped precinct rows/);

  const missing = structuredClone(snapshot);
  missing.enumeration.parsed_precincts = 1;
  assert.throws(() => assertCompleteSnapshot(missing), /precinct counts disagree/);

  const altered = structuredClone(snapshot);
  altered.ballots[altered.precincts[0].ballot_id].contests[0].title = "Changed after hashing";
  assert.throws(() => assertCompleteSnapshot(altered), /does not match its normalized content/);

  const dishonestAge = structuredClone(snapshot);
  dishonestAge.source.source_age_hours = 1;
  assert.throws(() => assertCompleteSnapshot(dishonestAge), /disagrees with its timestamps/);
});

// A snapshot read from disk was not necessarily produced by the adapter in this
// working tree, so every ingest gate has to hold here too. These two are the
// replay side of the results-table gate: an unparsed row means the precinct
// list may be a page rather than the county, and intersecting over fewer
// precincts admits *more* content as common to all of them.
test("refuses a snapshot with no evidence that every results-table row was parsed", () => {
  const { snapshot } = fixture();

  const unparsed = structuredClone(snapshot);
  unparsed.enumeration.unexplained_rows.push({ row: ["2"], reason: "neither the header row nor a precinct row" });
  assert.throws(() => assertCompleteSnapshot(unparsed), /rows the adapter did not parse/);

  // Absence is missing evidence, not agreement. A pre-fix snapshot omits the
  // field entirely, and before this gate it projected as a complete county.
  const omitted = structuredClone(snapshot);
  delete omitted.enumeration.unexplained_rows;
  assert.throws(() => assertCompleteSnapshot(omitted), /unexplained_rows must be an array/);

  // The schema version is what actually distinguishes a pre-fix snapshot: the
  // field check alone cannot, because a hand-written file can carry an empty
  // array without a parser ever having checked a row.
  const oldSchema = structuredClone(snapshot);
  oldSchema.schema_version = 1;
  assert.throws(() => assertCompleteSnapshot(oldSchema), /schema_version must be 2/);
});

test("reports only full-content contests present on every precinct", () => {
  const { snapshot, election } = fixture();
  const review = analyzeSnapshot(snapshot, election);
  assert.deepEqual(review.summary, {
    precincts: 2,
    distinct_ballots: 2,
    distinct_contests: 5,
    common_to_all_precincts: 4,
    precinct_specific: 1,
    uncertain_common: 0,
  });
  assert.deepEqual(
    review.common_to_all_precincts.map(({ title }) => title),
    ["For Governor and Lieutenant Governor", "For County Commissioner", "Issue 3", "Proposed Tax Levy (Additional)"],
  );
  assert.equal(review.common_to_all_precincts[0].published_statewide_race_id, "governor");
  assert.deepEqual(review.common_to_all_precincts[0].possible_statewide_race_ids, ["governor"]);
  assert.equal(review.common_to_all_precincts[2].possible_statewide_issue_id, "state-issue-3");
  assert.deepEqual(review.precinct_specific.map(({ title, precinct_count }) => [title, precinct_count]), [
    ["For Village Mayor", 1],
  ]);
});

test("projects reviewed countywide content and keeps precinct content out", () => {
  const { snapshot, election } = fixture();
  const result = projectCounty(snapshot, election, {
    maxSourceAgeHours: 24,
    reviewedAt: "2026-10-16T18:00:00.000Z",
    officeMappings: {
      "For County Commissioner": {
        office_id: "county-commissioner",
        office: "County Commissioner",
      },
    },
    statewideIssueMappings: { "Issue 3": "state-issue-3" },
    countyName: "Adams",
  });

  assert.equal(result.county.coverage.method, "common_to_all_precincts");
  assert.equal(result.county.coverage.precincts_verified, 2);
  assert.equal(result.county.coverage.source_age_hours_at_review, 12);
  assert.equal(result.county.coverage.reviewed_at, "2026-10-16T18:00:00.000Z");
  assert.deepEqual(result.removed_statewide_duplicates.map(({ id }) => id).sort(), ["governor", "state-issue-3"]);
  assert.equal(result.county.races.length, 1);
  assert.equal(result.county.races[0].office_id, "county-commissioner");
  assert.equal(result.county.races[0].scope, "Adams County · Full term commencing 1-1-2027 · Vote for one");
  assert.equal(result.county.races[0].write_in_available, true);
  assert.deepEqual(result.county.races[0].candidates.map(({ name }) => name), ["Ada Lovelace", "Grace Hopper"]);
  assert.equal(result.county.issues.length, 1);
  assert.equal(result.county.issues[0].label, "Proposed Tax Levy (Additional)");
  assert.match(result.county.issues[0].ballot_text, /children services/);
  assert.ok(!JSON.stringify(result.county).includes("For Village Mayor"));

  const eveningReview = projectCounty(snapshot, election, {
    maxSourceAgeHours: 24,
    reviewedAt: "2026-10-17T02:00:00.000Z",
    officeMappings: { "For County Commissioner": "county-commissioner" },
    statewideIssueMappings: { "Issue 3": "state-issue-3" },
  });
  assert.equal(eveningReview.county.coverage.last_verified, "2026-10-16");
});

test("requires explicit freshness, office, issue-duplicate, and uncertainty decisions", () => {
  const { snapshot, election } = fixture();
  assert.throws(() => projectCounty(snapshot, election), /requires maxSourceAgeHours/);
  assert.throws(
    () => projectCounty(snapshot, election, {
      maxSourceAgeHours: 4,
      reviewedAt: "2026-10-16T18:00:00.000Z",
    }),
    /above the accepted 4h limit/,
  );
  assert.throws(
    () => projectCounty(snapshot, election, {
      maxSourceAgeHours: 24,
      reviewedAt: "2026-10-17T18:00:00.000Z",
    }),
    /36h old at review/,
  );
  assert.throws(
    () => projectCounty(snapshot, election, {
      maxSourceAgeHours: 24,
      reviewedAt: "2026-10-16T18:00:00.000Z",
    }),
    /may duplicate state-issue-3|need mappings/,
  );
  assert.throws(
    () => projectCounty(snapshot, election, {
      maxSourceAgeHours: 24,
      reviewedAt: "2026-10-16T18:00:00.000Z",
      statewideIssueMappings: { "Issue 3": "state-issue-3" },
    }),
    /need mappings: For County Commissioner/,
  );

  const uncertain = structuredClone(snapshot);
  for (const ballot of Object.values(uncertain.ballots)) {
    ballot.contests[1].uncertain.push({ reason: "ambiguous party" });
  }
  rehashSnapshot(uncertain);
  assert.throws(
    () => projectCounty(uncertain, election, {
      maxSourceAgeHours: 24,
      reviewedAt: "2026-10-16T18:00:00.000Z",
      officeMappings: { "For County Commissioner": "county-commissioner" },
      statewideIssueMappings: { "Issue 3": "state-issue-3" },
    }),
    /contains an uncertain parse/,
  );
});

test("refuses to publish a possible statewide race as county content", () => {
  const { snapshot, election } = fixture();
  for (const ballot of Object.values(snapshot.ballots)) {
    ballot.contests[0].choices = ballot.contests[0].choices.filter(
      ({ name }) => name !== "Vivek Ramaswamy and Robert A. McColley",
    );
  }
  rehashSnapshot(snapshot);

  const review = analyzeSnapshot(snapshot, election);
  const governor = review.common_to_all_precincts[0];
  assert.equal(governor.published_statewide_race_id, null);
  assert.deepEqual(governor.possible_statewide_race_ids, ["governor"]);

  const options = {
    maxSourceAgeHours: 24,
    reviewedAt: "2026-10-16T18:00:00.000Z",
    officeMappings: {
      "For Governor and Lieutenant Governor": "governor",
      "For County Commissioner": "county-commissioner",
    },
    statewideIssueMappings: { "Issue 3": "state-issue-3" },
  };
  assert.throws(
    () => projectCounty(snapshot, election, options),
    /may duplicate governor; add an explicit statewide race mapping/,
  );
  assert.throws(
    () => projectCounty(snapshot, election, {
      ...options,
      statewideRaceMappings: { "For Governor and Lieutenant Governor": "county-commissioner" },
    }),
    /references county-commissioner, which does not match its office/,
  );

  const result = projectCounty(snapshot, election, {
    ...options,
    statewideRaceMappings: { "For Governor and Lieutenant Governor": "governor" },
  });
  assert.deepEqual(result.county.races.map(({ office_id }) => office_id), ["county-commissioner"]);
  assert.ok(result.removed_statewide_duplicates.some(({ id }) => id === "governor"));
});

test("CLI writes a reviewed projection without editing election data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-projector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { snapshot, election } = fixture();
  const fetchedAt = new Date();
  snapshot.source.fetched_at = fetchedAt.toISOString();
  snapshot.source.source_updated_at = new Date(fetchedAt.getTime() - 12 * 3_600_000).toISOString();
  snapshot.source.source_age_hours = 12;

  const snapshotPath = join(directory, "snapshot.json");
  const electionsPath = join(directory, "elections.json");
  const configPath = join(directory, "config.json");
  const outputPath = join(directory, "projection.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await writeFile(electionsPath, JSON.stringify({ elections: [election] }));
  await writeFile(configPath, JSON.stringify({
    max_source_age_hours: 24,
    county_name: "Adams",
    office_mappings: {
      "For County Commissioner": {
        office_id: "county-commissioner",
        office: "County Commissioner",
      },
    },
    statewide_issue_mappings: { "Issue 3": "state-issue-3" },
  }));

  const result = spawnSync(process.execPath, [
    new URL("../scripts/project-vtrapp.mjs", import.meta.url).pathname,
    "--snapshot", snapshotPath,
    "--elections", electionsPath,
    "--config", configPath,
    "--out", outputPath,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote .*projection\.json/);
  const projection = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(projection.county_id, "adams");
  assert.equal(projection.county.races.length, 1);
  assert.equal(projection.county.issues.length, 1);
  assert.ok(projection.county.coverage.source_age_hours_at_review >= 12);
  assert.equal((await readFile(electionsPath, "utf8")), JSON.stringify({ elections: [election] }));
});

test("CLI review fails when the requested elections data lacks the snapshot election", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-projector-wrong-election-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { snapshot } = fixture();
  const snapshotPath = join(directory, "snapshot.json");
  const electionsPath = join(directory, "elections.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await writeFile(electionsPath, JSON.stringify({ elections: [] }));

  const result = spawnSync(process.execPath, [
    new URL("../scripts/project-vtrapp.mjs", import.meta.url).pathname,
    "--snapshot", snapshotPath,
    "--elections", electionsPath,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /election 2026-11-03-general is absent from --elections data/);
  assert.equal(result.stdout, "");
});
