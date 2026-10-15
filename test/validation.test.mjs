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
async function validateFixture(t, { elections = () => {}, locations = () => {} }) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohio-ballot-guide-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const electionData = await readData("elections.json");
  const locationData = await readData("locations.json");
  elections(electionData);
  locations(locationData);

  const electionFixture = join(temporaryDirectory, "elections.json");
  const locationFixture = join(temporaryDirectory, "locations.json");
  await writeFile(electionFixture, JSON.stringify(electionData));
  await writeFile(locationFixture, JSON.stringify(locationData));

  return spawnSync(process.execPath, [validator, electionFixture, locationFixture], {
    encoding: "utf8",
  });
}

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
