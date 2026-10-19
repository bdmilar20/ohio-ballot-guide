import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRefreshConfigs, validateRefreshConfigs } from "../scripts/check-refresh-config.mjs";

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function fixture() {
  return {
    configs: [{
      name: "vtrapp-20261103G.json",
      manifest: {
        schema_version: 1,
        jobs: [{
          county: "adams",
          election: "20261103G",
          projection: {
            max_source_age_hours: 168,
            county_name: "Adams",
            office_mappings: {
              "For County Commissioner": {
                office_id: "county-commissioner",
                office: "County Commissioner",
              },
            },
            statewide_race_mappings: { "For Governor": "governor" },
            statewide_issue_mappings: { "Issue 3": "state-issue-3" },
          },
        }],
      },
    }],
    electionData: {
      elections: [{
        id: "2026-11-03-general",
        statewide_races: [{ id: "governor" }],
        issues: [{ id: "state-issue-3" }],
        counties: {
          adams: {
            coverage: {
              method: "common_to_all_precincts",
              source_age_hours_at_review: 143,
            },
            races: [{ office_id: "county-commissioner", office: "County Commissioner" }],
            issues: [],
          },
        },
      }],
    },
    locations: { counties: { adams: { name: "Adams County" } } },
    offices: { offices: { "county-commissioner": {} } },
  };
}

test("accepts a durable job that can reproduce every published generated county", () => {
  assert.deepEqual(validateRefreshConfigs(fixture()), {
    configs: 1,
    jobs: 1,
    generated_counties: 1,
  });
});

test("tracked configs cover the published generated counties", async () => {
  const result = validateRefreshConfigs({
    configs: await loadRefreshConfigs(fileURLToPath(new URL("../config", import.meta.url))),
    electionData: await readJson(new URL("../data/elections.json", import.meta.url)),
    locations: await readJson(new URL("../data/locations.json", import.meta.url)),
    offices: await readJson(new URL("../data/offices.json", import.meta.url)),
  });
  assert.ok(result.generated_counties > 0, "the integration gate must exercise published generated coverage");
  assert.ok(result.jobs >= result.generated_counties);
});

test("rejects generated county coverage whose projection decisions were not committed", () => {
  const input = fixture();
  input.configs = [];
  assert.throws(
    () => validateRefreshConfigs(input),
    /2026-11-03-general:adams is generated ballot coverage but has no durable refresh job/,
  );
});

test("rejects config drift from the office mapping and source age that produced published data", async (t) => {
  await t.test("missing published office mapping", () => {
    const input = fixture();
    input.configs[0].manifest.jobs[0].projection.office_mappings = {
      "For County Commissioner": {
        office_id: "county-auditor",
        office: "County Auditor",
      },
    };
    input.offices.offices["county-auditor"] = {};
    assert.throws(() => validateRefreshConfigs(input), /durable job cannot reproduce that mapping/);
  });

  await t.test("published office label drift", () => {
    const input = fixture();
    input.configs[0].manifest.jobs[0].projection.office_mappings["For County Commissioner"].office =
      "County Commissioner (changed)";
    assert.throws(() => validateRefreshConfigs(input), /durable job cannot reproduce that mapping/);
  });

  await t.test("source-age limit below the published review", () => {
    const input = fixture();
    input.configs[0].manifest.jobs[0].projection.max_source_age_hours = 142;
    assert.throws(() => validateRefreshConfigs(input), /reviewed at age 143h, above its durable 142h limit/);
  });
});

test("rejects stale identities before a refresh can start", async (t) => {
  await t.test("unknown mapping target", () => {
    const input = fixture();
    input.configs[0].manifest.jobs[0].projection.statewide_race_mappings["For Governor"] = "old-governor";
    assert.throws(() => validateRefreshConfigs(input), /targets missing id "old-governor"/);
  });

  await t.test("wrong county display name", () => {
    const input = fixture();
    input.configs[0].manifest.jobs[0].projection.county_name = "Adams County";
    assert.throws(() => validateRefreshConfigs(input), /county_name must be "Adams"/);
  });

  await t.test("misnamed election config", () => {
    const input = fixture();
    input.configs[0].name = "vtrapp-current.json";
    assert.throws(() => validateRefreshConfigs(input), /must be named vtrapp-20261103G\.json/);
  });
});
