import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  daysUntilElection,
  hasPublishedBallotDetails,
  normalizeQuery,
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
  const cincinnatiZip = resolveLocation("45220", data.locations);
  assert.deepEqual(crossCounty?.county_ids, ["franklin", "delaware"]);
  assert.deepEqual(singleCounty?.county_ids, ["cuyahoga"]);
  assert.deepEqual(columbusZip?.county_ids, ["franklin"]);
  assert.deepEqual(cincinnatiZip?.county_ids, ["clermont", "hamilton"]);
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
