import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRefreshJobs,
  GENERATED_BY,
  readDecisions,
  refreshConfigArtifact,
  unlabelledTitles,
} from "../scripts/build-refresh-config.mjs";
import { assertGeneratedRefreshConfig } from "../scripts/check-refresh-config.mjs";
import { readPatterns } from "../scripts/map-office-titles.mjs";

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, new URL("..", import.meta.url)), "utf8"));
}

// Two counties, so "one job per surveyed county, in county order" is a claim a
// fixture can actually fail. One of them prints a title no pattern covers.
function fixture() {
  return {
    survey: {
      meta: {
        schema_version: 2,
        election: { id: "2026-11-03-general", vendor_key: "20261103G" },
        failures: {},
      },
      local_office_titles: {
        "For County Commissioner": { counties: ["adams", "brown"], instances: 2 },
        "For Dogcatcher of the Hollow": { counties: ["brown"], instances: 1 },
      },
      counties: {
        brown: { local_office_titles: { "For County Commissioner": 1, "For Dogcatcher of the Hollow": 1 } },
        adams: { local_office_titles: { "For County Commissioner": 1 } },
      },
    },
    patterns: [{ printed: "County Commissioner", office_id: "county-commissioner", office: "County Commissioner" }],
    corrections: [],
    locations: { counties: { adams: { name: "Adams County" }, brown: { name: "Brown County" } } },
    decisions: {
      schema_version: 1,
      election: { id: "2026-11-03-general", vendor_key: "20261103G" },
      max_source_age_hours: 168,
      counties: {},
    },
    publishedCounties: {},
  };
}

test("generates one job per surveyed county, in county order, with no hand mappings", () => {
  const { jobs, vendorKey, electionId } = buildRefreshJobs(fixture());
  assert.equal(vendorKey, "20261103G");
  assert.equal(electionId, "2026-11-03-general");
  assert.deepEqual(jobs.map((job) => job.county), ["adams", "brown"]);
  assert.deepEqual(jobs[0], {
    county: "adams",
    election: "20261103G",
    projection: {
      max_source_age_hours: 168,
      county_name: "Adams",
      office_mappings: {},
      statewide_race_mappings: {},
      statewide_issue_mappings: {},
    },
  });
});

test("reports the surveyed titles no pattern labels, rather than leaving them to a passing build", () => {
  const input = fixture();
  assert.deepEqual(unlabelledTitles(input), [{ county: "brown", title: "For Dogcatcher of the Hollow" }]);
});

test("refuses a survey of the wrong schema, which would read an absent title index as empty", () => {
  const input = fixture();
  input.survey.meta.schema_version = 1;
  assert.throws(() => buildRefreshJobs(input), /must be schema 2 to generate a refresh config/);
});

test("refuses a survey with county failures, which measured part of the state", () => {
  const input = fixture();
  input.survey.meta.failures = { miami: "source changed during the walk" };
  assert.throws(() => buildRefreshJobs(input), /measured part of the state/);
});

// Measured, not assumed: deleting each of these three left the suite green
// until the test below existed, so each one could have been removed by a
// refactor without anything noticing.
test("refuses a survey whose vendor key and election id disagree", () => {
  const input = fixture();
  input.survey.meta.election.vendor_key = "20271102G";
  assert.throws(() => buildRefreshJobs(input), /does not name election 2026-11-03-general/);
});

test("refuses a survey that measured no counties, rather than emitting a config with no jobs", () => {
  const input = fixture();
  input.survey.counties = {};
  assert.throws(() => buildRefreshJobs(input), /measured no counties, so there is no config to generate/);
});

test("refuses decisions whose counties field is not an object", () => {
  const scope = { electionId: "2026-11-03-general", vendorKey: "20261103G" };
  for (const counties of [undefined, [], "none"]) {
    const decisions = { ...fixture().decisions, counties };
    assert.throws(() => readDecisions(decisions, scope), /need a counties object, even when it is empty/);
  }
});

test("refuses a surveyed county absent from locations data", () => {
  const input = fixture();
  delete input.locations.counties.brown;
  assert.throws(() => buildRefreshJobs(input), /brown, which is absent from locations data/);
});

test("refuses a decision about a county the survey never read", () => {
  const input = fixture();
  input.decisions.counties.miami = { office_mappings: {} };
  assert.throws(() => buildRefreshJobs(input), /name miami, which the contest survey did not measure/);
});

// The decision that is dangerous is not the wrong one, it is the redundant one:
// it keeps publishing its own office name after the pattern that should own the
// title changes, and nothing reports the divergence.
test("refuses a hand mapping the curated patterns already derive", () => {
  const input = fixture();
  input.decisions.counties.adams = {
    office_mappings: { "For County Commissioner": { office_id: "county-auditor", office: "County Auditor" } },
  };
  assert.throws(
    () => buildRefreshJobs(input),
    /curated patterns already derive "County Commissioner"; drop the decision/,
  );
});

test("keeps a hand mapping for a title no pattern derives", () => {
  const input = fixture();
  const mapping = { "For Dogcatcher of the Hollow": { office_id: "dogcatcher", office: "Dogcatcher of the Hollow" } };
  input.decisions.counties.brown = { office_mappings: mapping };
  const { jobs } = buildRefreshJobs(input);
  assert.deepEqual(jobs.find((job) => job.county === "brown").projection.office_mappings, mapping);
  assert.deepEqual(jobs.find((job) => job.county === "adams").projection.office_mappings, {});
});

