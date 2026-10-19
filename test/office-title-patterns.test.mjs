import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  countyNamesFrom,
  measureCoverage,
  officeFromTitle,
  officeLabeller,
  officePhrase,
  readPatterns,
} from "../scripts/map-office-titles.mjs";

const PATTERNS = [
  { printed: "Auditor", office_id: "county-auditor", office: "County Auditor" },
  { printed: "County Auditor", office_id: "county-auditor", office: "County Auditor" },
  { printed: "County Commissioner", office_id: "county-commissioner", office: "County Commissioner" },
  { printed: "Judge of the Court of Appeals", office_id: "court-of-appeals-judge", office: "Judge of the Court of Appeals" },
  { printed: "Prosecuting Attorney", office_id: "county-prosecutor", office: "County Prosecuting Attorney" },
];
const CORRECTIONS = [{ printed: "For County Comissioner", read_as: "For County Commissioner", counties: ["portage"] }];

function label(title, countyName = "Adams") {
  return officeFromTitle(title, { patterns: PATTERNS, corrections: CORRECTIONS, countyName });
}

test("the longest printed phrase wins and must end on a word boundary", () => {
  assert.equal(label("For County Auditor").office, "County Auditor");
  assert.equal(label("For County Auditor").matched, "County Auditor", "not the shorter 'Auditor'");
  assert.equal(label("For Auditor").matched, "Auditor");
  // "Auditor" is a prefix of the letters but not of the words.
  assert.equal(label("For Auditors Association"), null);
});

test("a qualifier the county printed is kept exactly as printed", () => {
  // District, division and term are the difference between two seats on one
  // ballot. Dropping one shows a voter two contests with the same name.
  assert.equal(
    label("For Judge of the Court of Appeals (9th District) (Unexpired term ending 2-9-2029)").office,
    "Judge of the Court of Appeals (9th District) (Unexpired term ending 2-9-2029)",
  );
  assert.equal(
    label("For County Commissioner (Full term commencing 1-1-2027)").office,
    "County Commissioner (Full term commencing 1-1-2027)",
  );
});

test("a county's own name is stripped from its own title and nobody else's", () => {
  assert.equal(label("For Clinton County Auditor", "Clinton").office, "County Auditor");
  assert.equal(
    label("For Clinton County Auditor", "Brown"),
    null,
    "Brown printing another county's office is not something to label",
  );
});

test("a correction applies to a whole title, never to a fragment of one", () => {
  assert.equal(label("For County Comissioner").office, "County Commissioner");
  assert.equal(label("For County Comissioner").corrected, true);
  assert.equal(label("For County Commissioner").corrected, false);
  // The misspelling is listed whole precisely so it cannot generalise. A
  // different contest that happens to contain it stays a refusal.
  assert.equal(label("For County Comissioner of Something Else"), null);
});

test("a title the board did not print as an office is refused, not guessed", () => {
  assert.equal(label("County Auditor"), null, "no 'For', so not a printed contest title");
  assert.equal(label("For Township Trustee"), null);
  assert.equal(label("FOR COUNTY AUDITOR"), null, "capitals are not silently folded");
});

test("officePhrase drops the article the boards print inconsistently", () => {
  assert.equal(officePhrase("For the Judge of Court of Common Pleas"), "Judge of Court of Common Pleas");
  assert.equal(officePhrase("For County Auditor"), "County Auditor");
  assert.equal(officePhrase("County Auditor"), null);
});

test("the labeller hands the projector only an office id and a display name", () => {
  const labelOffice = officeLabeller({ patterns: PATTERNS, corrections: CORRECTIONS, countyName: "Adams" });
  assert.deepEqual(labelOffice("For Prosecuting Attorney"), {
    office_id: "county-prosecutor",
    office: "County Prosecuting Attorney",
  });
  assert.equal(labelOffice("For Township Trustee"), null);
});

test("reading the pattern file refuses the shapes that would mislabel an office", () => {
  const file = (overrides) => ({ meta: { schema_version: 1 }, patterns: [], corrections: [], ...overrides });
  assert.throws(() => readPatterns({ meta: { schema_version: 99 }, patterns: [] }), /schema 1/);
  assert.throws(
    () => readPatterns(file({ patterns: [{ printed: "Sheriff", office_id: "sheriff" }] })),
    /needs printed, office_id and office/,
  );
  assert.throws(
    () =>
      readPatterns(
        file({
          patterns: [
            { printed: "Sheriff", office_id: "sheriff", office: "County Sheriff" },
            { printed: "Sheriff", office_id: "coroner", office: "County Coroner" },
          ],
        }),
      ),
    /listed twice/,
  );
  assert.throws(
    () => readPatterns(file({ corrections: [{ printed: "For Sheriff", read_as: "For Sheriff" }] })),
    /corrects nothing/,
  );
  assert.doesNotThrow(() => readPatterns(file({ patterns: PATTERNS, corrections: CORRECTIONS })));
});

