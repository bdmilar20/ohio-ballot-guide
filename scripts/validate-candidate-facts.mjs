import { readFile } from "node:fs/promises";

import { assertCandidateFacts } from "../src/candidate-facts.mjs";

const factsSource = process.argv[2] ?? new URL("../data/candidate-facts.json", import.meta.url);
const electionsSource = process.argv[3] ?? new URL("../data/elections.json", import.meta.url);

const facts = JSON.parse(await readFile(factsSource, "utf8"));
const elections = JSON.parse(await readFile(electionsSource, "utf8"));
const result = assertCandidateFacts(facts, elections);

console.log(`Validated ${result.profiles} sourced candidate profiles.`);
