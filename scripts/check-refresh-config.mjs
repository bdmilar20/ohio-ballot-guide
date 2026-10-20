// Validates the durable projection decisions that make a county refresh
// repeatable. A generated county in published data without a tracked job means
// its next refresh would depend on reconstructing choices from a past review.

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { electionIdFromKey } from "./ingest/vtrapp.mjs";
import { derivableOfficeLabels, readPatterns } from "./map-office-titles.mjs";
import { validateRefreshManifest } from "./refresh-vtrapp.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedOfficeMapping(source, mapping, label) {
  if (typeof mapping === "string") {
    invariant(mapping, `${label} must name an office id`);
    return { officeId: mapping, office: source.replace(/^For\s+/i, "") };
  }
  invariant(isRecord(mapping), `${label} must be an office id or an object`);
  invariant(typeof mapping.office_id === "string" && mapping.office_id, `${label} needs office_id`);
  invariant(typeof mapping.office === "string" && mapping.office, `${label} needs the published office label`);
  return { officeId: mapping.office_id, office: mapping.office };
}

function validateTargetMappings(mappings, targets, label) {
  for (const [source, target] of Object.entries(mappings)) {
    invariant(source, `${label} has an empty source identity`);
    invariant(typeof target === "string" && target, `${label} mapping ${JSON.stringify(source)} needs a target id`);
    invariant(targets.has(target), `${label} mapping ${JSON.stringify(source)} targets missing id ${JSON.stringify(target)}`);
  }
}

function expectedCountyName(location) {
  return location.name.replace(/ County$/, "");
}

