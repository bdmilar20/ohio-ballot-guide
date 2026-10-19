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
  PROJECTION_SCHEMA_VERSION,
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
  const first = office("For County Commissioner", 2, [
    ["Ada Lovelace", "Democratic"],
    ["Grace Hopper", "Republican"],
  ]);
  const moved = structuredClone(first);
  moved.order = 12;
  moved.source_url = "https://example.gov/another-precinct";
  assert.equal(contestContentId(first), contestContentId(moved));

  const rotated = structuredClone(first);
  rotated.choices.reverse();
  rotated.raw.choice_lines.reverse();
  assert.equal(contestContentId(first), contestContentId(rotated));
  assert.notEqual(ballotId([first]), ballotId([rotated]), "the source snapshot must retain printed rotation");

  const choicesOnly = structuredClone(first);
  choicesOnly.choices.reverse();
  assert.notEqual(contestContentId(first), contestContentId(choicesOnly));

  const missingRawChoice = structuredClone(first);
  missingRawChoice.raw.choice_lines.pop();
  assert.throws(() => contestContentId(missingRawChoice), /one raw choice line group per choice/);

  const issueFirst = issue("Issue 7", 3, "Shall the levy be adopted?");
  const issueReordered = structuredClone(issueFirst);
  issueReordered.choices.reverse();
  issueReordered.raw.choice_lines.reverse();
  assert.notEqual(contestContentId(issueFirst), contestContentId(issueReordered));

  const changed = structuredClone(first);
  changed.choices[0].raw_lines.push("Incumbent");
  assert.notEqual(contestContentId(first), contestContentId(changed));

  const futureField = structuredClone(first);
  futureField.reviewer_note = "Retained normalized content added in schema v2";
  assert.notEqual(contestContentId(first), contestContentId(futureField));

  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(contestContentId(first), contestContentId(reordered));
});

