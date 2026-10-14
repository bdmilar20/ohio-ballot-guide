import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeQuery } from "../src/lookup.mjs";

const dataSource = process.argv[2] ?? new URL("../data/elections.json", import.meta.url);
const data = JSON.parse(await readFile(dataSource, "utf8"));
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const electionTypes = new Set(["general", "primary", "special", "local"]);
const electionScopes = new Set(["statewide", "county", "municipal"]);

function assertDate(value, label) {
  assert.match(value, datePattern, `${label} must use YYYY-MM-DD`);
  assert.equal(
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10),
    value,
    `${label} must be a real calendar date`,
  );
}

function assertHttpsUrl(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS`);
}

assertDate(data.meta.last_reviewed, "meta.last_reviewed");
assert.ok(Object.keys(data.counties).length > 0, "at least one county is required");
assert.ok(data.locations.length > 0, "at least one pilot location is required");
assert.ok(data.elections.length > 0, "at least one election is required");

for (const [countyId, county] of Object.entries(data.counties)) {
  assert.ok(county.name, `${countyId} needs a name`);
}

const electionIds = new Set();
let raceCount = 0;
let issueCount = 0;

for (const election of data.elections) {
  assert.ok(election.id, "each election needs an id");
  assert.ok(!electionIds.has(election.id), `duplicate election id: ${election.id}`);
  electionIds.add(election.id);
  assert.ok(election.name, `${election.id} needs a name`);
  assertDate(election.date, `${election.id}.date`);
  assert.ok(electionTypes.has(election.type), `${election.id} has an invalid type`);
  assert.ok(electionScopes.has(election.scope), `${election.id} has an invalid scope`);
  assert.ok(election.jurisdiction_ids.length > 0, `${election.id} needs a jurisdiction`);
  assertHttpsUrl(election.official_info_url, `${election.id}.official_info_url`);
  assertDate(election.registration_deadline, `${election.id}.registration_deadline`);
  assertDate(election.early_voting_end, `${election.id}.early_voting_end`);
  assert.ok(election.polls.open && election.polls.close, `${election.id} needs poll hours`);
  assert.ok(Array.isArray(election.statewide_races), `${election.id}.statewide_races must be an array`);
  assert.ok(Array.isArray(election.issues), `${election.id}.issues must be an array`);

  const raceIds = new Set();
  const allRaces = [
    ...election.statewide_races,
    ...Object.values(election.counties).flatMap((county) => county.races),
  ];

  for (const race of allRaces) {
    assert.ok(!raceIds.has(race.id), `duplicate race id in ${election.id}: ${race.id}`);
    raceIds.add(race.id);
    assert.ok(race.scope, `${race.id} needs a scope`);
    assert.ok(race.office, `${race.id} needs an office`);
    assert.ok(race.candidates.length > 0, `${race.id} needs candidates`);
    for (const candidate of race.candidates) {
      assert.ok(candidate.name && candidate.party, `${race.id} has an incomplete candidate`);
    }
    assertHttpsUrl(race.source_url, `${race.id}.source_url`);
    for (const source of race.supplemental_sources ?? []) {
      assert.ok(source.label, `${race.id} has an unlabeled supplemental source`);
      assertHttpsUrl(source.url, `${race.id}.${source.label}`);
    }
    assertDate(race.last_verified, `${race.id}.last_verified`);
  }

  for (const issue of election.issues) {
    assert.ok(issue.id, `${election.id} has an issue without an id`);
    assert.ok(issue.label && issue.title && issue.summary, `${issue.id} needs display copy`);
    assertHttpsUrl(issue.source_url, `${issue.id}.source_url`);
    assertDate(issue.last_verified, `${issue.id}.last_verified`);
  }

  for (const [countyId, county] of Object.entries(election.counties)) {
    assert.ok(data.counties[countyId], `${election.id} references unknown county ${countyId}`);
    assert.ok(Array.isArray(county.races), `${countyId}.races must be an array`);
  }

  raceCount += allRaces.length;
  issueCount += election.issues.length;
}

const aliases = new Map();
for (const location of data.locations) {
  assert.ok(location.id && location.display_name, "each location needs an id and display name");
  assert.ok(location.county_ids.length > 0, `${location.id} needs at least one county`);
  for (const countyId of location.county_ids) {
    assert.ok(data.counties[countyId], `${location.id} references unknown county ${countyId}`);
  }
  for (const alias of location.aliases) {
    const normalized = normalizeQuery(alias);
    const existingLocationId = aliases.get(normalized);
    assert.ok(
      !existingLocationId || existingLocationId === location.id,
      `location alias ${alias} collides with ${existingLocationId}`,
    );
    aliases.set(normalized, location.id);
  }
}

console.log(
  `Validated ${data.elections.length} election, ${raceCount} contests, ${issueCount} issue, and ${data.locations.length} pilot locations.`,
);
