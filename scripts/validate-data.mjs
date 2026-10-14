import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const data = JSON.parse(
  await readFile(new URL("../data/elections.json", import.meta.url), "utf8"),
);

assert.match(data.meta.election_date, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(data.locations.length > 0, "at least one pilot location is required");
assert.ok(data.statewide_races.length > 0, "at least one statewide race is required");

const allRaces = [
  ...data.statewide_races,
  ...Object.values(data.counties).flatMap((county) => county.races),
];
const ids = new Set();

for (const race of allRaces) {
  assert.ok(!ids.has(race.id), `duplicate race id: ${race.id}`);
  ids.add(race.id);
  assert.ok(race.office, `${race.id} needs an office`);
  assert.ok(race.candidates.length > 0, `${race.id} needs candidates`);
  assert.doesNotThrow(() => new URL(race.source_url), `${race.id} needs a valid source URL`);
  assert.match(race.last_verified, /^\d{4}-\d{2}-\d{2}$/);
}

for (const issue of data.issues) {
  assert.doesNotThrow(() => new URL(issue.source_url), `${issue.id} needs a valid source URL`);
}

console.log(`Validated ${allRaces.length} contests, ${data.issues.length} issue, and ${data.locations.length} pilot locations.`);
