import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEST_CLASSES,
  classifyContest,
  localOfficeTitleIndex,
  readPartial,
  summarizeSurvey,
  surveyCounty,
} from "../scripts/survey-contests.mjs";

function office(title, choices, overrides = {}) {
  const normalized = choices.map(([name, party = null, writeIn = false]) => ({
    name,
    party,
    write_in: writeIn,
    raw_lines: party ? [name, party] : [name],
  }));
  return {
    order: 1,
    kind: "office",
    title,
    subtitles: [],
    instructions: [],
    vote_for: 1,
    issue_text_lines: null,
    choices: normalized,
    allows_write_in: normalized.some(({ write_in: writeIn }) => writeIn),
    source_url: "https://example.gov/ballot",
    raw: { heading_lines: [title], choice_lines: normalized.map(({ raw_lines: lines }) => lines) },
    uncertain: [],
    ...overrides,
  };
}

function issue(title, body, overrides = {}) {
  const choices = [
    { name: "YES", party: null, write_in: false, raw_lines: ["YES"] },
    { name: "NO", party: null, write_in: false, raw_lines: ["NO"] },
  ];
  return {
    order: 2,
    kind: "issue",
    title,
    subtitles: [],
    instructions: [],
    vote_for: null,
    issue_text_lines: body === null ? null : [body],
    choices,
    allows_write_in: false,
    source_url: "https://example.gov/ballot",
    raw: { heading_lines: [title], choice_lines: choices.map(({ raw_lines: lines }) => lines) },
    uncertain: [],
    ...overrides,
  };
}

const election = {
  id: "2026-11-03-general",
  statewide_races: [
    {
      id: "governor",
      office: "Governor & Lieutenant Governor",
      candidates: [
        { name: "Amy Acton & David Pepper", party: "Democratic" },
        { name: "Vivek Ramaswamy & Robert A. McColley", party: "Republican" },
      ],
    },
  ],
  issues: [{ id: "state-issue-3", label: "State Issue 3" }],
};
const CERTIFIED = { "state-issue-3": "This proposed amendment would require photo identification." };
const governorChoices = [
  ["Amy Acton and David Pepper", "Democratic"],
  ["Vivek Ramaswamy and Robert A. McColley", "Republican"],
];
const classify = (contest) => classifyContest(contest, { election, issueText: CERTIFIED });

test("a statewide race whose title and candidates both agree needs no hand entry", () => {
  const verdict = classify(office("For Governor and Lieutenant Governor", governorChoices));
  assert.deepEqual(verdict, { class: "statewide_race_resolved", id: "governor" });
  assert.equal(CONTEST_CLASSES[verdict.class].needs_hand_entry, false);
});

test("a statewide race the title resembles but the candidates do not is a hand entry", () => {
  // The county prints a different candidate set under the published office
  // name. Publishing it either way is a decision a person has to make.
  const verdict = classify(office("For Governor and Lieutenant Governor", [["Someone Else", "Democratic"]]));
  assert.deepEqual(verdict, { class: "statewide_race_needs_mapping", id: "governor" });
  assert.equal(CONTEST_CLASSES[verdict.class].needs_hand_entry, true);
});

test("a statewide race only the candidate set can see is counted as a hand entry, not as resolved", () => {
  // Harrison's shape, and the survey must not flatter itself here: the
  // projector refuses this contest rather than resolving it, so counting it as
  // automatable would overstate coverage by exactly the cases that still need
  // a human.
  const verdict = classify(office("For Govenor and Leiutenant Govenor", governorChoices));
  assert.deepEqual(verdict, { class: "statewide_race_needs_decision", id: "governor" });
  assert.equal(CONTEST_CLASSES[verdict.class].needs_hand_entry, true);
});

test("a statewide issue is resolved by its certified text whatever the county titled it", () => {
  const asIssue3 = classify(issue("Issue 3", CERTIFIED["state-issue-3"]));
  const asLorain = classify(issue("3 Proposed Constitutional Amendment", CERTIFIED["state-issue-3"]));
  assert.deepEqual(asIssue3, { class: "statewide_issue_resolved_by_text", id: "state-issue-3" });
  assert.deepEqual(asLorain, asIssue3, "the heading the county chose cannot change the verdict");
});

test("a statewide issue the title names but the text does not match is a hand entry", () => {
  const verdict = classify(issue("Issue 3", "Some other wording entirely."));
  assert.deepEqual(verdict, { class: "statewide_issue_needs_mapping", id: "state-issue-3" });
  assert.equal(CONTEST_CLASSES[verdict.class].needs_hand_entry, true);
});

test("a local issue and a local office are told apart, and only the office costs an entry", () => {
  assert.deepEqual(classify(issue("Proposed Tax Levy (Additional)", "A levy for the county.")), {
    class: "local_issue",
    title: "Proposed Tax Levy (Additional)",
  });
  assert.deepEqual(classify(office("For County Commissioner", [["Ada Lovelace", "Democratic"]])), {
    class: "local_office",
    title: "For County Commissioner",
  });
  assert.equal(CONTEST_CLASSES.local_issue.needs_hand_entry, false);
  assert.equal(CONTEST_CLASSES.local_office.needs_hand_entry, true);
});

