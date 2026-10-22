import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  guideSearch,
  parseGuideSearch,
  scheduleOnlyNote,
} from "../src/lookup.mjs";

const data = JSON.parse(
  await readFile(new URL("../data/elections.json", import.meta.url), "utf8"),
);

test("a guide link carries the query, and the county only when one is chosen", () => {
  assert.equal(guideSearch({ query: "45202" }), "?q=45202");
  assert.equal(
    guideSearch({ query: "45202", countyId: "hamilton" }),
    "?q=45202&county=hamilton",
  );
});

test("a guide link escapes a place name instead of splitting the query string", () => {
  const search = guideSearch({ query: "Upper Arlington" });
  assert.equal(search, "?q=Upper+Arlington");
  assert.deepEqual(parseGuideSearch(search), {
    query: "Upper Arlington",
    countyId: null,
  });
});

test("surrounding whitespace never reaches the link or the restored query", () => {
  assert.equal(guideSearch({ query: "  45202 " }), "?q=45202");
  assert.deepEqual(parseGuideSearch("?q=%2045202%20"), {
    query: "45202",
    countyId: null,
  });
});

test("a link with no usable query restores nothing", () => {
  assert.equal(guideSearch({ query: "   " }), "");
  assert.equal(parseGuideSearch(""), null);
  assert.equal(parseGuideSearch("?county=hamilton"), null);
  assert.equal(parseGuideSearch("?q=%20%20"), null);
});

test("a round trip preserves the chosen county", () => {
  const restored = parseGuideSearch(guideSearch({ query: "45202", countyId: "hamilton" }));
  assert.deepEqual(restored, { query: "45202", countyId: "hamilton" });
});

test("an election with contests gets no schedule-only note", () => {
  const general = data.elections.find(({ id }) => id === "2026-11-03-general");
  assert.ok(general, "the 2026 general election is the one with published contests");
  assert.equal(scheduleOnlyNote(general), null);
});

test("an election that is only a date says so", () => {
  const dateOnly = data.elections.filter((election) => scheduleOnlyNote(election) !== null);
  assert.ok(
    dateOnly.length > 0,
    "the published schedule carries future dates with no contests yet",
  );
  for (const election of dateOnly) {
    assert.equal(election.statewide_races.length, 0);
    assert.match(scheduleOnlyNote(election), /contests are not published yet/);
  }
});
