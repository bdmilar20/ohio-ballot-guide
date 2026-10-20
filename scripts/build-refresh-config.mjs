// Generates the durable refresh config: one projection job per enumerable
// county, derived from committed artifacts rather than typed out by hand.
//
//   npm run generate:refresh-config -- --election 20261103G
//
// Why this is generated. `config/vtrapp-<KEY>.json` holds the decisions a
// county refresh has to reproduce, and until now it was a hand-written file
// with one job in it --- Adams --- carrying seven office mappings. Onboarding a
// county meant writing its table out, which is why eight of eighty-eight
// counties have local ballot content and seven of those eight were typed in
// rather than projected. The config also changes every election, so by the
// project's own rule it cannot be a file somebody maintains.
//
// It does not need to be. `data/vtrapp-contest-survey.json` already measures
// which counties are enumerable and which office titles each one prints, and
// `data/office-title-patterns.json` labels those titles. Every one of Adams'
// seven mappings is reproduced by the patterns, and all 575 local-office
// instances across all 70 enumerable counties label without a refusal. So the
// generated job is the empty one, and the artifact's value is that it covers
// the whole measured state instead of one county.
//
// **The decisions a human still owns live in their own file**, keyed by county,
// in `config/decisions-<KEY>.json`. Not inline in the generated config: if the
// generator read its own output back as input, a hand edit to a job would be
// carried forward and reproduce itself, and the recomputation gate in
// `check-refresh-config.mjs` would pass on an edited file. Separating them is
// what makes that gate mean anything.
//
// **A decision the patterns can already derive is refused, not kept.** Two
// sources of truth for one label is how they drift, and the stale one wins
// silently: the hand copy would keep publishing an office name after the
// pattern that should own it changed.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { electionIdFromKey, parseArgs } from "./ingest/vtrapp.mjs";
import { officeFromTitle, readPatterns, surveyedTitlesFor } from "./map-office-titles.mjs";
import { CONTEST_SURVEY_SCHEMA_VERSION } from "./survey-contests.mjs";
import { REFRESH_MANIFEST_SCHEMA_VERSION } from "./refresh-vtrapp.mjs";

export const REFRESH_DECISIONS_SCHEMA_VERSION = 1;
export const GENERATED_BY = "scripts/build-refresh-config.mjs";

