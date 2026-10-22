import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ballotCoverage } from "../src/lookup.mjs";

// A result used to open with no number at all. Braeden searched 45202, saw
// three cards, and read that as his ballot. These tests cover the count itself
// and the four places the page could stop showing it.

const here = (file) => new URL(`../${file}`, import.meta.url);
const markup = await readFile(here("index.html"), "utf8");
const app = await readFile(here("app.js"), "utf8");
const css = (await readFile(here("styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
const data = JSON.parse(await readFile(here("data/elections.json"), "utf8"));

const election = ({ statewide = 0, issues = 0, counties = {} }) => ({
  statewide_races: Array.from({ length: statewide }, (_, index) => ({ office: `Office ${index}` })),
  issues: Array.from({ length: issues }, (_, index) => ({ title: `Issue ${index}` })),
  counties,
});

const county = (races, issues = 0) => ({
  races: Array.from({ length: races }, (_, index) => ({ office: `Local ${index}` })),
  issues: Array.from({ length: issues }, (_, index) => ({ title: `Local issue ${index}` })),
});

test("the count adds the statewide and county content a voter can see", () => {
  const coverage = ballotCoverage(election({ statewide: 8, issues: 1, counties: { hamilton: county(17, 2) } }), {
    countyId: "hamilton",
    countyName: "Hamilton County",
  });
  assert.equal(coverage.total, 28);
  assert.equal(
    coverage.counts,
    "This guide has 28 contests and questions for you: 8 statewide contests, " +
      "1 statewide ballot issue, 17 countywide contests in Hamilton County, " +
      "and 2 county ballot issues in Hamilton County.",
  );
});

test("a single contest is counted in the singular", () => {
  const coverage = ballotCoverage(election({ statewide: 1 }));
  assert.equal(coverage.total, 1);
  assert.equal(coverage.counts, "This guide has 1 contest or question for you: 1 statewide contest.");
});

test("an election with nothing published produces no count to show", () => {
  assert.equal(ballotCoverage(election({})), null);
  const scheduleOnly = data.elections.filter(
    ({ statewide_races: races, issues, counties }) =>
      races.length === 0 &&
      issues.length === 0 &&
      Object.values(counties).every(({ races: local = [], issues: localIssues = [] }) => local.length === 0 && localIssues.length === 0),
  );
  assert.ok(scheduleOnly.length > 0, "the published schedule carries future dates with no contests yet");
  for (const future of scheduleOnly) assert.equal(ballotCoverage(future), null);
});

// Three different truths, and saying the wrong one is how the page misled
// someone in the first place: content exists and is partial, the county has
// nothing yet, or no county has been chosen.
test("the caveat matches which of the three situations the voter is in", () => {
  const withLocal = ballotCoverage(election({ statewide: 8, counties: { adams: county(8, 2) } }), {
    countyId: "adams",
    countyName: "Adams County",
  });
  assert.match(withLocal.gaps, /^That is not your whole ballot\./);
  assert.match(withLocal.gaps, /what that list leaves out/);

  const emptyCounty = ballotCoverage(election({ statewide: 8, counties: { delaware: county(0) } }), {
    countyId: "delaware",
    countyName: "Delaware County",
  });
  assert.match(emptyCounty.gaps, /no local contests are verified for your county yet/);

  const noCounty = ballotCoverage(election({ statewide: 8 }));
  assert.match(noCounty.gaps, /holds no local contests yet/);
});

test("every published contest in the live data is counted for the county it belongs to", () => {
  const general = data.elections.find(({ id }) => id === "2026-11-03-general");
  assert.ok(general, "the 2026 general election is the one with published contests");
  const statewide = general.statewide_races.length + general.issues.length;
  assert.equal(ballotCoverage(general).total, statewide);
  for (const [countyId, record] of Object.entries(general.counties)) {
    const local = record.races.length + (record.issues?.length ?? 0);
    const coverage = ballotCoverage(general, { countyId, countyName: countyId });
    assert.equal(coverage.total, statewide + local, `${countyId} count must include its own contests`);
  }
});

test("the count renders before the first contest card", () => {
  const coverage = markup.indexOf('id="ballot-coverage"');
  const statewide = markup.indexOf('id="statewide-section"');
  assert.ok(coverage > -1, "the results panel must contain the coverage count");
  assert.ok(statewide > -1, "the statewide contest section must still be in the page");
  assert.ok(coverage < statewide, "a count printed after the cards is a count nobody reads first");
});

test("both halves of the count are written into the page", () => {
  for (const node of ["ballotCoverageCounts", "ballotCoverageGaps"]) {
    assert.match(
      app,
      new RegExp(`${node}\\.textContent\\s*=`),
      `${node} must be filled in, or its paragraph stays empty`,
    );
  }
});

test("choosing a county recounts the ballot", () => {
  assert.match(
    app,
    /renderBallotCoverage\(countyId\)/,
    "a county result must recount, or the county's contests are left out of the total",
  );
});

test("no stylesheet rule hides the coverage count", () => {
  const hiding = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/ballot-coverage/.test(selector) && /(display\s*:\s*none|visibility\s*:\s*hidden)/.test(body)) {
      hiding.push(selector.trim().replace(/\s+/g, " "));
    }
  }
  assert.deepEqual(hiding, [], "the count must not be hidden by CSS");
});