test("normalizes printed office rotation while retaining every observed order", () => {
  const { snapshot, election } = fixture();
  const secondBallot = snapshot.ballots[snapshot.precincts[1].ballot_id];
  const governor = secondBallot.contests[0];
  governor.order = 7;
  governor.choices = [governor.choices[1], governor.choices[0], governor.choices[2]];
  governor.raw.choice_lines = [
    governor.raw.choice_lines[1],
    governor.raw.choice_lines[0],
    governor.raw.choice_lines[2],
  ];
  const commissioner = secondBallot.contests[1];
  commissioner.order = 8;
  commissioner.choices = [commissioner.choices[1], commissioner.choices[0], commissioner.choices[2]];
  commissioner.raw.choice_lines = [
    commissioner.raw.choice_lines[1],
    commissioner.raw.choice_lines[0],
    commissioner.raw.choice_lines[2],
  ];
  rehashSnapshot(snapshot);

  const review = analyzeSnapshot(snapshot, election);
  assert.equal(review.schema_version, PROJECTION_SCHEMA_VERSION);
  assert.equal(review.summary.distinct_contests, 5);
  assert.equal(review.summary.common_to_all_precincts, 4);
  const governorReview = review.common_to_all_precincts.find(
    ({ title }) => title === "For Governor and Lieutenant Governor",
  );
  assert.deepEqual(governorReview.orders, [1, 7]);
  assert.deepEqual(
    governorReview.observed_positions.map(({ position, precinct_count: count }) => [position, count]),
    [[1, 1], [7, 1]],
  );
  assert.deepEqual(
    governorReview.observed_choice_orders.map(({ precinct_count: count }) => count),
    [1, 1],
  );
  assert.deepEqual(
    governorReview.observed_choice_orders[0].choices.map(({ name }) => name),
    ["Amy Acton and David Pepper", "Vivek Ramaswamy and Robert A. McColley", "Write-in"],
  );
  assert.deepEqual(
    governorReview.observed_choice_orders[1].choices.map(({ name }) => name),
    ["Vivek Ramaswamy and Robert A. McColley", "Amy Acton and David Pepper", "Write-in"],
  );

  const result = projectCounty(snapshot, election, {
    maxSourceAgeHours: 24,
    reviewedAt: "2026-10-16T18:00:00.000Z",
    officeMappings: { "For County Commissioner": "county-commissioner" },
    statewideIssueMappings: { "Issue 3": "state-issue-3" },
  });
  assert.deepEqual(
    result.county.races[0].candidates.map(({ name }) => name),
    ["Ada Lovelace", "Grace Hopper"],
  );
  assert.equal(result.county.races[0].source_url, snapshot.source.listing_url);
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

  assert.equal(result.schema_version, PROJECTION_SCHEMA_VERSION);
  assert.equal(result.county.coverage.method, "common_to_all_precincts");
  assert.equal(result.county.coverage.precincts_verified, 2);
  assert.equal(result.county.coverage.precinct_specific_races, 1);
  assert.equal(result.county.coverage.precinct_specific_issues, 0);
  assert.equal(result.county.coverage.source_age_hours_at_review, 12);
  assert.equal(result.county.coverage.reviewed_at, "2026-10-16T18:00:00.000Z");
  assert.match(result.county.coverage.summary, /Candidate order here may differ from the official ballot/);
  assert.doesNotMatch(result.county.coverage.summary, /alphabetical/);
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
    const contest = ballot.contests[0];
    const candidateIndex = contest.choices.findIndex(
      ({ name }) => name === "Vivek Ramaswamy and Robert A. McColley",
    );
    contest.choices.splice(candidateIndex, 1);
    contest.raw.choice_lines.splice(candidateIndex, 1);
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

test("resolves a statewide race when the county prints the term qualifier in the title", () => {
  // The vendor application is not consistent about where a seat's term
  // qualifier goes. Adams prints "(Full term commencing 1-1-2027)" among the
  // contest instructions, and the surveyed ballots of other counties print the
  // same qualifier inside the title. Only the title reaches the statewide
  // matcher, and before this the qualifier emptied possible_statewide_race_ids
  // --- which is the dangerous failure, not a loud one: the projector stops
  // warning that the contest may duplicate a statewide race and instead asks
  // for a county office mapping, and a county that supplies one publishes the
  // statewide race a second time as its own county content.
  for (const qualifier of ["(Full term commencing 1-1-2027)", "(Unexpired term ending 1-2-2029)"]) {
    const { snapshot, election } = fixture();
    for (const ballot of Object.values(snapshot.ballots)) {
      const governor = ballot.contests[0];
      governor.title = `For Governor and Lieutenant Governor ${qualifier}`;
      governor.raw.heading_lines[0] = governor.title;
    }
    rehashSnapshot(snapshot);

    const review = analyzeSnapshot(snapshot, election);
    const governor = review.common_to_all_precincts.find(({ title }) => title.startsWith("For Governor"));
    assert.equal(
      governor.published_statewide_race_id,
      "governor",
      `${qualifier} in the title must not hide a statewide race`,
    );
  }
});

test("keeps the district parenthetical that tells two different seats apart", () => {
  // Dropping the term qualifier must not drop the parentheticals beside it. A
  // district is part of the office's identity, so a 7th District contest must
  // not match a published 4th District race even with identical candidates.
  const appeals = (district) => office(`For Judge of the Court of Appeals (${district} District)`, 1, [
    ["Ada Lovelace", "Democratic"],
    ["Grace Hopper", "Republican"],
    ["Write-in", null, true],
  ]);
  const election = {
    id: "2026-11-03-general",
    statewide_races: [{
      id: "court-of-appeals-4th",
      office: "Judge of the Court of Appeals (4th District)",
      candidates: [
        { name: "Ada Lovelace", party: "Democratic" },
        { name: "Grace Hopper", party: "Republican" },
      ],
    }],
    issues: [],
  };
  const snapshotWith = (contest) => {
    const contests = [contest];
    const id = ballotId(contests);
    const { snapshot } = fixture();
    snapshot.precincts = [{ id: "01____1", ballot_id: id }];
    snapshot.ballots = { [id]: { contests } };
    snapshot.enumeration = { listed_precincts: 1, parsed_precincts: 1, skipped: [], unexplained_rows: [] };
    return snapshot;
  };

  const matching = appeals("4th");
  matching.title = `${matching.title} (Full term commencing 2-9-2027)`;
  matching.raw.heading_lines[0] = matching.title;
  assert.deepEqual(
    analyzeSnapshot(snapshotWith(matching), election).common_to_all_precincts[0].possible_statewide_race_ids,
    ["court-of-appeals-4th"],
  );

  const otherDistrict = appeals("7th");
  otherDistrict.title = `${otherDistrict.title} (Full term commencing 2-9-2027)`;
  otherDistrict.raw.heading_lines[0] = otherDistrict.title;
  assert.deepEqual(
    analyzeSnapshot(snapshotWith(otherDistrict), election).common_to_all_precincts[0].possible_statewide_race_ids,
    [],
    "a different appellate district is a different office",
  );
});