test("every class the classifier can return is declared with a hand-entry cost", () => {
  // The share below is computed from CONTEST_CLASSES, so a class added to the
  // classifier without a cost would silently count as automatable.
  const reachable = [
    classify(office("For Governor and Lieutenant Governor", governorChoices)),
    classify(office("For Governor and Lieutenant Governor", [["Someone Else", "Democratic"]])),
    classify(office("For Govenor and Leiutenant Govenor", governorChoices)),
    classify(issue("Issue 3", CERTIFIED["state-issue-3"])),
    classify(issue("Issue 3", "Some other wording entirely.")),
    classify(issue("Proposed Tax Levy (Additional)", "A levy for the county.")),
    classify(office("For County Commissioner", [["Ada Lovelace", "Democratic"]])),
  ].map(({ class: name }) => name);
  assert.deepEqual([...new Set(reachable)].sort(), Object.keys(CONTEST_CLASSES).sort());
});

test("a county record counts its contests and counts each local office title", () => {
  const record = surveyCounty(
    [
      office("For Governor and Lieutenant Governor", governorChoices),
      office("For County Commissioner", [["Ada Lovelace", "Democratic"]]),
      office("For County Commissioner", [["Grace Hopper", "Republican"]], { order: 3 }),
      issue("Issue 3", CERTIFIED["state-issue-3"]),
      issue("Proposed Tax Levy (Additional)", "A levy for the county."),
    ],
    { election, issueText: CERTIFIED },
  );
  assert.deepEqual(record.classes, {
    statewide_race_resolved: 1,
    local_office: 2,
    statewide_issue_resolved_by_text: 1,
    local_issue: 1,
  });
  assert.deepEqual(
    record.local_office_titles,
    { "For County Commissioner": 2 },
    "two seats under one title are two contests, not one",
  );
});

test("the summary counts instances and reports every declared class, including the empty ones", () => {
  const summary = summarizeSurvey(
    {
      adams: { classes: { statewide_race_resolved: 8, local_office: 2 }, local_office_titles: {} },
      lorain: { classes: { statewide_race_resolved: 8, local_issue: 2 }, local_office_titles: {} },
    },
    { failures: { licking: "transport: timed out" }, enumerableCounties: 70 },
  );
  assert.equal(summary.contest_instances, 20);
  assert.equal(summary.hand_entries, 2);
  assert.equal(summary.automatable_instances, 18);
  assert.equal(summary.automatable_share, "90.0%");
  assert.equal(summary.counties_read, 2);
  assert.equal(summary.counties_failed, 1);
  assert.equal(summary.counties_enumerable, 70);
  assert.deepEqual(Object.keys(summary.classes).sort(), Object.keys(CONTEST_CLASSES).sort());
  assert.equal(summary.classes.statewide_issue_needs_mapping, 0, "a class nobody hit reports zero, not absence");
});

test("the summary of nothing is not a hundred percent", () => {
  // An empty survey must not read as total success, which is what a naive
  // automatable/total would produce.
  const summary = summarizeSurvey({}, {});
  assert.equal(summary.contest_instances, 0);
  assert.equal(summary.automatable_share, "0.0%");
});

test("the title index counts contests as well as counties", () => {
  // The two figures differ, and the difference is the point: a title printed
  // twice in one county is two contests a pattern would cover, and a set of
  // titles cannot see the second one.
  const index = localOfficeTitleIndex({
    adams: { classes: {}, local_office_titles: { "For County Commissioner": 2, "For County Comissioner": 1 } },
    brown: { classes: {}, local_office_titles: { "For County Commissioner": 1 } },
  });
  assert.deepEqual(index, {
    "For County Comissioner": { county_count: 1, instances: 1, counties: ["adams"] },
    "For County Commissioner": { county_count: 2, instances: 3, counties: ["adams", "brown"] },
  });
});

test("a resumed walk reads back only its own election's counties", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obg-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "partial.ndjson");

  assert.deepEqual(await readPartial(path, "20261103G"), {}, "no log yet is not an error");

  const record = { contests_read: 3, classes: { local_office: 1 }, local_office_titles: { "For Sheriff": 1 } };
  await writeFile(path, `${JSON.stringify({ election: "20261103G", county: "adams", record })}\n`);
  assert.deepEqual(await readPartial(path, "20261103G"), { adams: record });

  // Resuming one election's walk from another's would report contests from
  // the wrong ballot under this election's name.
  await assert.rejects(() => readPartial(path, "20261103S"), /holds election 20261103G/);
});

test("a partial line a killed process left half-written is refused, not guessed at", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obg-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "partial.ndjson");
  const record = { contests_read: 3, classes: {}, local_office_titles: {} };
  await writeFile(
    path,
    `${JSON.stringify({ election: "20261103G", county: "adams", record })}\n{"election":"20261103G","county":"all`,
  );

  await assert.rejects(() => readPartial(path, "20261103G"), /not valid JSON/);
});
