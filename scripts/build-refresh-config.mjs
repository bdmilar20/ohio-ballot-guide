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
//
// **A county that still owes a decision is left out of the config, not given a
// job.** `refreshElections` projects jobs serially with no per-job recovery, so
// a county whose contest nobody mapped does not withhold itself --- it aborts
// the run and withholds the candidate file for every county in it. The backlog
// is counted from every survey class that costs a hand decision, not from
// office titles alone, because the class that caught this was a statewide race
// in Harrison that the office-title count could not see.
//
// **The staleness backstop is generated too**, from the election's own cycle.
// It was a typed 168 hours inherited from the one-county config, and across the
// surveyed seventy it admitted one of them. See maxSourceAgeHoursFor.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { electionDateForRule } from "./build-election-schedule.mjs";
import { electionIdFromKey, parseArgs } from "./ingest/vtrapp.mjs";
import { officeFromTitle, readPatterns, surveyedTitlesFor } from "./map-office-titles.mjs";
import { CONTEST_CLASSES, CONTEST_SURVEY_SCHEMA_VERSION } from "./survey-contests.mjs";
import { REFRESH_MANIFEST_SCHEMA_VERSION } from "./refresh-vtrapp.mjs";

export const REFRESH_DECISIONS_SCHEMA_VERSION = 1;
export const GENERATED_BY = "scripts/build-refresh-config.mjs";

