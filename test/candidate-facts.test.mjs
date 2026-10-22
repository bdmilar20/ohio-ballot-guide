import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertCandidateFacts } from "../src/candidate-facts.mjs";

const facts = JSON.parse(await readFile(new URL("../data/candidate-facts.json", import.meta.url), "utf8"));
const elections = JSON.parse(await readFile(new URL("../data/elections.json", import.meta.url), "utf8"));

function clone(value) {
  return structuredClone(value);
}

test("publishes the same sourced fact fields for all four Supreme Court candidates", () => {
  assert.deepEqual(assertCandidateFacts(facts, elections), { profiles: 4 });
  assert.deepEqual(
    Object.values(facts.profiles).map(({ facts: profileFacts }) => profileFacts.map(({ category }) => category)),
    Array(4).fill(["role", "experience", "education"]),
  );
});

test("rejects a fact with no citation", () => {
  const altered = clone(facts);
  altered.profiles["marilyn-zayas"].facts[0].source_ids = [];
  assert.throws(() => assertCandidateFacts(altered, elections), /needs a citation/);
});

test("rejects a candidate-authored source labeled as official", () => {
  const altered = clone(facts);
  altered.profiles["colleen-odonnell"].links[0].source_type = "official";
  assert.throws(() => assertCandidateFacts(altered, elections), /campaign has the wrong source label/);
});

test("requires a content digest for candidate-controlled and questionnaire sources", () => {
  const altered = clone(facts);
  delete altered.profiles["colleen-odonnell"].sources["campaign-biography"].source_sha256;
  assert.throws(
    () => assertCandidateFacts(altered, elections),
    /campaign-biography needs the SHA-256 of the reviewed source bytes/,
  );

  altered.profiles["colleen-odonnell"].sources["campaign-biography"].source_sha256 = "not-a-digest";
  assert.throws(
    () => assertCandidateFacts(altered, elections),
    /campaign-biography needs the SHA-256 of the reviewed source bytes/,
  );
});

test("rejects issue positions or endorsements in the facts-only schema", () => {
  const altered = clone(facts);
  altered.profiles["daniel-r-hawkins"].facts.push({
    category: "endorsements",
    text: "Example",
    source_ids: ["supreme-court-bio"],
  });
  assert.throws(() => assertCandidateFacts(altered, elections), /needs the same core fact categories/);
});

test("rejects a profile attached to the wrong ballot candidate", () => {
  const alteredElections = clone(elections);
  const race = alteredElections.elections[0].statewide_races.find(({ id }) => id === "supreme-court-jan-1");
  race.candidates[0].profile_id = "daniel-r-hawkins";
  assert.throws(() => assertCandidateFacts(facts, alteredElections), /duplicate candidate profile reference/);
});

test("rejects an orphan profile", () => {
  const alteredElections = clone(elections);
  const race = alteredElections.elections[0].statewide_races.find(({ id }) => id === "supreme-court-jan-2");
  delete race.candidates[0].profile_id;
  assert.throws(() => assertCandidateFacts(facts, alteredElections), /candidate profile references must exactly match/);
});
