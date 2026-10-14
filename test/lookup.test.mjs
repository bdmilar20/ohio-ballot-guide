import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  daysUntilElection,
  isZipQuery,
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
  assert.equal(resolveLocation("44113", data.locations)?.id, "cleveland");
});

test("records known cross-county ZIPs without choosing a county", () => {
  const location = resolveLocation("43235", data.locations);
  assert.deepEqual(location?.county_ids, ["franklin", "delaware"]);
  assert.equal(isZipQuery("43235"), true);
  assert.equal(isZipQuery("Columbus"), false);
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

test("calculates the election countdown by Ohio calendar date", () => {
  assert.equal(daysUntilElection("2026-11-03", "2026-10-14"), 20);
  assert.equal(daysUntilElection("2026-11-03", "2026-11-03"), 0);
});