// Silently raising the limit to fit is the failure mode: it republishes from a
// source staler than anybody reviewed, and the build stays green.
test("refuses to generate a limit below a published county's reviewed source age", () => {
  const input = fixture();
  input.publishedCounties = {
    adams: { coverage: { method: "common_to_all_precincts", source_age_hours_at_review: 200 } },
  };
  assert.throws(() => buildRefreshJobs(input), /reviewed at 200h, above the 168h limit/);
});

test("ignores the reviewed age of a county whose coverage was not generated", () => {
  const input = fixture();
  input.publishedCounties = {
    adams: { coverage: { method: "hand_reviewed", source_age_hours_at_review: 200 } },
  };
  assert.doesNotThrow(() => buildRefreshJobs(input));
});

test("refuses decisions for another election, whose mappings describe another ballot", () => {
  const decisions = fixture().decisions;
  assert.throws(
    () => readDecisions(decisions, { electionId: "2027-11-02-general", vendorKey: "20271102G" }),
    /not the 2027-11-02-general \/ 20271102G being generated/,
  );
});

test("refuses decisions of an unknown schema, or without the staleness limit it owns", () => {
  const scope = { electionId: "2026-11-03-general", vendorKey: "20261103G" };
  const wrongSchema = { ...fixture().decisions, schema_version: 2 };
  assert.throws(() => readDecisions(wrongSchema, scope), /must be schema 1, not 2/);
  const noLimit = { ...fixture().decisions };
  delete noLimit.max_source_age_hours;
  assert.throws(() => readDecisions(noLimit, scope), /nonnegative max_source_age_hours/);
});

test("refuses a decision field it does not understand, instead of dropping it", () => {
  const decisions = fixture().decisions;
  decisions.counties.adams = { office_mapings: {} };
  assert.throws(
    () => readDecisions(decisions, { electionId: "2026-11-03-general", vendorKey: "20261103G" }),
    /unknown field "office_mapings"/,
  );
});

function generated(input) {
  const built = buildRefreshJobs(input);
  return refreshConfigArtifact({ ...built, generatedOn: "2026-10-20" });
}

test("accepts the config its own inputs generate", () => {
  const input = fixture();
  assert.doesNotThrow(() => assertGeneratedRefreshConfig({
    name: "vtrapp-20261103G.json",
    config: generated(input),
    ...input,
  }));
});

test("refuses a config that does not name the generator", () => {
  const input = fixture();
  const config = generated(input);
  delete config.meta.generated_by;
  assert.throws(
    () => assertGeneratedRefreshConfig({ name: "vtrapp-20261103G.json", config, ...input }),
    new RegExp(`must name ${GENERATED_BY.replace(/[/.]/g, "\\$&")} in meta.generated_by`),
  );
});

test("refuses a config without a generated_on date", () => {
  const input = fixture();
  const config = generated(input);
  config.meta.generated_on = "October 2026";
  assert.throws(
    () => assertGeneratedRefreshConfig({ name: "vtrapp-20261103G.json", config, ...input }),
    /needs meta.generated_on as YYYY-MM-DD/,
  );
});

// The edit worth catching is the one that stays valid. A raised staleness limit
// and an injected office mapping both pass every other check in this file's
// sibling; only recomputation sees them.
test("refuses a hand edit to a job that leaves the config otherwise valid", () => {
  for (const edit of [
    (config) => { config.jobs[0].projection.max_source_age_hours = 4000; },
    (config) => { config.jobs[0].projection.office_mappings = { "For County Auditor": { office_id: "x", office: "X" } }; },
    (config) => { config.jobs[0].projection.county_name = "Adams County"; },
    (config) => { config.jobs.pop(); },
    (config) => { config.jobs.reverse(); },
  ]) {
    const input = fixture();
    const config = generated(input);
    edit(config);
    assert.throws(
      () => assertGeneratedRefreshConfig({ name: "vtrapp-20261103G.json", config, ...input }),
      /is not what its inputs generate/,
    );
  }
});

test("refuses a config whose recorded election is not the one its inputs generate", () => {
  const input = fixture();
  const config = generated(input);
  config.meta.election = { id: "2027-11-02-general", vendor_key: "20271102G" };
  assert.throws(
    () => assertGeneratedRefreshConfig({ name: "vtrapp-20261103G.json", config, ...input }),
    /but its inputs generate 2026-11-03-general \/ 20261103G/,
  );
});

// Against the real committed artifacts, not a fixture. A fixture cannot say
// whether the file in config/ is still the generator's output, and that is the
// only thing a refresh actually reads.
test("the committed config is exactly what the committed artifacts generate", async () => {
  const survey = await readJson("data/vtrapp-contest-survey.json");
  const { patterns, corrections } = readPatterns(await readJson("data/office-title-patterns.json"));
  const locations = await readJson("data/locations.json");
  const elections = await readJson("data/elections.json");
  const vendorKey = survey.meta.election.vendor_key;
  const decisions = readDecisions(await readJson(`config/decisions-${vendorKey}.json`), {
    electionId: survey.meta.election.id,
    vendorKey,
  });
  const config = await readJson(`config/vtrapp-${vendorKey}.json`);
  const published = elections.elections.find((e) => e.id === survey.meta.election.id)?.counties ?? {};

  assertGeneratedRefreshConfig({
    name: `vtrapp-${vendorKey}.json`,
    config,
    survey,
    patterns,
    corrections,
    locations,
    decisions,
    publishedCounties: published,
  });
  assert.equal(config.jobs.length, Object.keys(survey.counties).length);
  assert.deepEqual(unlabelledTitles({ survey, patterns, corrections, locations }), []);
});
