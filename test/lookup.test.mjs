import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  contestSequenceLabels,
  countyCoverageNotice,
  daysUntilElection,
  hasPublishedBallotDetails,
  issuesForCounty,
  issueSequenceLabels,
  issueSourceLabel,
  normalizeQuery,
  partitionCandidates,
  racesForCounty,
  resolveLocation,
  selectNextElection,
  sourceLabel,
  upcomingElections,
} from "../src/lookup.mjs";

const data = JSON.parse(
  await readFile(new URL("../data/elections.json", import.meta.url), "utf8"),
);
const locations = JSON.parse(
  await readFile(new URL("../data/locations.json", import.meta.url), "utf8"),
);
const offices = JSON.parse(
  await readFile(new URL("../data/offices.json", import.meta.url), "utf8"),
).offices;
const election = data.elections[0];

function raceSourceNames(races) {
  const sequenceLabels = contestSequenceLabels(races);

  return races.flatMap((race, index) => {
    const labels = [
      "Official ballot",
      ...(race.supplemental_sources ?? []).map(({ label }) => label),
      ...(offices[race.office_id]?.sources ?? []).map(({ label }) => label),
    ];

    return labels.map((label) => sourceLabel(race, label, sequenceLabels[index]));
  });
}

function issueSourceNames(issues) {
  const sequenceLabels = issueSequenceLabels(issues);
  return issues.map((issue, index) => (
    issueSourceLabel(issue, "Official ballot language", sequenceLabels[index])
  ));
}

test("normalizes Ohio city suffixes with or without comma spacing", () => {
  assert.equal(normalizeQuery("  Cleveland, Ohio "), "cleveland");
  assert.equal(normalizeQuery("Cleveland,OH"), "cleveland");
  assert.equal(normalizeQuery("Columbus OH"), "columbus");
});

test("resolves place names and ZIP codes out of the generated index", () => {
  assert.equal(resolveLocation("Cincinnati", locations)?.display_name, "Cincinnati");
  assert.equal(resolveLocation("Cincinnati", locations)?.kind, "place");
  assert.equal(resolveLocation("44113", locations)?.display_name, "44113");
  assert.equal(resolveLocation("44113", locations)?.kind, "zip");
  assert.equal(resolveLocation("  Toledo, Ohio ", locations)?.display_name, "Toledo");
  assert.equal(resolveLocation("", locations), null);
  assert.equal(resolveLocation("Indianapolis", locations), null);
  assert.equal(resolveLocation("90210", locations), null);
});

test("serves locations outside the original three-city pilot", () => {
  // The guide shipped knowing 99 ZIPs and 3 cities. These are places a voter
  // outside Columbus, Cleveland or Cincinnati used to get nothing for.
  assert.deepEqual(resolveLocation("43606", locations)?.county_ids, ["lucas"]);
  assert.deepEqual(resolveLocation("44308", locations)?.county_ids, ["summit"]);
  assert.deepEqual(resolveLocation("45402", locations)?.county_ids, ["montgomery"]);
  assert.deepEqual(resolveLocation("Chillicothe", locations)?.county_ids, ["ross", "jackson", "pike"]);
  assert.equal(Object.keys(locations.counties).length, 88);
});

test("keeps the county answers the curated data was reviewed with", () => {
  const reviewed = {
    43215: ["franklin"],
    43235: ["franklin", "delaware"],
    44113: ["cuyahoga"],
    45212: ["hamilton"],
    45220: ["hamilton"],
    45240: ["hamilton"],
    45249: ["hamilton", "warren"],
    45251: ["hamilton"],
    45693: ["adams"],
  };

  for (const [zip, countyIds] of Object.entries(reviewed)) {
    assert.deepEqual(resolveLocation(zip, locations)?.county_ids, countyIds, `ZIP ${zip}`);
  }
});