export function validateRefreshConfigs({
  configs,
  electionData,
  locations,
  offices,
  statewideIssueText,
  contestSurvey = null,
  officeTitlePatterns = { patterns: [], corrections: [] },
}) {
  invariant(Array.isArray(configs), "refresh configs must be an array");
  invariant(isRecord(locations?.counties), "locations data needs a counties object");
  invariant(isRecord(offices?.offices), "offices data needs an offices object");
  invariant(Array.isArray(electionData?.elections), "elections data needs an elections array");
  invariant(isRecord(statewideIssueText?.issues), "statewide issue text needs an issues object");

  const elections = new Map(electionData.elections.map((election) => [election.id, election]));
  const officeIds = new Set(Object.keys(offices.offices));
  const jobs = new Map();

  for (const config of configs) {
    invariant(typeof config.name === "string" && config.name, "each refresh config needs a filename");
    const manifest = validateRefreshManifest(config.manifest);
    const vendorKeys = new Set(manifest.jobs.map((job) => job.election.toUpperCase()));
    invariant(vendorKeys.size === 1, `${config.name} must contain jobs for exactly one vendor election`);
    const [vendorKey] = vendorKeys;
    invariant(
      config.name === `vtrapp-${vendorKey}.json`,
      `${config.name} must be named vtrapp-${vendorKey}.json for the election it refreshes`,
    );

    for (const job of manifest.jobs) {
      const label = `${config.name} job ${job.county}:${job.election}`;
      const location = locations.counties[job.county];
      invariant(location, `${label} names a county absent from locations data`);
      invariant(
        job.projection.county_name === expectedCountyName(location),
        `${label} county_name must be ${JSON.stringify(expectedCountyName(location))}`,
      );

      const electionId = electionIdFromKey(job.election);
      const election = elections.get(electionId);
      invariant(election, `${label} maps to election ${electionId}, which is absent from elections data`);

      for (const field of ["office_mappings", "statewide_race_mappings", "statewide_issue_mappings"]) {
        invariant(isRecord(job.projection[field]), `${label} must explicitly record ${field}`);
      }

      const mappedOffices = new Set();
      for (const [source, mapping] of Object.entries(job.projection.office_mappings)) {
        invariant(source, `${label} has an empty office source identity`);
        const { officeId, office } = normalizedOfficeMapping(
          source,
          mapping,
          `${label} office mapping ${JSON.stringify(source)}`,
        );
        invariant(officeIds.has(officeId), `${label} office mapping ${JSON.stringify(source)} targets missing office ${JSON.stringify(officeId)}`);
        mappedOffices.add(`${officeId}\0${office}`);
      }

      // A label the curated patterns derive from a title the survey measured
      // this county printing is reproducible in the same sense a hand-written
      // mapping is, and it is what lets a new county be onboarded without one.
      // Scoped to this job's election: another election's survey is not a
      // measurement of this ballot, and authorising from one would let a
      // primary's titles stand in for a general's.
      for (const label of derivableOfficeLabels(contestSurvey, {
        ...officeTitlePatterns,
        countyId: job.county,
        countyName: expectedCountyName(location),
        electionId,
      })) {
        mappedOffices.add(label);
      }

      validateTargetMappings(
        job.projection.statewide_race_mappings,
        new Set((election.statewide_races ?? []).map(({ id }) => id)),
        `${label} statewide race`,
      );
      validateTargetMappings(
        job.projection.statewide_issue_mappings,
        new Set((election.issues ?? []).map(({ id }) => id)),
        `${label} statewide issue`,
      );
      const mappedStatewideIssues = new Set(Object.values(job.projection.statewide_issue_mappings));
      for (const issue of election.issues ?? []) {
        const certified = statewideIssueText.meta?.election?.id === electionId
          && statewideIssueText.issues[issue.id]?.counties?.includes(job.county);
        invariant(
          mappedStatewideIssues.has(issue.id) || certified,
          `${label} cannot reproduce removal of statewide issue ${issue.id}; ` +
            "add a reviewed mapping or regenerate certified statewide issue text for this county",
        );
      }

      const identity = `${electionId}\0${job.county}`;
      const existing = jobs.get(identity);
      invariant(!existing, `${label} duplicates the durable job in ${existing?.configName}`);
      jobs.set(identity, { configName: config.name, job, mappedOffices });
    }
  }

  let generatedCounties = 0;
  for (const election of electionData.elections) {
    for (const [countyId, county] of Object.entries(election.counties ?? {})) {
      if (county.coverage?.method !== "common_to_all_precincts") continue;
      generatedCounties += 1;
      const label = `${election.id}:${countyId}`;
      const durable = jobs.get(`${election.id}\0${countyId}`);
      invariant(durable, `${label} is generated ballot coverage but has no durable refresh job`);
      invariant(
        durable.job.projection.max_source_age_hours >= county.coverage.source_age_hours_at_review,
        `${label} was reviewed at age ${county.coverage.source_age_hours_at_review}h, above its durable ${durable.job.projection.max_source_age_hours}h limit`,
      );
      for (const race of county.races ?? []) {
        invariant(
          durable.mappedOffices.has(`${race.office_id}\0${race.office}`),
          `${label} publishes office ${JSON.stringify(race.office_id)} but its durable job cannot reproduce that mapping`,
        );
      }
    }
  }

  return { configs: configs.length, jobs: jobs.size, generated_counties: generatedCounties };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadRefreshConfigs(directory) {
  const names = (await readdir(directory))
    .filter((name) => /^vtrapp-[A-Za-z0-9]+\.json$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => ({ name, manifest: await readJson(join(directory, name)) })));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const [configDirectory, electionsPath, locationsPath, officesPath, statewideIssuePath, contestSurveyPath, officeTitlePatternPath] =
      process.argv.slice(2);
    const result = validateRefreshConfigs({
      configs: await loadRefreshConfigs(resolve(configDirectory ?? join(projectRoot, "config"))),
      electionData: await readJson(resolve(electionsPath ?? join(projectRoot, "data", "elections.json"))),
      locations: await readJson(resolve(locationsPath ?? join(projectRoot, "data", "locations.json"))),
      offices: await readJson(resolve(officesPath ?? join(projectRoot, "data", "offices.json"))),
      statewideIssueText: await readJson(
        resolve(statewideIssuePath ?? join(projectRoot, "data", "statewide-issue-text.json")),
      ),
      contestSurvey: await readJson(
        resolve(contestSurveyPath ?? join(projectRoot, "data", "vtrapp-contest-survey.json")),
      ),
      officeTitlePatterns: readPatterns(
        await readJson(resolve(officeTitlePatternPath ?? join(projectRoot, "data", "office-title-patterns.json"))),
      ),
    });
    console.log(
      `Refresh configs valid: ${result.configs} config(s), ${result.jobs} job(s), ` +
      `${result.generated_counties} generated county record(s) reproducible.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
