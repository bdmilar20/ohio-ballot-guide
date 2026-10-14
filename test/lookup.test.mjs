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
const election = data.elections[0];

test("normalizes Ohio city suffixes with or without comma spacing", () => {
  assert.equal(normalizeQuery("  Cleveland, Ohio "), "cleveland");
  assert.equal(normalizeQuery("Cleveland,OH"), "cleveland");
  assert.equal(normalizeQuery("Columbus OH"), "columbus");
});

test("resolves city and ZIP aliases", () => {
  assert.equal(resolveLocation("Cincinnati", data.locations)?.id, "cincinnati");
  assert.equal(resolveLocation("44113", data.locations)?.id, "zip-cleveland-cuyahoga");
  assert.equal(resolveLocation("44113", data.locations)?.display_name, "44113");
});

test("records county choices for single- and cross-county ZIPs", () => {
  const crossCounty = resolveLocation("43235", data.locations);
  const singleCounty = resolveLocation("44113", data.locations);
  const columbusZip = resolveLocation("43215", data.locations);
  assert.deepEqual(crossCounty?.county_ids, ["franklin", "delaware"]);
  assert.deepEqual(singleCounty?.county_ids, ["cuyahoga"]);
  assert.deepEqual(columbusZip?.county_ids, ["franklin"]);
  assert.deepEqual(resolveLocation("45212", data.locations)?.county_ids, ["hamilton"]);
  assert.deepEqual(resolveLocation("45220", data.locations)?.county_ids, ["hamilton"]);
  assert.deepEqual(resolveLocation("45240", data.locations)?.county_ids, ["hamilton"]);
  assert.deepEqual(resolveLocation("45249", data.locations)?.county_ids, ["hamilton", "warren"]);
  assert.deepEqual(resolveLocation("45251", data.locations)?.county_ids, ["hamilton"]);
});

test("offers the county holding most of a cross-county ZIP first", () => {
  const crossCounty = ["43235", "45246", "45249", "45255"];
  const majorityCounty = { 43235: "franklin", 45246: "hamilton", 45249: "hamilton", 45255: "hamilton" };

  for (const zip of crossCounty) {
    const countyIds = resolveLocation(zip, data.locations)?.county_ids ?? [];
    assert.ok(countyIds.length > 1, `${zip} should still cross county lines`);
    assert.equal(countyIds[0], majorityCounty[zip], `${zip} must offer its majority county first`);
  }
});

test("returns county races only after a county is selected", () => {
  assert.equal(racesForCounty("franklin", election.counties).length, 1);
  assert.deepEqual(racesForCounty("delaware", election.counties), []);
  assert.deepEqual(racesForCounty("unknown", election.counties), []);
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