const SURVEY = {
  meta: { schema_version: 2, summary: { contest_instances: 20, automatable_instances: 10, automatable_share: "50.0%" } },
  local_office_titles: {
    "For County Auditor": { county_count: 2, instances: 2, counties: ["adams", "brown"] },
    // Two seats in one county: one title, two contests.
    "For County Commissioner": { county_count: 1, instances: 2, counties: ["adams"] },
    "For Township Trustee": { county_count: 1, instances: 1, counties: ["brown"] },
  },
  counties: {
    adams: { classes: { local_office: 3 } },
    brown: { classes: { local_office: 2 } },
  },
};

function coverage(survey = SURVEY) {
  return measureCoverage(survey, {
    patterns: PATTERNS,
    corrections: CORRECTIONS,
    countyNameFor: (countyId) => ({ adams: "Adams", brown: "Brown" })[countyId],
  });
}

test("coverage counts contests, not the counties that print a title", () => {
  const measured = coverage();
  assert.equal(measured.titles_labelled, 2);
  assert.equal(measured.titles_total, 3);
  // Four, not three: Adams prints its commissioner title twice. Counting
  // counties would understate what the patterns cover.
  assert.equal(measured.instances_labelled, 4);
  assert.equal(measured.local_office_instances, 5);
  assert.deepEqual(
    measured.unlabelled.map(({ title }) => title),
    ["For Township Trustee"],
  );
});

test("a title is covered only when every county printing it is covered", () => {
  const survey = structuredClone(SURVEY);
  survey.local_office_titles["For Clinton County Auditor"] = {
    county_count: 2,
    instances: 2,
    counties: ["adams", "brown"],
  };
  const measured = measureCoverage(survey, {
    patterns: PATTERNS,
    corrections: CORRECTIONS,
    countyNameFor: (countyId) => ({ adams: "Clinton", brown: "Brown" })[countyId],
  });
  assert.deepEqual(
    measured.unlabelled.find(({ title }) => title === "For Clinton County Auditor").counties,
    ["brown"],
    "the county that cannot read the title is the one reported",
  );
});

test("a pattern no surveyed title reaches is reported as unused", () => {
  assert.deepEqual(coverage().patterns_unused, [
    "Auditor",
    "Judge of the Court of Appeals",
    "Prosecuting Attorney",
  ]);
});

test("measuring an older survey refuses instead of reporting NaN", () => {
  const survey = structuredClone(SURVEY);
  survey.meta.schema_version = 1;
  assert.throws(() => coverage(survey), /must be schema 2/);
});

test("the committed patterns reproduce the office table Adams needed written by hand", async () => {
  // These seven are exactly what config/vtrapp-20261103G.json carried for
  // Adams before any pattern existed, written out by a person reading the
  // county's ballot. If the pattern set cannot reproduce them it is not ready
  // to replace that work for the other sixty-nine counties.
  const handWritten = {
    "For Representative to Congress (2nd District)": {
      office_id: "us-representative",
      office: "U.S. Representative (2nd District)",
    },
    "For State Representative (90th District)": {
      office_id: "state-representative",
      office: "State Representative (90th District)",
    },
    "For Judge of the Court of Appeals (4th District)": {
      office_id: "court-of-appeals-judge",
      office: "Judge of the Court of Appeals (4th District)",
    },
    "For Judge of the Court of Common Pleas": {
      office_id: "common-pleas-judge",
      office: "Judge of the Court of Common Pleas",
    },
    "For County Commissioner": { office_id: "county-commissioner", office: "County Commissioner" },
    "For County Auditor": { office_id: "county-auditor", office: "County Auditor" },
    "For Prosecuting Attorney": { office_id: "county-prosecutor", office: "County Prosecuting Attorney" },
  };
  const committed = readPatterns(JSON.parse(await readFile(new URL("../data/office-title-patterns.json", import.meta.url), "utf8")));
  const labelOffice = officeLabeller({ ...committed, countyName: "Adams" });
  for (const [title, expected] of Object.entries(handWritten)) {
    assert.deepEqual(labelOffice(title), expected, title);
  }
});

test("county display names come from the published locations, not from the id", async () => {
  const locations = JSON.parse(await readFile(new URL("../data/locations.json", import.meta.url), "utf8"));
  const names = countyNamesFrom(locations);
  assert.equal(names["van-wert"], "Van Wert", "a two-word county is not 'Van-wert'");
  assert.equal(names.adams, "Adams");
});
