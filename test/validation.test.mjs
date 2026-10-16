import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(projectRoot, "scripts", "validate-data.mjs");

async function readData(name) {
  return JSON.parse(await readFile(join(projectRoot, "data", name), "utf8"));
}

// Writes both data files to a scratch directory so a test can corrupt either
// one and watch the validator refuse it.
async function validateFixture(
  t,
  { elections = () => {}, locations = () => {}, offices = () => {}, countyBoards = () => {} },
) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohio-ballot-guide-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const electionData = await readData("elections.json");
  const locationData = await readData("locations.json");
  const officeData = await readData("offices.json");
  const countyBoardData = await readData("county-boards.json");
  elections(electionData);
  locations(locationData);
  offices(officeData);
  countyBoards(countyBoardData);

  const electionFixture = join(temporaryDirectory, "elections.json");
  const locationFixture = join(temporaryDirectory, "locations.json");
  const officeFixture = join(temporaryDirectory, "offices.json");
  const countyBoardFixture = join(temporaryDirectory, "county-boards.json");
  await writeFile(electionFixture, JSON.stringify(electionData));
  await writeFile(locationFixture, JSON.stringify(locationData));
  await writeFile(officeFixture, JSON.stringify(officeData));
  await writeFile(countyBoardFixture, JSON.stringify(countyBoardData));

  return spawnSync(
    process.execPath,
    [validator, electionFixture, locationFixture, officeFixture, countyBoardFixture],
    { encoding: "utf8" },
  );
}

test("validator rejects a county board directory with a missing county", async (t) => {
  const result = await validateFixture(t, {
    countyBoards: (data) => delete data.counties.vinton,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /county board directory must cover the same counties/);
});

test("validator rejects a contest without a geographic scope", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => delete data.elections[0].statewide_races[0].scope,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor needs a scope/);
});

test("validator rejects an election that references an unknown county", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[0].counties["mariom"] = { races: [] };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /references unknown county mariom/);
});

test("validator rejects a hand-entered election deadline that disagrees with its rule", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[1].registration_deadline = "2027-04-04";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registration_deadline disagrees with Ohio law/);
});

test("validator cannot bypass an August rule by changing the month", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[2].id = "2027-09-03-special";
      data.elections[2].date = "2027-09-03";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /date disagrees with Ohio law/);
});

test("validator cannot bypass schedule checks with a non-August special", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const election = data.elections[2];
      election.id = "2027-05-04-special";
      election.date = "2027-05-04";
      election.registration_deadline = "2027-05-03";
      election.early_voting_end = "2027-05-01";
      delete election.schedule_rule;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schedule_rule is required for every election/);
});

test("validator accepts a documented one-off office closure", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[1].schedule_exceptions = { additional_closed_dates: ["2027-04-05"] };
      data.elections[1].registration_deadline = "2027-04-06";
    },
  });

  assert.equal(result.status, 0, result.stderr);
});

test("validator rejects a place name that would shadow a ZIP lookup", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.places["43215"] = { display_name: "43215", county_ids: ["franklin"], source: "geonames-us-postal" };
      data.meta.counts.places += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /place key 43215 would shadow a ZIP lookup/);
});

test("validator rejects a place key the query normalizer would never produce", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.places["Dublin, Ohio"] = { display_name: "Dublin", county_ids: ["franklin"], source: "geonames-us-postal" };
      data.meta.counts.places += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be query-normalized/);
});

test("validator rejects a ZIP pointing at a county that is not in the registry", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.zips["43215"].county_ids = ["fairborn"];
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /references unknown county fairborn/);
});

test("validator rejects a regeneration that lost a county", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      delete data.counties.vinton;
      data.meta.counts.counties -= 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 88 Ohio counties/);
});

test("validator rejects counts that disagree with the generated file", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.meta.counts.zips += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locations\.meta\.counts does not match/);
});

test("validator rejects a cross-county ZIP recorded as single-county", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.zips["43235"].order_basis = "single-county";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /order basis disagrees with its county count/);
});

test("validator rejects populated county data without coverage metadata", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      delete data.elections[0].counties.franklin.coverage;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /franklin needs coverage metadata/);
});

test("validator rejects a contest whose office has no description", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[0].statewide_races[0].office_id = "grand-vizier";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor references unknown office grand-vizier/);
});

test("validator rejects an office description with no official source", async (t) => {
  const result = await validateFixture(t, {
    offices: (data) => {
      data.offices.governor.sources = [];
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor needs at least one official source/);
});

test("validator rejects an office source that is not HTTPS", async (t) => {
  const result = await validateFixture(t, {
    offices: (data) => {
      data.offices.auditor.sources[0].url = "http://codes.ohio.gov/ohio-revised-code/section-117.11";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use HTTPS/);
});