const MAPPING_FIELDS = ["office_mappings", "statewide_race_mappings", "statewide_issue_mappings"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function countyNameFor(locations, countyId) {
  const location = locations?.counties?.[countyId];
  invariant(location, `the survey measured ${countyId}, which is absent from locations data`);
  return location.name.replace(/ County$/, "");
}

/**
 * Checks the hand-owned decisions file before any of it reaches a job.
 *
 * Scoped to one election on purpose. A decision is a judgement about a ballot
 * somebody read; carrying last election's mapping into this one would publish
 * an office under a decision nobody made about the contest now printed.
 */
export function readDecisions(artifact, { electionId, vendorKey }) {
  invariant(isRecord(artifact), "refresh decisions must be an object");
  invariant(
    artifact.schema_version === REFRESH_DECISIONS_SCHEMA_VERSION,
    `refresh decisions must be schema ${REFRESH_DECISIONS_SCHEMA_VERSION}, not ${artifact.schema_version}`,
  );
  invariant(
    artifact.election?.vendor_key === vendorKey && artifact.election?.id === electionId,
    `refresh decisions are for ${artifact.election?.id} / ${artifact.election?.vendor_key}, ` +
      `not the ${electionId} / ${vendorKey} being generated`,
  );
  invariant(
    Number.isFinite(artifact.max_source_age_hours) && artifact.max_source_age_hours >= 0,
    "refresh decisions need a nonnegative max_source_age_hours: how stale a source a refresh may publish from",
  );
  invariant(isRecord(artifact.counties), "refresh decisions need a counties object, even when it is empty");
  for (const [countyId, decision] of Object.entries(artifact.counties)) {
    invariant(isRecord(decision), `refresh decision for ${countyId} must be an object`);
    for (const field of Object.keys(decision)) {
      invariant(
        MAPPING_FIELDS.includes(field),
        `refresh decision for ${countyId} has unknown field ${JSON.stringify(field)}`,
      );
    }
    for (const field of MAPPING_FIELDS) {
      if (decision[field] !== undefined) {
        invariant(isRecord(decision[field]), `refresh decision for ${countyId} ${field} must be an object`);
      }
    }
  }
  return artifact;
}

/**
 * The jobs the committed artifacts imply, in county order.
 *
 * Pure: every input is passed in, so `check-refresh-config.mjs` can recompute
 * this from the same committed files and compare. A config that does not match
 * what the artifacts imply is a config somebody edited.
 */
export function buildRefreshJobs({ survey, patterns, corrections, locations, decisions, publishedCounties = {} }) {
  invariant(
    survey?.meta?.schema_version === CONTEST_SURVEY_SCHEMA_VERSION,
    `the contest survey must be schema ${CONTEST_SURVEY_SCHEMA_VERSION} to generate a refresh config, ` +
      `not ${survey?.meta?.schema_version}; re-run npm run survey:contests`,
  );
  const vendorKey = survey.meta.election.vendor_key;
  const electionId = survey.meta.election.id;
  invariant(
    electionIdFromKey(vendorKey) === electionId,
    `the contest survey's vendor key ${vendorKey} does not name election ${electionId}`,
  );
  invariant(
    Object.keys(survey.meta.failures ?? {}).length === 0,
    "a contest survey with county failures measured part of the state and cannot generate the whole config",
  );

  const surveyed = new Set(Object.keys(survey.counties));
  // A decision about a county the survey never read is a decision about a
  // ballot nobody measured. It cannot be carried into a job, because nothing
  // here can say whether the title it maps is still printed.
  for (const countyId of Object.keys(decisions.counties)) {
    invariant(
      surveyed.has(countyId),
      `refresh decisions name ${countyId}, which the contest survey did not measure; ` +
        "a decision needs a ballot somebody read",
    );
  }

  // Published coverage this config has to stay able to reproduce. A county
  // reviewed at an age above the durable limit would fail check-refresh-config
  // after this file replaced the hand-written one, so refuse here with the
  // number a human has to decide about rather than quietly raising the limit.
  for (const [countyId, county] of Object.entries(publishedCounties)) {
    if (county?.coverage?.method !== "common_to_all_precincts") continue;
    const reviewedAt = county.coverage.source_age_hours_at_review;
    invariant(
      !Number.isFinite(reviewedAt) || reviewedAt <= decisions.max_source_age_hours,
      `${countyId} publishes generated coverage reviewed at ${reviewedAt}h, above the ` +
        `${decisions.max_source_age_hours}h limit in the decisions file; raise it deliberately or re-review the county`,
    );
  }

  const jobs = [];
  for (const countyId of [...surveyed].sort()) {
    const countyName = countyNameFor(locations, countyId);
    const decision = decisions.counties[countyId] ?? {};

    const handOffices = decision.office_mappings ?? {};
    for (const title of Object.keys(handOffices)) {
      const derived = officeFromTitle(title, { patterns, corrections, countyName });
      invariant(
        !derived,
        `refresh decisions map ${JSON.stringify(title)} for ${countyId}, but the curated patterns already ` +
          `derive ${JSON.stringify(derived?.office)}; drop the decision rather than keeping a second copy of it`,
      );
    }

    jobs.push({
      county: countyId,
      election: vendorKey,
      projection: {
        max_source_age_hours: decisions.max_source_age_hours,
        county_name: countyName,
        office_mappings: handOffices,
        statewide_race_mappings: decision.statewide_race_mappings ?? {},
        statewide_issue_mappings: decision.statewide_issue_mappings ?? {},
      },
    });
  }
  invariant(jobs.length > 0, "the contest survey measured no counties, so there is no config to generate");
  return { vendorKey, electionId, jobs };
}

/**
 * Counts the titles a job cannot label, so the backlog is a measured number
 * rather than something read off a passing build.
 *
 * A county with an unlabelled title still gets a job: its statewide races
 * publish and the unlabelled contest refuses at projection time. That is the
 * right outcome, and it is also invisible unless something counts it.
 */
export function unlabelledTitles({ survey, patterns, corrections, locations }) {
  const pending = [];
  for (const countyId of Object.keys(survey.counties).sort()) {
    const countyName = countyNameFor(locations, countyId);
    for (const title of surveyedTitlesFor(survey, countyId, survey.meta.election.id)) {
      if (!officeFromTitle(title, { patterns, corrections, countyName })) pending.push({ county: countyId, title });
    }
  }
  return pending;
}

export function refreshConfigArtifact({ vendorKey, electionId, jobs, generatedOn }) {
  return {
    schema_version: REFRESH_MANIFEST_SCHEMA_VERSION,
    meta: {
      generated_by: GENERATED_BY,
      generated_on: generatedOn,
      note: `Generated file. Do not hand-edit; re-run npm run generate:refresh-config -- --election ${vendorKey}. ` +
        `Decisions a human owns go in config/decisions-${vendorKey}.json.`,
      election: { id: electionId, vendor_key: vendorKey },
    },
    jobs,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const vendorKey = (args.election ?? "").toUpperCase();
    invariant(vendorKey, "pass --election <vendor key>, e.g. --election 20261103G");
    const electionId = electionIdFromKey(vendorKey);

    const survey = await readJson(args.survey ? resolve(args.survey) : "data/vtrapp-contest-survey.json");
    const { patterns, corrections } = readPatterns(
      await readJson(args["office-title-patterns"] ? resolve(args["office-title-patterns"]) : "data/office-title-patterns.json"),
    );
    const locations = await readJson(args.locations ? resolve(args.locations) : "data/locations.json");
    const elections = await readJson(args.elections ? resolve(args.elections) : "data/elections.json");
    const decisions = readDecisions(
      await readJson(args.decisions ? resolve(args.decisions) : `config/decisions-${vendorKey}.json`),
      { electionId, vendorKey },
    );
    invariant(
      survey.meta.election.vendor_key === vendorKey,
      `the contest survey measured ${survey.meta.election.vendor_key}, not the ${vendorKey} being generated`,
    );

    const published = elections.elections.find((election) => election.id === electionId)?.counties ?? {};
    const built = buildRefreshJobs({ survey, patterns, corrections, locations, decisions, publishedCounties: published });
    const artifact = refreshConfigArtifact({
      ...built,
      generatedOn: args["generated-on"] ?? new Date().toISOString().slice(0, 10),
    });

    const out = args.out ? resolve(args.out) : `config/vtrapp-${vendorKey}.json`;
    await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`);

    const handEntries = built.jobs.filter((job) => Object.keys(job.projection.office_mappings).length > 0);
    const pending = unlabelledTitles({ survey, patterns, corrections, locations });
    console.log(`Wrote ${out}: ${built.jobs.length} job(s) for ${electionId}.`);
    console.log(`  counties needing a hand office mapping: ${handEntries.length}`);
    console.log(`  surveyed office titles no pattern labels: ${pending.length}`);
    for (const { county, title } of pending) console.log(`    ${county}: ${title}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
