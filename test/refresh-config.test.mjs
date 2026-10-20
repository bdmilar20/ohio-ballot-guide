import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRefreshConfigs, validateRefreshConfigs } from "../scripts/check-refresh-config.mjs";
import { readPatterns } from "../scripts/map-office-titles.mjs";

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
            statewide_issue_mappings: {},
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
    statewideIssueText: {
      meta: { election: { id: "2026-11-03-general" } },
      issues: { "state-issue-3": { counties: ["adams"] } },
    },
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
    statewideIssueText: await readJson(new URL("../data/statewide-issue-text.json", import.meta.url)),
    // Every input the CLI passes. Omitting the survey and the patterns is not a
    // laxer version of this check, it is a different one: derivableOfficeLabels
    // then sees no patterns, so every published office has to come from a hand
    // mapping, which is the shape the committed config deliberately no longer
    // has. This read as a real failure the first time the config was generated.
    contestSurvey: await readJson(new URL("../data/vtrapp-contest-survey.json", import.meta.url)),
    officeTitlePatterns: readPatterns(
      await readJson(new URL("../data/office-title-patterns.json", import.meta.url)),
    ),
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

test("requires each statewide issue removal to be reproducible", () => {
  const withoutEvidence = fixture();
  withoutEvidence.statewideIssueText.issues["state-issue-3"].counties = [];
  assert.throws(
    () => validateRefreshConfigs(withoutEvidence),
    /cannot reproduce removal of statewide issue state-issue-3/,
  );

  // A reviewed mapping remains the escape hatch when a county's ballot text
  // genuinely differs from the certified statewide body.
  withoutEvidence.configs[0].manifest.jobs[0].projection.statewide_issue_mappings = {
    "Issue 3": "state-issue-3",
  };
  assert.doesNotThrow(() => validateRefreshConfigs(withoutEvidence));
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

test("a county can be onboarded with no office table when the patterns cover what it prints", () => {
  // This is the whole point of the pattern set: the published office is still
  // required to be reproducible from the durable job, but a label derived from
  // a title the survey measured this county printing reproduces it as well as
  // a hand-written mapping does.
  const data = fixture();
  data.configs[0].manifest.jobs[0].projection.office_mappings = {};
  data.contestSurvey = {
    meta: { election: { id: "2026-11-03-general" } },
    local_office_titles: { "For County Commissioner": { county_count: 1, instances: 1, counties: ["adams"] } },
  };
  data.officeTitlePatterns = {
    patterns: [{ printed: "County Commissioner", office_id: "county-commissioner", office: "County Commissioner" }],
    corrections: [],
  };

  assert.deepEqual(validateRefreshConfigs(data), { configs: 1, jobs: 1, generated_counties: 1 });
});

test("a derived label only covers the election the survey measured", () => {
  // A primary and a general print different offices. Reading one election's
  // survey to authorize another's publication is the same mistake as reading
  // another county's: the measurement is of a different ballot.
  const data = fixture();
  data.configs[0].manifest.jobs[0].projection.office_mappings = {};
  data.contestSurvey = {
    meta: { election: { id: "2026-05-05-primary" } },
    local_office_titles: { "For County Commissioner": { county_count: 1, instances: 1, counties: ["adams"] } },
  };
  data.officeTitlePatterns = {
    patterns: [{ printed: "County Commissioner", office_id: "county-commissioner", office: "County Commissioner" }],
    corrections: [],
  };

  assert.throws(() => validateRefreshConfigs(data), /cannot reproduce that mapping/);
});

test("a derived label only covers the county the survey saw print the title", () => {
  const data = fixture();
  data.configs[0].manifest.jobs[0].projection.office_mappings = {};
  data.contestSurvey = {
    meta: { election: { id: "2026-11-03-general" } },
    local_office_titles: { "For County Commissioner": { county_count: 1, instances: 1, counties: ["brown"] } },
  };
  data.officeTitlePatterns = {
    patterns: [{ printed: "County Commissioner", office_id: "county-commissioner", office: "County Commissioner" }],
    corrections: [],
  };

  assert.throws(() => validateRefreshConfigs(data), /cannot reproduce that mapping/);
});

test("with no survey at all an empty office table still cannot reproduce a published office", () => {
  const data = fixture();
  data.configs[0].manifest.jobs[0].projection.office_mappings = {};

  assert.throws(() => validateRefreshConfigs(data), /cannot reproduce that mapping/);
});