test("offers the county holding most of a cross-county ZIP first", () => {
  const majorityCounty = { 43235: "franklin", 45246: "hamilton", 45249: "hamilton", 45255: "hamilton" };

  for (const [zip, expected] of Object.entries(majorityCounty)) {
    const countyIds = resolveLocation(zip, locations)?.county_ids ?? [];
    assert.ok(countyIds.length > 1, `${zip} should still cross county lines`);
    assert.equal(countyIds[0], expected, `${zip} must offer its majority county first`);
  }
});

test("a single-county ZIP never asks the voter to choose", () => {
  const location = resolveLocation("43606", locations);
  assert.equal(location.county_ids.length, 1);
  assert.equal(location.order_basis, "single-county");
});

test("returns county races only after a county is selected", () => {
  assert.equal(racesForCounty("franklin", election.counties).length, 2);
  assert.deepEqual(racesForCounty("delaware", election.counties), []);
  assert.deepEqual(racesForCounty("unknown", election.counties), []);
});

test("returns county issues only after a county is selected", () => {
  const counties = {
    adams: { races: [], issues: [{ id: "adams-levy" }] },
    brown: { races: [], issues: [] },
  };
  assert.deepEqual(issuesForCounty("adams", counties), [{ id: "adams-levy" }]);
  assert.deepEqual(issuesForCounty("brown", counties), []);
  assert.deepEqual(issuesForCounty("unknown", counties), []);
  assert.equal(
    hasPublishedBallotDetails({ statewide_races: [], issues: [], counties }),
    true,
  );
});

test("describes precinct verification only for common-precinct projections", () => {
  const projected = countyCoverageNotice(
    "Adams",
    {
      status: "complete",
      method: "common_to_all_precincts",
      precinct_specific_races: 0,
      precinct_specific_issues: 14,
    },
    1,
    1,
  );
  assert.match(projected.copy, /verified on every enumerated precinct ballot/);
  assert.match(projected.copy, /candidate order here may differ from your ballot/);
  assert.doesNotMatch(projected.copy, /alphabetical/);
  assert.match(projected.copy, /14 additional local issues appear only on some precinct ballots/);
  assert.match(projected.copy, /exact contests and candidate order/);

  const curated = countyCoverageNotice("Franklin", { status: "complete" }, 2, 0);
  assert.match(curated.copy, /covers every verified countywide contest and issue/);
  assert.doesNotMatch(curated.copy, /enumerated precinct ballot/);

  const partial = countyCoverageNotice("Franklin", { status: "partial" }, 2, 0);
  assert.equal(partial.lead, "Approximate location and partial coverage.");
  assert.match(partial.copy, /2 selected contests and 0 issues/);
  assert.doesNotMatch(partial.copy, /enumerated precinct ballot/);
});

test("labels repeated office headings only when scope does not distinguish them", () => {
  const labels = contestSequenceLabels([
    { office: "Justice of the Supreme Court", scope: "Statewide · Term beginning January 1, 2027" },
    { office: "Justice of the Supreme Court", scope: "Statewide · Term beginning January 2, 2027" },
    { office: "County Auditor", scope: "Adams County · Vote for one" },
    { office: "Judge of the Court of Appeals", scope: "Adams County · Vote for one" },
    { office: "Judge of the Court of Appeals", scope: "Adams County · Vote for one" },
  ]);

  assert.deepEqual(labels, [
    null,
    null,
    null,
    "Separate contest 1 of 2",
    "Separate contest 2 of 2",
  ]);
});

test("labels repeated ballot measures only when their visible headings are identical", () => {
  assert.deepEqual(
    issueSequenceLabels([
      { label: "Proposed Tax Levy", title: "Adams County" },
      { label: "Proposed Tax Levy", title: "Adams County" },
      { label: "Proposed Tax Levy", title: "Brown County" },
    ]),
    ["Separate measure 1 of 2", "Separate measure 2 of 2", null],
  );
});

