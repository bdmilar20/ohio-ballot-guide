import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  daysUntilElection,
  hasPublishedBallotDetails,
  normalizeQuery,
  partitionCandidates,
  racesForCounty,
  resolveLocation,
  selectNextElection,
  upcomingElections,
} from "../src/lookup.mjs";

const data = JSON.parse(
  await readFile(new URL("../data/elections.json", import.meta.url), "utf8"),
);
const locations = JSON.parse(
  await readFile(new URL("../data/locations.json", import.meta.url), "utf8"),
);
const election = data.elections[0];

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

test("publishes sourced, explicitly partial coverage for each pilot county", () => {
  for (const countyId of ["franklin", "cuyahoga", "hamilton"]) {
    const county = election.counties[countyId];
    assert.equal(county.coverage.status, "partial");
    assert.match(county.coverage.source_url, /^https:\/\//);
    assert.equal(county.races.length, 2);
  }
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
