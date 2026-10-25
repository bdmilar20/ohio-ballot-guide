import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertExactBallotData } from "../src/exact-ballot.mjs";
import { officeLabeller, readPatterns } from "./map-office-titles.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function comparable(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

export function catalogOfficeLabeller(offices, { allowedTitles }) {
  invariant(offices && typeof offices === "object" && !Array.isArray(offices), "office catalog must be an object");
  invariant(allowedTitles instanceof Set, "catalog office labeller needs measured titles");
  const byTitle = new Map();
  for (const [officeId, office] of Object.entries(offices)) {
    invariant(office && typeof office.title === "string" && office.title.trim(), `office ${officeId} needs a title`);
    const key = comparable(office.title);
    invariant(!byTitle.has(key), `office catalog repeats the title ${office.title}`);
    byTitle.set(key, { office_id: officeId, office: office.title });
  }
  return (printed) => {
    if (!allowedTitles.has(printed)) return null;
    const withoutFor = printed.replace(/^For\s+(?:the\s+)?/i, "");
    if (withoutFor === printed) return null;
    return byTitle.get(comparable(withoutFor)) ?? null;
  };
}

function combinedOfficeLabeller(...labellers) {
  return (title) => {
    const labels = labellers.map((label) => label(title)).filter(Boolean);
    const distinct = new Map(labels.map((label) => [`${label.office_id}\0${label.office}`, label]));
    invariant(distinct.size <= 1, `office title ${JSON.stringify(title)} has conflicting catalog and pattern labels`);
    return distinct.values().next().value ?? null;
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function projectionConfig(config, snapshot) {
  if (!Array.isArray(config?.jobs)) return config?.projection ?? config;
  const matches = config.jobs.filter(
    (job) => job?.county === snapshot.county.id &&
      String(job?.election ?? "").toUpperCase() === snapshot.election.vendor_key.toUpperCase(),
  );
  invariant(
    matches.length === 1,
    `refresh config needs exactly one job for ${snapshot.county.id} ${snapshot.election.vendor_key}`,
  );
  return matches[0].projection;
}

export async function projectExactFromArgs(args, { certifiedIssueText, projectExactBallotBundle }) {
  if (!args.snapshot) throw new Error("--snapshot is required");
  if (!args.elections) throw new Error("--elections is required in --exact mode");
  if (!args.config) throw new Error("--config is required in --exact mode");

  const snapshot = await readJson(args.snapshot);
  const electionData = await readJson(args.elections);
  const election = electionData?.elections?.find(({ id }) => id === snapshot.election.id);
  invariant(election, `election ${snapshot.election.id} is absent from --elections data`);
  const config = projectionConfig(await readJson(args.config), snapshot);
  invariant(config && typeof config === "object", "exact projection config must be an object");

  const issueTextPath = args["issue-text"]
    ?? fileURLToPath(new URL("../data/statewide-issue-text.json", import.meta.url));
  const officePatternsPath = args["office-title-patterns"]
    ?? fileURLToPath(new URL("../data/office-title-patterns.json", import.meta.url));
  const officesPath = args.offices
    ?? fileURLToPath(new URL("../data/offices.json", import.meta.url));
  const patterns = readPatterns(await readJson(officePatternsPath));
  const officeData = await readJson(officesPath);
  const measuredOfficeTitles = new Set(
    Object.values(snapshot.ballots)
      .flatMap(({ contests }) => contests)
      .filter(({ kind }) => kind === "office")
      .flatMap(({ title, subtitles }) => [title, ...subtitles]),
  );
  const patternLabeller = officeLabeller({
    ...patterns,
    countyName: config.county_name,
    // The complete snapshot itself measured every title this exact bundle can
    // contain, so no separate one-precinct survey is needed here.
    allowedTitles: measuredOfficeTitles,
  });
  const catalogLabeller = catalogOfficeLabeller(officeData.offices, {
    allowedTitles: measuredOfficeTitles,
  });
  const reviewedAt = args["reviewed-at"] ? new Date(args["reviewed-at"]) : new Date();
  const bundle = await projectExactBallotBundle(snapshot, election, {
    maxSourceAgeHours: config.max_source_age_hours,
    officeMappings: config.office_mappings,
    statewideRaceMappings: config.statewide_race_mappings,
    statewideIssueMappings: config.statewide_issue_mappings,
    statewideIssueText: certifiedIssueText(await readJson(issueTextPath)),
    labelOffice: combinedOfficeLabeller(patternLabeller, catalogLabeller),
    countyName: config.county_name,
    reviewedAt,
  });

  let artifact = { ballot_bundle: bundle };
  if (args["address-index"]) {
    const addressIndex = await readJson(args["address-index"]);
    await assertExactBallotData(addressIndex, bundle);
    artifact = { address_index: addressIndex, ballot_bundle: bundle };
  }

  const output = `${JSON.stringify(artifact, null, 2)}\n`;
  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, output);
    console.log(
      `Wrote ${args.out}: ${bundle.precincts.length} precincts, ${Object.keys(bundle.ballots).length} exact ballots${args["address-index"] ? ", address index attached" : ", bundle only"}`,
    );
  } else {
    process.stdout.write(output);
  }
  return artifact;
}