test("includes a ballot measure's sequence cue in its source name", () => {
  const issue = { label: "Proposed Tax Levy", title: "Adams County" };
  assert.equal(
    issueSourceLabel(issue, "Official ballot language", "Separate measure 2 of 2"),
    "Official ballot language — Proposed Tax Levy — Separate measure 2 of 2 — Adams County",
  );
});

test("keeps visible race source labels before the office and scope", () => {
  const race = racesForCounty("summit", election.counties).find(
    ({ id }) => id === "summit-common-pleas-general-2027-01-05",
  );

  assert.equal(
    sourceLabel(race, "Official ballot"),
    "Official ballot — Judge of the Court of Common Pleas, General Division — Summit County · Term beginning January 5, 2027 · Vote for one",
  );
  assert.equal(
    sourceLabel(race, "Summit County General Division judges"),
    "Summit County General Division judges — Judge of the Court of Common Pleas, General Division — Summit County · Term beginning January 5, 2027 · Vote for one",
  );
  assert.equal(
    sourceLabel(race, "Official ballot", "Separate contest 2 of 2"),
    "Official ballot — Judge of the Court of Common Pleas, General Division — Separate contest 2 of 2 — Summit County · Term beginning January 5, 2027 · Vote for one",
  );
});

test("keeps every rendered race source name unique on each county page", () => {
  for (const currentElection of data.elections) {
    const statewideNames = raceSourceNames(currentElection.statewide_races);
    const statewideDuplicates = statewideNames.filter(
      (name, index) => statewideNames.indexOf(name) !== index,
    );
    assert.deepEqual(
      [...new Set(statewideDuplicates)],
      [],
      `${currentElection.id} statewide race sources need unique accessible names`,
    );

    for (const [countyId, county] of Object.entries(currentElection.counties)) {
      const names = [...statewideNames, ...raceSourceNames(county.races)];
      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      assert.deepEqual(
        [...new Set(duplicates)],
        [],
        `${currentElection.id}/${countyId} race sources need unique accessible names`,
      );
    }
  }
});

test("keeps every rendered ballot-measure source name unique on each county page", () => {
  for (const currentElection of data.elections) {
    const statewideNames = issueSourceNames(currentElection.issues);
    for (const [countyId, county] of Object.entries(currentElection.counties)) {
      const names = [...statewideNames, ...issueSourceNames(county.issues)];
      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      assert.deepEqual(
        [...new Set(duplicates)],
        [],
        `${currentElection.id}/${countyId} ballot-measure sources need unique accessible names`,
      );
    }
  }
});

