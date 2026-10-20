import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDecisionClassesAccountedFor,
  buildRefreshJobs,
  DECISION_FIELD_BY_CLASS,
  electionCycleStart,
  GENERATED_BY,
  maxSourceAgeHoursFor,
  outstandingDecisions,
  readDecisions,
  refreshConfigArtifact,
} from "../scripts/build-refresh-config.mjs";
import { assertGeneratedRefreshConfig } from "../scripts/check-refresh-config.mjs";
import { readPatterns } from "../scripts/map-office-titles.mjs";
import { CONTEST_CLASSES } from "../scripts/survey-contests.mjs";

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, new URL("..", import.meta.url)), "utf8"));
}

// Two counties, so "one job per surveyed county, in county order" is a claim a
// fixture can actually fail. Both are clean; each way a county can owe a
// decision is added by the test that measures it, because the generator's
// answer differs per class and a fixture that owed everything could not show
// which refusal fired.
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
      },
      counties: {
        brown: {
          source_updated_at: "2026-09-15T09:00:00-04:00",
          classes: { statewide_race_resolved: 3, local_office: 1 },
          local_office_titles: { "For County Commissioner": 1 },
        },
        adams: {
          source_updated_at: "2026-10-01T09:00:00-04:00",
          classes: { statewide_race_resolved: 3, local_office: 1 },
          local_office_titles: { "For County Commissioner": 1 },
        },
      },
    },
    patterns: [{ printed: "County Commissioner", office_id: "county-commissioner", office: "County Commissioner" }],
    corrections: [],
    locations: { counties: { adams: { name: "Adams County" }, brown: { name: "Brown County" } } },
    decisions: {
      schema_version: 1,
      election: { id: "2026-11-03-general", vendor_key: "20261103G" },
      counties: {},
    },
    election: { id: "2026-11-03-general", date: "2026-11-03", schedule_rule: "ohio-general" },
    publishedCounties: {},
  };
}

/** Adds the unlabelled office title the fixture deliberately leaves out. */
function printsUnlabelledTitle(input, county = "brown") {
  const index = input.survey.local_office_titles["For Dogcatcher of the Hollow"] ??= { counties: [], instances: 0 };
  index.counties.push(county);
  index.instances += 1;
  input.survey.counties[county].classes.local_office += 1;
  input.survey.counties[county].local_office_titles["For Dogcatcher of the Hollow"] = 1;
  return input;
}

test("generates one job per surveyed county, in county order, with no hand mappings", () => {
  const { jobs, vendorKey, electionId, backlog } = buildRefreshJobs(fixture());
  assert.equal(vendorKey, "20261103G");
  assert.equal(electionId, "2026-11-03-general");
  assert.deepEqual(backlog, []);
  assert.deepEqual(jobs.map((job) => job.county), ["adams", "brown"]);
  assert.deepEqual(jobs[0], {
    county: "adams",
    election: "20261103G",
    projection: {
      max_source_age_hours: 4368,
      county_name: "Adams",
      office_mappings: {},
      statewide_race_mappings: {},
      statewide_issue_mappings: {},
    },
  });
});

// The backstop this replaced was a typed 168 hours, inherited from a config
// that only had to admit one county on the day somebody wrote it. Across the
// surveyed seventy it admitted one. docs/BALLOT_INGESTION.md settles what the
// field is for: not the freshness decision, which two unchanged sightings
// make, but a backstop against a snapshot of a different ballot.
test("dates the staleness backstop from the election's own cycle", () => {
  assert.equal(electionCycleStart({ id: "2026-11-03-general", date: "2026-11-03", schedule_rule: "ohio-general" }), "2026-05-05");
  assert.equal(maxSourceAgeHoursFor({ id: "2026-11-03-general", date: "2026-11-03", schedule_rule: "ohio-general" }), 4368);
  // A primary's cycle begins at the previous general, not its own year's.
  assert.equal(electionCycleStart({ id: "2026-05-05-primary", date: "2026-05-05", schedule_rule: "ohio-primary" }), "2025-11-04");
  assert.equal(electionCycleStart({ id: "2026-08-04-special", date: "2026-08-04", schedule_rule: "ohio-august-special" }), "2026-05-05");
});