const MAPPING_FIELDS = ["office_mappings", "statewide_race_mappings", "statewide_issue_mappings"];
const DECISIONS_FIELDS = ["schema_version", "note", "election", "counties"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// The shape validate-data.mjs already requires of a published coverage stamp.
// A surveyed stamp is the same evidence and is compared against a cycle
// boundary, so without an offset the instant it names --- and therefore which
// side of the boundary it falls on --- depends on the machine reading it.
const SOURCE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The election whose day begins this one's cycle, per the schedule rules the
 * repository already generates from Ohio law.
 *
 * Used only to date the staleness backstop. A board's "Election data last
 * updated" stamp cannot predate the listing it describes, so a stamp from
 * before this election's cycle began is a snapshot of a different ballot.
 */
const CYCLE_START_RULE = {
  "ohio-general": (year) => ({ year, rule: "ohio-primary" }),
  "ohio-august-special": (year) => ({ year, rule: "ohio-primary" }),
  "ohio-primary": (year) => ({ year: year - 1, rule: "ohio-general" }),
};

/**
 * Which hand-owned decision field pays for each survey class that costs one.
 *
 * `local_office` is the exception: its cost is paid by a curated office-title
 * pattern when one labels the title, and only by a hand mapping when none
 * does, so it is counted per title rather than per instance.
 *
 * Declared against `CONTEST_CLASSES` and asserted complete. A class added to
 * the survey that nothing here accounts for is a class whose contests would
 * generate a job that cannot project --- the Harrison case --- so it has to be
 * a failing build rather than a silent zero in the backlog.
 */
export const DECISION_FIELD_BY_CLASS = {
  local_office: null,
  statewide_race_needs_mapping: "statewide_race_mappings",
  statewide_race_needs_decision: "statewide_race_mappings",
  statewide_issue_needs_mapping: "statewide_issue_mappings",
};

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
  // The staleness backstop is NOT one of them. It was a hand-written 168 that
  // only ever had to admit the one county the old config carried, and at
  // seventy it admitted one of them; see maxSourceAgeHoursFor.
  invariant(
    artifact.max_source_age_hours === undefined,
    "refresh decisions must not set max_source_age_hours: the backstop is generated from the election's own " +
      "cycle by maxSourceAgeHoursFor, because a typed limit is a number nothing measures against the source population",
  );
  for (const field of Object.keys(artifact)) {
    invariant(
      DECISIONS_FIELDS.includes(field),
      `refresh decisions have unknown field ${JSON.stringify(field)}`,
    );
  }
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
 * The day this election's cycle began, as an ISO date.
 *
 * Derived from the election's own `schedule_rule` through the same generator
 * that produces its date, so it recomputes per election rather than being a
 * number somebody maintains.
 */
export function electionCycleStart(election) {
  invariant(isRecord(election), "generating a refresh config needs the election record it refreshes");
  invariant(
    typeof election.date === "string" && ISO_DATE.test(election.date),
    `election ${election.id} needs a YYYY-MM-DD date to place its cycle`,
  );
  const rule = CYCLE_START_RULE[election.schedule_rule];
  invariant(
    rule,
    `election ${election.id} has schedule rule ${JSON.stringify(election.schedule_rule)}, which this generator ` +
      "cannot date a cycle from; add it to CYCLE_START_RULE rather than letting the backstop fall back to a guess",
  );
  const { year, rule: startRule } = rule(Number(election.date.slice(0, 4)));
  const start = electionDateForRule(year, startRule);
  invariant(start < election.date, `election ${election.id} would begin its own cycle on ${start}`);
  return start;
}

/**
 * The staleness backstop, in hours: this election's whole cycle.
 *
 * Deliberately loose, because `docs/BALLOT_INGESTION.md` settles what this
 * field is for. Stamp age does not decide publication --- two unchanged
 * sightings do --- and any limit tight enough to catch a genuinely stale
 * county rejects most of the state: on this survey the 70 enumerable counties'
 * stamps span 09/01 to 10/13 and the median is over a month old, so the 168h
 * this replaces admitted one county of seventy. What it still has to catch is
 * a snapshot of a different ballot, and a stamp predating the cycle is that.
 *
 * Measured against the source population in buildRefreshJobs, so a backstop
 * that would not admit the counties this config claims to run is refused.
 */
export function maxSourceAgeHoursFor(election) {
  const start = electionCycleStart(election);
  return (Date.parse(`${election.date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 3_600_000;
}

/**
 * Asserts every survey class that costs a hand decision names the field that
 * pays for it, so a new class cannot be read as costing nothing.
 */
export function assertDecisionClassesAccountedFor(classes = CONTEST_CLASSES) {
  for (const [name, { needs_hand_entry: needsHandEntry }] of Object.entries(classes)) {
    if (!needsHandEntry) continue;
    invariant(
      name in DECISION_FIELD_BY_CLASS,
      `contest survey class ${JSON.stringify(name)} costs a hand decision, but this generator does not know ` +
        "which decision field pays for it; add it to DECISION_FIELD_BY_CLASS",
    );
  }
}

/**
 * Every decision a county still owes before a refresh of it could complete.
 *
 * Not just office titles. A refresh projects jobs serially and nothing catches
 * a projection failure, so one county owing a statewide race mapping aborts
 * the run and writes no candidate file at all --- which is what made Harrison
 * worth measuring rather than reporting as zero backlog from the office titles
 * alone.
 *
 * Counted, not matched: the survey records how many contests of each class a
 * county printed, not their identities, so this can say a county owes one
 * statewide race mapping and cannot say the entry it has is for that contest.
 * The projector refuses a mapping whose fingerprint is not on the ballot, so
 * the wrong entry fails there; this exists to stop the missing one shipping.
 */
export function outstandingDecisions({ survey, patterns, corrections, locations, decisions }) {
  assertDecisionClassesAccountedFor();
  const pending = [];
  for (const countyId of Object.keys(survey.counties).sort()) {
    const countyName = countyNameFor(locations, countyId);
    const decision = decisions.counties[countyId] ?? {};

    // The two places the survey records a county's office titles, held to each
    // other. The backlog is counted from the shared index, so an index missing
    // a county reads as a county with no titles to label --- clean, and its job
    // aborts the run on the contest nothing mapped.
    const titles = surveyedTitlesFor(survey, countyId, survey.meta.election.id);
    const countyTitles = Object.keys(survey.counties[countyId].local_office_titles ?? {});
    invariant(
      countyTitles.length === titles.size && countyTitles.every((title) => titles.has(title)),
      `the contest survey records ${countyTitles.length} office title(s) for ${countyId} but its shared title ` +
        `index names ${titles.size}; re-run npm run survey:contests rather than counting the backlog from one of them`,
    );

    for (const title of titles) {
      if (officeFromTitle(title, { patterns, corrections, countyName })) continue;
      if (Object.hasOwn(decision.office_mappings ?? {}, title)) continue;
      pending.push({
        county: countyId,
        reason: `office title ${JSON.stringify(title)} has no pattern label and no reviewed mapping`,
      });
    }

    const owed = new Map();
    for (const [name, count] of Object.entries(survey.counties[countyId].classes ?? {})) {
      invariant(
        name in CONTEST_CLASSES,
        `the contest survey classes ${countyId} contests as ${JSON.stringify(name)}, which is not a known ` +
          "contest class; regenerate the survey rather than generating a config from a verdict nothing defines",
      );
      const field = DECISION_FIELD_BY_CLASS[name];
      if (field) owed.set(field, (owed.get(field) ?? 0) + count);
    }
    for (const [field, count] of [...owed].sort(([left], [right]) => left.localeCompare(right))) {
      const provided = Object.keys(decision[field] ?? {}).length;
      if (provided >= count) continue;
      pending.push({
        county: countyId,
        reason: `${count} surveyed contest(s) need a reviewed ${field} entry; the decisions file has ${provided}`,
      });
    }
  }
  return pending;
}

/**
 * The jobs the committed artifacts imply, in county order.
 *
 * Pure: every input is passed in, so `check-refresh-config.mjs` can recompute
 * this from the same committed files and compare. A config that does not match
 * what the artifacts imply is a config somebody edited.
 */
export function buildRefreshJobs({
  survey,
  patterns,
  corrections,
  locations,
  decisions,
  election,
  publishedCounties = {},
}) {
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
  invariant(surveyed.size > 0, "the contest survey measured no counties, so there is no config to generate");
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

  invariant(
    election?.id === electionId,
    `the election record is ${JSON.stringify(election?.id)}, not the ${electionId} the contest survey measured`,
  );
  const cycleStart = electionCycleStart(election);
  const maxSourceAgeHours = maxSourceAgeHoursFor(election);

  // The backstop measured against the population this config claims to run,
  // which is the check the typed 168 never had. A stamp predating the cycle is
  // a snapshot of a different election's ballot; nothing here can relabel it,
  // so name the counties rather than generate jobs that project from it.
  const cycleStartInstant = Date.parse(`${cycleStart}T00:00:00Z`);
  const surveyedSourceStamps = [...surveyed]
    .sort()
    .map((countyId) => {
      const sourceUpdatedAt = survey.counties[countyId].source_updated_at;
      const instant = Date.parse(sourceUpdatedAt);
      invariant(
        typeof sourceUpdatedAt === "string" && Number.isFinite(instant),
        `surveyed county ${countyId} needs a valid source_updated_at timestamp, not ${JSON.stringify(sourceUpdatedAt)}`,
      );
      invariant(
        SOURCE_STAMP.test(sourceUpdatedAt),
        `surveyed county ${countyId} records source_updated_at ${JSON.stringify(sourceUpdatedAt)} without an ` +
          "exact timezone, so which side of the cycle boundary it falls on depends on the machine reading it",
      );
      return { countyId, sourceUpdatedAt, instant };
    });
  const preCycle = surveyedSourceStamps.filter(({ instant }) => instant < cycleStartInstant);
  invariant(
    preCycle.length === 0,
    `${preCycle.length} surveyed county source stamp(s) predate this election's cycle, which began ${cycleStart}: ` +
      `${preCycle.map(({ countyId, sourceUpdatedAt }) => `${countyId} at ${sourceUpdatedAt}`).join(", ")}`,
  );

  // Published coverage this config has to stay able to reproduce. A county
  // reviewed at an age above the durable limit would fail check-refresh-config
  // after this file replaced the hand-written one, so refuse here with the
  // number a human has to decide about rather than quietly raising the limit.
  for (const [countyId, county] of Object.entries(publishedCounties)) {
    if (county?.coverage?.method !== "common_to_all_precincts") continue;
    const reviewedAt = county.coverage.source_age_hours_at_review;
    invariant(
      !Number.isFinite(reviewedAt) || reviewedAt <= maxSourceAgeHours,
      `${countyId} publishes generated coverage reviewed at ${reviewedAt}h, above the generated ` +
        `${maxSourceAgeHours}h backstop for an election whose cycle began ${cycleStart}; re-review the county`,
    );
  }

  // Checked for every surveyed county, not only the ones that get a job: a
  // redundant mapping inside a county left out for owing a decision is still a
  // second copy of a label the patterns own, and it would start publishing the
  // moment the decision it waits on is recorded.
  for (const countyId of [...surveyed].sort()) {
    const countyName = countyNameFor(locations, countyId);
    for (const title of Object.keys(decisions.counties[countyId]?.office_mappings ?? {})) {
      const derived = officeFromTitle(title, { patterns, corrections, countyName });
      invariant(
        !derived,
        `refresh decisions map ${JSON.stringify(title)} for ${countyId}, but the curated patterns already ` +
          `derive ${JSON.stringify(derived?.office)}; drop the decision rather than keeping a second copy of it`,
      );
    }
  }

  // A county still owing a decision is left out, not emitted. Its job would
  // project every statewide race and then throw on the contest nobody mapped,
  // and because refreshElections has no per-job recovery that aborts the whole
  // run and withholds the candidate file for every other county in it.
  const backlog = outstandingDecisions({ survey, patterns, corrections, locations, decisions });
  const blocked = new Set(backlog.map(({ county }) => county));
  for (const countyId of [...blocked].sort()) {
    invariant(
      publishedCounties[countyId]?.coverage?.method !== "common_to_all_precincts",
      `${countyId} publishes generated coverage but still owes a decision, so leaving it out would make its ` +
        "published record unreproducible; record the decision rather than dropping the job",
    );
  }

  const jobs = [];
  for (const countyId of [...surveyed].sort()) {
    if (blocked.has(countyId)) continue;
    const countyName = countyNameFor(locations, countyId);
    const decision = decisions.counties[countyId] ?? {};

    jobs.push({
      county: countyId,
      election: vendorKey,
      projection: {
        mode: "catalog",
        max_source_age_hours: maxSourceAgeHours,
        county_name: countyName,
        office_mappings: decision.office_mappings ?? {},
        statewide_race_mappings: decision.statewide_race_mappings ?? {},
        statewide_issue_mappings: decision.statewide_issue_mappings ?? {},
      },
    });
  }
  invariant(
    jobs.length > 0,
    `every one of the ${surveyed.size} surveyed counties owes a decision, so there is no job to generate: ` +
      `${backlog.map(({ county, reason }) => `${county}: ${reason}`).join("; ")}`,
  );
  return { vendorKey, electionId, jobs, backlog, cycleStart, maxSourceAgeHours };
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

    const election = elections.elections.find((candidate) => candidate.id === electionId);
    invariant(election, `elections data has no ${electionId}, whose cycle dates the staleness backstop`);
    const built = buildRefreshJobs({
      survey,
      patterns,
      corrections,
      locations,
      decisions,
      election,
      publishedCounties: election.counties ?? {},
    });
    const artifact = refreshConfigArtifact({
      ...built,
      generatedOn: args["generated-on"] ?? new Date().toISOString().slice(0, 10),
    });

    const out = args.out ? resolve(args.out) : `config/vtrapp-${vendorKey}.json`;
    await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`);

    const handEntries = built.jobs.filter((job) => Object.keys(job.projection.office_mappings).length > 0);
    const blocked = new Set(built.backlog.map(({ county }) => county));
    console.log(`Wrote ${out}: ${built.jobs.length} job(s) for ${electionId}.`);
    console.log(`  surveyed counties: ${Object.keys(survey.counties).length}`);
    console.log(`  source age backstop: ${built.maxSourceAgeHours}h, this election's cycle from ${built.cycleStart}`);
    console.log(`  counties needing a hand office mapping: ${handEntries.length}`);
    console.log(`  counties left out, still owing a decision: ${blocked.size}`);
    for (const { county, reason } of built.backlog) console.log(`    ${county}: ${reason}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