test("publishes sourced, explicitly partial coverage for each covered county", () => {
  const expectedRaceCounts = {
    franklin: 2,
    cuyahoga: 2,
    hamilton: 2,
    montgomery: 9,
    summit: 3,
  };

  for (const [countyId, expectedRaceCount] of Object.entries(expectedRaceCounts)) {
    const county = election.counties[countyId];
    assert.equal(county.coverage.status, "partial");
    assert.match(county.coverage.source_url, /^https:\/\//);
    assert.equal(county.races.length, expectedRaceCount);
  }
});

test("publishes Adams content common to every enumerated precinct ballot", () => {
  const county = election.counties.adams;
  assert.deepEqual(
    {
      status: county.coverage.status,
      method: county.coverage.method,
      precincts: county.coverage.precincts_verified,
      precinctSpecificRaces: county.coverage.precinct_specific_races,
      precinctSpecificIssues: county.coverage.precinct_specific_issues,
      races: county.races.length,
      issues: county.issues.length,
    },
    {
      status: "complete",
      method: "common_to_all_precincts",
      precincts: 27,
      precinctSpecificRaces: 0,
      precinctSpecificIssues: 14,
      races: 8,
      issues: 2,
    },
  );
  assert.deepEqual(
    contestSequenceLabels(county.races).filter(Boolean),
    ["Separate contest 1 of 2", "Separate contest 2 of 2"],
  );
  assert.deepEqual(
    issueSequenceLabels(county.issues),
    ["Separate measure 1 of 2", "Separate measure 2 of 2"],
  );
});

test("uses Montgomery County's current candidate report", () => {
  const races = racesForCounty("montgomery", election.counties);

  assert.deepEqual(
    races.map(({ id, candidates }) => ({
      id,
      candidates: candidates.map(({ name, party }) => ({ name, party })),
    })),
    [
      {
        id: "montgomery-commissioner",
        candidates: [
          { name: "Carolyn Rice", party: "Democratic" },
          { name: "Margie Christie", party: "Republican" },
        ],
      },
      {
        id: "montgomery-auditor",
        candidates: [
          { name: "Karl Keith", party: "Democratic" },
          { name: "Tammy L. Murphy", party: "Republican" },
        ],
      },
      {
        id: "montgomery-common-pleas-2027-01-01",
        candidates: [{ name: "Susan D. Solle", party: "Nonpartisan" }],
      },
      {
        id: "montgomery-common-pleas-2027-01-02",
        candidates: [
          { name: "Anne Keeton", party: "Nonpartisan" },
          { name: "Derek Muncy", party: "Nonpartisan" },
        ],
      },
      {
        id: "montgomery-common-pleas-2027-01-03",
        candidates: [
          { name: "Michele S.H. Henne", party: "Nonpartisan" },
          { name: "Kelly D. Madzey", party: "Nonpartisan" },
        ],
      },
      {
        id: "montgomery-common-pleas-2027-07-01",
        candidates: [
          { name: "Steve Abshire", party: "Nonpartisan" },
          { name: "Richard Glennon", party: "Nonpartisan" },
        ],
      },
      {
        id: "montgomery-common-pleas-2027-07-02",
        candidates: [{ name: "Elizabeth A. Ellis", party: "Nonpartisan" }],
      },
      {
        id: "montgomery-common-pleas-probate-2027-02-09",
        candidates: [
          { name: "David Brannon", party: "Nonpartisan" },
          { name: "Cassandra A. Rice", party: "Nonpartisan" },
        ],
      },
      {
        id: "montgomery-common-pleas-juvenile-unexpired-2028-12-31",
        candidates: [
          { name: "Hope L. Smalls", party: "Nonpartisan" },
          { name: "Nicholas Sylvain", party: "Nonpartisan" },
        ],
      },
    ],
  );

  assert.deepEqual(
    races.slice(2).map(({ id, scope }) => ({ id, scope })),
    [
      {
        id: "montgomery-common-pleas-2027-01-01",
        scope: "Montgomery County · Term beginning January 1, 2027 · Vote for one",
      },
      {
        id: "montgomery-common-pleas-2027-01-02",
        scope: "Montgomery County · Term beginning January 2, 2027 · Vote for one",
      },
      {
        id: "montgomery-common-pleas-2027-01-03",
        scope: "Montgomery County · Term beginning January 3, 2027 · Vote for one",
      },
      {
        id: "montgomery-common-pleas-2027-07-01",
        scope: "Montgomery County · Term beginning July 1, 2027 · Vote for one",
      },
      {
        id: "montgomery-common-pleas-2027-07-02",
        scope: "Montgomery County · Term beginning July 2, 2027 · Vote for one",
      },
      {
        id: "montgomery-common-pleas-probate-2027-02-09",
        scope: "Montgomery County · Term beginning February 9, 2027 · Vote for one",
      },
      {
        id: "montgomery-common-pleas-juvenile-unexpired-2028-12-31",
        scope: "Montgomery County · Unexpired term ending December 31, 2028 · Vote for one",
      },
    ],
  );
});

test("uses Summit County's current candidate list", () => {
  const races = racesForCounty("summit", election.counties);

  assert.deepEqual(
    races.map(({ id, candidates }) => ({
      id,
      candidates: candidates.map(({ name, party }) => ({ name, party })),
    })),
    [
      {
        id: "summit-council-at-large",
        candidates: [
          { name: "Shane R. Barker", party: "Republican" },
          { name: "Jonathon D. Bollas", party: "Republican" },
          { name: "John Chapman", party: "Republican" },
          { name: "Erin Dickinson", party: "Democratic" },
          { name: "John A. Donofrio", party: "Democratic" },
          { name: "Elizabeth Walters", party: "Democratic" },
        ],
      },
      {
        id: "summit-common-pleas-general-2027-01-02",
        candidates: [
          { name: "Tania Nemer", party: "Nonpartisan" },
          { name: "Tammy O’Brien", party: "Nonpartisan" },
        ],
      },
      {
        id: "summit-common-pleas-general-2027-01-05",
        candidates: [
          { name: "Alison McCarty", party: "Nonpartisan" },
          { name: "Job Esau Perry", party: "Nonpartisan" },
        ],
      },
    ],
  );
});

test("uses Franklin County's latest certified commissioner list", () => {
  const commissioner = racesForCounty("franklin", election.counties).find(
    ({ id }) => id === "franklin-commissioner",
  );

  assert.deepEqual(
    commissioner.candidates.map(({ name }) => name),
    ["Erica C. Crawley", "Eric Terford"],
  );
});

test("selects the nearest upcoming election and skips past elections", () => {
  const elections = [
    { id: "past", date: "2026-05-05" },
    { id: "next", date: "2026-11-03" },
    { id: "later", date: "2027-05-04" },
  ];

  assert.equal(selectNextElection(elections, "2026-10-14")?.id, "next");
  assert.deepEqual(
    upcomingElections(elections, "2026-11-04").map(({ id }) => id),
    ["later"],
  );
  assert.equal(selectNextElection(elections, "2027-05-05"), null);
});

test("published data continues with Ohio's 2027 election schedule", () => {
  assert.equal(
    selectNextElection(data.elections, "2026-11-04")?.id,
    "2027-05-04-primary-special",
  );
  assert.deepEqual(
    upcomingElections(data.elections, "2027-05-05").map(({ id }) => id),
    ["2027-08-03-special", "2027-11-02-general"],
  );
});

test("distinguishes populated ballots from schedule-only election dates", () => {
  assert.equal(hasPublishedBallotDetails(data.elections[0]), true);
  assert.equal(hasPublishedBallotDetails(data.elections[1]), false);
});

test("calculates the election countdown by Ohio calendar date", () => {
  assert.equal(daysUntilElection("2026-11-03", "2026-10-14"), 20);
  assert.equal(daysUntilElection("2026-11-03", "2026-11-03"), 0);
  assert.equal(daysUntilElection("2026-11-03", new Date("2026-10-15T03:30:00Z")), 20);
  assert.equal(daysUntilElection("2026-11-03", new Date("2026-10-15T04:30:00Z")), 19);
});

test("separates certified write-ins from candidates printed on the ballot", () => {
  const governor = data.elections
    .find(({ id }) => id === "2026-11-03-general")
    .statewide_races.find(({ office }) => office.startsWith("Governor"));

  const { onBallot, writeIn } = partitionCandidates(governor.candidates);

  assert.equal(onBallot.length + writeIn.length, governor.candidates.length);
  assert.deepEqual(
    onBallot.map(({ party }) => party),
    ["Democratic", "Libertarian", "Republican"],
  );
  assert.ok(writeIn.length > 0);
  assert.ok(writeIn.every(({ party }) => party === "Write-in"));
});

test("partitions candidate lists that have no write-ins", () => {
  const { onBallot, writeIn } = partitionCandidates([
    { name: "A", party: "Democratic" },
    { name: "B", party: "Republican" },
  ]);

  assert.equal(onBallot.length, 2);
  assert.deepEqual(writeIn, []);
});