test("refuses a schedule rule it cannot date a cycle from, rather than guessing a backstop", () => {
  const input = fixture();
  input.election = { id: "2026-11-03-general", date: "2026-11-03", schedule_rule: "ohio-december-special" };
  assert.throws(() => buildRefreshJobs(input), /cannot date a cycle from; add it to CYCLE_START_RULE/);
});

test("refuses an election record that is not the one the survey measured", () => {
  const input = fixture();
  input.election = { id: "2027-11-02-general", date: "2027-11-02", schedule_rule: "ohio-general" };
  assert.throws(() => buildRefreshJobs(input), /the election record is "2027-11-02-general", not the 2026-11-03-general/);
});

// The check the typed limit never had: measured against the population the
// config claims to run, naming the counties it would not admit.
test("refuses a surveyed source stamp from before this election's cycle", () => {
  const input = fixture();
  input.survey.counties.brown.source_updated_at = "2026-04-20T09:00:00-04:00";
  assert.throws(
    () => buildRefreshJobs(input),
    /1 surveyed county source stamp\(s\) predate this election's cycle, which began 2026-05-05: brown at 2026-04-20/,
  );
});

test("admits a stamp from the whole span of this election's cycle", () => {
  const input = fixture();
  input.survey.counties.brown.source_updated_at = "2026-05-06T09:00:00-04:00";
  assert.deepEqual(buildRefreshJobs(input).jobs.map((job) => job.county), ["adams", "brown"]);
});

test("refuses decisions that type a staleness limit the election already dates", () => {
  const decisions = { ...fixture().decisions, max_source_age_hours: 168 };
  assert.throws(
    () => readDecisions(decisions, { electionId: "2026-11-03-general", vendorKey: "20261103G" }),
    /must not set max_source_age_hours: the backstop is generated/,
  );
});

test("refuses a top-level decisions field it does not understand, instead of dropping it", () => {
  const decisions = { ...fixture().decisions, max_age_hours: 4368 };
  assert.throws(
    () => readDecisions(decisions, { electionId: "2026-11-03-general", vendorKey: "20261103G" }),
    /unknown field "max_age_hours"/,
  );
});

test("leaves out a county whose office title no pattern labels, and names it", () => {
  const input = printsUnlabelledTitle(fixture());
  const { jobs, backlog } = buildRefreshJobs(input);
  assert.deepEqual(jobs.map((job) => job.county), ["adams"]);
  assert.deepEqual(backlog, [{
    county: "brown",
    reason: 'office title "For Dogcatcher of the Hollow" has no pattern label and no reviewed mapping',
  }]);
});

// The class the office-title count could not see, and the reason the backlog
// is driven off CONTEST_CLASSES instead. Harrison surveys one of these, its
// generated job carried no mapping for it, and because refreshElections has no
// per-job recovery that one contest aborts the whole statewide run.
test("leaves out a county owing a statewide race mapping, which no office title reports", () => {
  const input = fixture();
  input.survey.counties.brown.classes.statewide_race_needs_mapping = 1;
  const { jobs, backlog } = buildRefreshJobs(input);
  assert.deepEqual(jobs.map((job) => job.county), ["adams"]);
  assert.deepEqual(backlog, [{
    county: "brown",
    reason: "1 surveyed contest(s) need a reviewed statewide_race_mappings entry; the decisions file has 0",
  }]);
});

