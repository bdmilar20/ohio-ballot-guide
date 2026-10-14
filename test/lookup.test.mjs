import test from "node:test";
import assert from "node:assert/strict";

import { normalizeQuery, racesForLocation, resolveLocation } from "../src/lookup.mjs";

const locations = [
  {
    display_name: "Cleveland",
    county_id: "cuyahoga",
    county_name: "Cuyahoga County",
    aliases: ["Cleveland", "Cleveland, Ohio", "44113"],
  },
];

test("normalizes Ohio city suffixes", () => {
  assert.equal(normalizeQuery("  Cleveland, Ohio "), "cleveland");
  assert.equal(normalizeQuery("Cleveland OH"), "cleveland");
});

test("resolves pilot cities and ZIP codes", () => {
  assert.equal(resolveLocation("CLEVELAND", locations)?.county_id, "cuyahoga");
  assert.equal(resolveLocation("44113", locations)?.county_name, "Cuyahoga County");
});

test("returns statewide-only behavior for unknown places", () => {
  assert.equal(resolveLocation("Toledo", locations), null);
  assert.deepEqual(racesForLocation(null, {}), []);
});

test("returns races for a resolved county", () => {
  const counties = { cuyahoga: { races: [{ id: "county-executive" }] } };
  assert.deepEqual(racesForLocation(locations[0], counties), [{ id: "county-executive" }]);
});