test("leaves out a county owing a statewide issue mapping, or a statewide race decision", () => {
  for (const [name, field] of [
    ["statewide_issue_needs_mapping", "statewide_issue_mappings"],
    ["statewide_race_needs_decision", "statewide_race_mappings"],
  ]) {
    const input = fixture();
    input.survey.counties.brown.classes[name] = 2;
    const { jobs, backlog } = buildRefreshJobs(input);
    assert.deepEqual(jobs.map((job) => job.county), ["adams"]);
    assert.deepEqual(backlog, [{
      county: "brown",
      reason: `2 surveyed contest(s) need a reviewed ${field} entry; the decisions file has 0`,
    }]);
  }
});

test("counts both statewide race classes against the one field that pays for them", () => {
  const input = fixture();
  input.survey.counties.brown.classes.statewide_race_needs_mapping = 1;
  input.survey.counties.brown.classes.statewide_race_needs_decision = 1;
  input.decisions.counties.brown = { statewide_race_mappings: { "one fingerprint": "governor" } };
  assert.deepEqual(buildRefreshJobs(input).backlog, [{
    county: "brown",
    reason: "2 surveyed contest(s) need a reviewed statewide_race_mappings entry; the decisions file has 1",
  }]);
});

test("restores the job once the reviewed statewide race mapping is recorded", () => {
  const input = fixture();
  input.survey.counties.brown.classes.statewide_race_needs_mapping = 1;
  input.decisions.counties.brown = { statewide_race_mappings: { "a contest fingerprint": "governor" } };
  const { jobs, backlog } = buildRefreshJobs(input);
  assert.deepEqual(backlog, []);
  assert.deepEqual(jobs.map((job) => job.county), ["adams", "brown"]);
  assert.deepEqual(jobs[1].projection.statewide_race_mappings, { "a contest fingerprint": "governor" });
});

// A survey class that costs a decision and that nothing here accounts for is
// the exact hole this PR's review found: zero backlog reported for a county
// whose job could not project. It has to be a failing build, not a default.
test("refuses a survey class that costs a decision no field is declared to pay", () => {
  assert.throws(
    () => assertDecisionClassesAccountedFor({
      ...CONTEST_CLASSES,
      local_judicial_retention: { needs_hand_entry: true },
    }),
    /"local_judicial_retention" costs a hand decision, but this generator does not know which decision field/,
  );
});

test("accounts for every class the committed survey code can reach", () => {
  assert.doesNotThrow(() => assertDecisionClassesAccountedFor());
  for (const [name, { needs_hand_entry: needsHandEntry }] of Object.entries(CONTEST_CLASSES)) {
    if (!needsHandEntry) continue;
    assert.ok(name in DECISION_FIELD_BY_CLASS, `${name} needs a declared decision field`);
  }
});

test("refuses a survey verdict that is not a known contest class", () => {
  const input = fixture();
  input.survey.counties.brown.classes.statewide_race_probably_fine = 1;
  assert.throws(() => buildRefreshJobs(input), /"statewide_race_probably_fine", which is not a known contest class/);
});

test("refuses a config with no jobs when every surveyed county owes a decision", () => {
  const input = printsUnlabelledTitle(printsUnlabelledTitle(fixture(), "adams"), "brown");
  assert.throws(() => buildRefreshJobs(input), /every one of the 2 surveyed counties owes a decision/);
});

// Leaving a county out is the right answer for a county nothing publishes yet.
// For one already in published data it is the wrong one: its record would have
// no job to reproduce it, which is what check-refresh-config exists to refuse.
test("refuses to leave out a county whose generated coverage is already published", () => {
  const input = printsUnlabelledTitle(fixture());
  input.publishedCounties = {
    brown: { coverage: { method: "common_to_all_precincts", source_age_hours_at_review: 143 } },
  };
  assert.throws(
    () => buildRefreshJobs(input),
    /brown publishes generated coverage but still owes a decision/,
  );
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

// Checked for every surveyed county, not only the ones that get a job: a
// county left out for owing a decision would otherwise carry its redundant
// copy until the decision it waits on is recorded.
test("refuses a redundant hand mapping inside a county left out of the config", () => {
  const input = printsUnlabelledTitle(fixture());
  input.decisions.counties.brown = {
    office_mappings: { "For County Commissioner": { office_id: "county-auditor", office: "County Auditor" } },
  };
  assert.throws(
    () => buildRefreshJobs(input),
    /curated patterns already derive "County Commissioner"; drop the decision/,
  );
});

test("keeps a hand mapping for a title no pattern derives, and that mapping pays for the title", () => {
  const input = printsUnlabelledTitle(fixture());
  const mapping = { "For Dogcatcher of the Hollow": { office_id: "dogcatcher", office: "Dogcatcher of the Hollow" } };
  input.decisions.counties.brown = { office_mappings: mapping };
  const { jobs, backlog } = buildRefreshJobs(input);
  assert.deepEqual(backlog, []);
  assert.deepEqual(jobs.find((job) => job.county === "brown").projection.office_mappings, mapping);
  assert.deepEqual(jobs.find((job) => job.county === "adams").projection.office_mappings, {});
});

// Silently raising the limit to fit is the failure mode: it republishes from a
// source staler than anybody reviewed, and the build stays green.
test("refuses to generate a backstop below a published county's reviewed source age", () => {
  const input = fixture();
  input.publishedCounties = {
    adams: { coverage: { method: "common_to_all_precincts", source_age_hours_at_review: 5000 } },
  };
  assert.throws(() => buildRefreshJobs(input), /reviewed at 5000h, above the generated 4368h backstop/);
});

test("ignores the reviewed age of a county whose coverage was not generated", () => {
  const input = fixture();
  input.publishedCounties = {
    adams: { coverage: { method: "hand_reviewed", source_age_hours_at_review: 5000 } },
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

test("refuses decisions of an unknown schema", () => {
  const scope = { electionId: "2026-11-03-general", vendorKey: "20261103G" };
  const wrongSchema = { ...fixture().decisions, schema_version: 2 };
  assert.throws(() => readDecisions(wrongSchema, scope), /must be schema 1, not 2/);
});

test("refuses a per-county decision field it does not understand, instead of dropping it", () => {
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

test("the generated-config gate refuses a missing or invalid surveyed source stamp", () => {
  for (const sourceUpdatedAt of [undefined, "not-a-date"]) {
    const input = fixture();
    const config = generated(input);
    if (sourceUpdatedAt === undefined) delete input.survey.counties.adams.source_updated_at;
    else input.survey.counties.adams.source_updated_at = sourceUpdatedAt;
    assert.throws(
      () => assertGeneratedRefreshConfig({ name: "vtrapp-20261103G.json", config, ...input }),
      /surveyed county adams needs a valid source_updated_at timestamp/,
    );
  }
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

// The edit worth catching is the one that stays valid. A raised staleness
// limit, an injected office mapping, and a restored job for a county that owes
// a decision all pass every other check in this file's sibling; only
// recomputation sees them.
test("refuses a hand edit to a job that leaves the config otherwise valid", () => {
  for (const edit of [
    (config) => { config.jobs[0].projection.max_source_age_hours = 8000; },
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

test("refuses a restored job for a county the generator leaves out", () => {
  const clean = fixture();
  const config = generated(clean);
  const input = printsUnlabelledTitle(fixture());
  assert.throws(
    () => assertGeneratedRefreshConfig({ name: "vtrapp-20261103G.json", config, ...input }),
    /is not what its inputs generate \(2 job\(s\) committed, 1 generated\)/,
  );
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
  const election = elections.elections.find((candidate) => candidate.id === survey.meta.election.id);

  assertGeneratedRefreshConfig({
    name: `vtrapp-${vendorKey}.json`,
    config,
    survey,
    patterns,
    corrections,
    locations,
    decisions,
    election,
    publishedCounties: election.counties ?? {},
  });

  // The committed backlog, named rather than counted: Harrison surveys one
  // statewide race no candidate match resolves, so it is the one county of
  // seventy this config leaves out, and every other one gets a job.
  const built = buildRefreshJobs({
    survey,
    patterns,
    corrections,
    locations,
    decisions,
    election,
    publishedCounties: election.counties ?? {},
  });
  assert.deepEqual(built.backlog, [{
    county: "harrison",
    reason: "1 surveyed contest(s) need a reviewed statewide_race_mappings entry; the decisions file has 0",
  }]);
  assert.equal(built.jobs.length, Object.keys(survey.counties).length - 1);
  assert.deepEqual(config.jobs.map((job) => job.county).filter((county) => county === "harrison"), []);
  assert.equal(built.cycleStart, "2026-05-05");
  assert.equal(built.maxSourceAgeHours, 4368);
  assert.ok(
    built.jobs.every((job) => job.projection.max_source_age_hours === 4368),
    "every generated job carries the generated backstop",
  );
});

// The committed survey, held to the backstop it generates under. This is the
// claim the 168-hour limit failed: it admitted one county of seventy, so an
// overnight statewide run would have stopped on its first job.
test("the generated backstop admits every county the committed survey measured", async () => {
  const survey = await readJson("data/vtrapp-contest-survey.json");
  const elections = await readJson("data/elections.json");
  const election = elections.elections.find((candidate) => candidate.id === survey.meta.election.id);
  const cycleStart = Date.parse(`${electionCycleStart(election)}T00:00:00Z`);
  const electionDay = Date.parse(`${election.date}T00:00:00Z`);
  const limit = maxSourceAgeHoursFor(election);

  const rejected = Object.entries(survey.counties).filter(([, county]) => {
    const stamp = Date.parse(county.source_updated_at);
    // Reviewed at the latest moment a refresh for this election could run.
    return stamp < cycleStart || (electionDay - stamp) / 3_600_000 > limit;
  });
  assert.deepEqual(rejected.map(([countyId]) => countyId), []);
  assert.equal(Object.keys(survey.counties).length, 70);
});

// The backlog counts titles from the survey's shared index, so an index that
// dropped a county would report that county as owing nothing and its job would
// abort the run. Held to the per-county record, which is written in the same
// pass.
test("refuses a survey whose shared title index disagrees with its county record", () => {
  const dropped = fixture();
  dropped.survey.local_office_titles["For County Commissioner"].counties = ["adams"];
  assert.throws(
    () => buildRefreshJobs(dropped),
    /records 1 office title\(s\) for brown but its shared title index names 0/,
  );

  const extra = fixture();
  extra.survey.local_office_titles["For County Engineer"] = { counties: ["brown"], instances: 1 };
  assert.throws(
    () => buildRefreshJobs(extra),
    /records 1 office title\(s\) for brown but its shared title index names 2/,
  );
});

// electionCycleStart is exported and called directly by maxSourceAgeHoursFor,
// so its own refusals have to be measured against it rather than through
// buildRefreshJobs, which refuses a wrong election record before reaching it.
test("the cycle refusals hold when electionCycleStart is called directly", () => {
  assert.throws(() => electionCycleStart(undefined), /needs the election record it refreshes/);
  assert.throws(() => electionCycleStart([]), /needs the election record it refreshes/);
  assert.throws(
    () => electionCycleStart({ id: "2026-11-03-general", date: "November 3", schedule_rule: "ohio-general" }),
    /needs a YYYY-MM-DD date to place its cycle/,
  );
  // A date that disagrees with its own rule: the primary's date under the
  // general's rule puts the cycle's start on the election day it dates from,
  // which would make the backstop zero hours and admit nothing.
  assert.throws(
    () => electionCycleStart({ id: "2026-05-05-primary", date: "2026-05-05", schedule_rule: "ohio-general" }),
    /would begin its own cycle on 2026-05-05/,
  );
});
