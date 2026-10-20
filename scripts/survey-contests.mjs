// Re-derives what it costs to publish each enumerable county's ballot, by
// classifying every contest on it with the projector's own rules.
//
//   npm run survey:contests -- --election 20261103G
//
// The question is how much of a county's ballot the code can resolve with no
// hand-written decision, and that question has to be answered by an artifact
// rather than by a note. An earlier version of this survey was an ad-hoc script
// that printed a summary: the summary went into a research document, the script
// and its per-title data are gone, and re-deriving any figure in it costs
// another seventy-county walk. So the numbers are written to a committed file
// that `npm run check` validates, and the distinct local-office titles --- the
// population a title-pattern set would have to cover --- are written with them.
//
// **Every classification runs the projector's exported rules, never a copy.**
// A copy drifts, and a survey measuring a drifted copy reports coverage the
// projector does not have. That is why `project-vtrapp.mjs` exports them.
//
// Like the other vendor tools this talks to a live government server, costs one
// ballot walk per county, and is run by hand, never from CI.

import { appendFile, readFile, writeFile } from "node:fs/promises";

import {
  createVendorClient,
  electionIdFromKey,
  parseArgs,
  readFirstBallot,
  VendorTransportError,
} from "./ingest/vtrapp.mjs";
import {
  certifiedIssueText,
  possiblePublishedIssueMatch,
  possiblePublishedRaceMatches,
  publishedRaceMatch,
  statewideIssueTwinByText,
  statewideTwinByCandidates,
} from "./project-vtrapp.mjs";

export const CONTEST_SURVEY_SCHEMA_VERSION = 2;

/**
 * Every verdict this survey can reach, and whether it costs a hand decision.
 *
 * The split is the whole output of the survey, so it is declared once here
 * rather than inferred at each use. `needs_hand_entry` means a human must write
 * something into a config before that contest can be published --- not that the
 * contest is wrong.
 */
export const CONTEST_CLASSES = {
  statewide_race_resolved: { needs_hand_entry: false },
  statewide_issue_resolved_by_text: { needs_hand_entry: false },
  local_issue: { needs_hand_entry: false },
  local_office: { needs_hand_entry: true },
  statewide_race_needs_mapping: { needs_hand_entry: true },
  statewide_race_needs_decision: { needs_hand_entry: true },
  statewide_issue_needs_mapping: { needs_hand_entry: true },
};

/**
 * Classifies one contest exactly as `projectCounty` would decide it when the
 * county has no hand-written mappings at all.
 *
 * The order matters and mirrors the projector's: for an office, a published
 * statewide race identified by title AND candidates is removed automatically;
 * a title that merely resembles one is a loud refusal; a title that resembles
 * nothing but whose candidate set matches a statewide race is the refusal the
 * title rule cannot see. For an issue, certified ballot text decides first and
 * the title only produces a refusal, because the text is the stronger evidence.
 */
export function classifyContest(contest, { election, issueText = {} }) {
  if (contest.kind === "office") {
    const resolved = publishedRaceMatch(contest, election);
    if (resolved) return { class: "statewide_race_resolved", id: resolved };
    const possible = possiblePublishedRaceMatches(contest, election).map(({ id }) => id);
    if (possible.length > 0) return { class: "statewide_race_needs_mapping", id: possible.join(" or ") };
    const twin = statewideTwinByCandidates(contest, election);
    if (twin) return { class: "statewide_race_needs_decision", id: twin };
    return { class: "local_office", title: contest.title };
  }

  const byText = statewideIssueTwinByText(contest, issueText);
  if (byText) return { class: "statewide_issue_resolved_by_text", id: byText };
  const byTitle = possiblePublishedIssueMatch(contest, election);
  if (byTitle) return { class: "statewide_issue_needs_mapping", id: byTitle };
  return { class: "local_issue", title: contest.title };
}

export function surveyCounty(contests, { election, issueText }) {
  const classes = {};
  // Counted, not collected into a set. A county routinely prints one title
  // twice --- several seats of the same court, a full term beside an unexpired
  // one --- and a set of titles cannot say how many contests a title-pattern
  // set would cover. Fifty-eight of this election's local office instances are
  // a repeat of a title already on the same ballot.
  const localOfficeTitles = {};
  for (const contest of contests) {
    const verdict = classifyContest(contest, { election, issueText });
    classes[verdict.class] = (classes[verdict.class] ?? 0) + 1;
    if (verdict.class === "local_office") {
      localOfficeTitles[contest.title] = (localOfficeTitles[contest.title] ?? 0) + 1;
    }
  }
  return {
    classes,
    local_office_titles: Object.fromEntries(
      Object.entries(localOfficeTitles).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/**
 * Rolls the per-county records into the figures the survey exists to report.
 *
 * `automatable_share` counts contest INSTANCES, not distinct titles and not
 * counties. Those three answer different questions and the instance count is
 * the one that describes the ballot a voter sees; a survey that reported
 * distinct titles would make a title appearing in seventy counties look as
 * cheap as one appearing once.
 */
export function summarizeSurvey(counties, { failures = {}, enumerableCounties = null } = {}) {
  const classes = {};
  for (const record of Object.values(counties)) {
    for (const [name, count] of Object.entries(record.classes)) {
      classes[name] = (classes[name] ?? 0) + count;
    }
  }
  for (const name of Object.keys(CONTEST_CLASSES)) classes[name] ??= 0;

  const instances = Object.values(classes).reduce((total, count) => total + count, 0);
  const handEntries = Object.entries(classes)
    .filter(([name]) => CONTEST_CLASSES[name].needs_hand_entry)
    .reduce((total, [, count]) => total + count, 0);

  return {
    counties_read: Object.keys(counties).length,
    counties_failed: Object.keys(failures).length,
    counties_enumerable: enumerableCounties,
    contest_instances: instances,
    hand_entries: handEntries,
    automatable_instances: instances - handEntries,
    // Written as a string so the figure in the artifact is the figure quoted,
    // rather than a float a reader rounds differently from the next reader.
    automatable_share: instances === 0 ? "0.0%" : `${(((instances - handEntries) / instances) * 100).toFixed(1)}%`,
    classes,
  };
}

/**
 * The distinct local-office titles across every county, with how many counties
 * print each and how many contests they are.
 *
 * This is the population any title-pattern set has to cover, and the reason the
 * survey writes it rather than a count of it: a pattern set measured against a
 * number nobody can re-read is not measured.
 */
export function localOfficeTitleIndex(counties) {
  const index = {};
  for (const [countyId, record] of Object.entries(counties)) {
    for (const [title, count] of Object.entries(record.local_office_titles)) {
      index[title] ??= { counties: [], instances: 0 };
      index[title].counties.push(countyId);
      index[title].instances += count;
    }
  }
  return Object.fromEntries(
    Object.entries(index)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([title, record]) => [
        title,
        { county_count: record.counties.length, instances: record.instances, counties: record.counties.sort() },
      ]),
  );
}

/**
 * Reads the counties an earlier run of this election already walked.
 *
 * Keyed by election as well as county, because resuming one election's walk
 * from another's log would silently report contests from the wrong ballot. A
 * line that does not parse ends the read: a truncated final line is what a
 * killed process leaves behind, and guessing at it is how a half-written
 * county record gets counted as whole.
 */
export async function readPartial(path, electionKey) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const resumed = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`${path}: a partial survey line is not valid JSON; delete the file to start the walk over`);
    }
    if (entry.election !== electionKey) {
      throw new Error(`${path}: holds election ${entry.election}, not ${electionKey}`);
    }
    resumed[entry.county] = entry.record;
  }
  return resumed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const electionKey = args.election;
  if (!electionKey) throw new Error("--election <vendor key> is required, for example --election 20261103G");
  const limit = args.limit ? Number(args.limit) : null;
  // Seventy live county walks take longer than the things that can kill a
  // process, and three runs have now died partway through for reasons that had
  // nothing to do with the vendor. Each county is appended to a log as it is
  // read, so a rerun with the same --partial resumes rather than starting
  // over. Counties are still only ever written whole.
  const partialPath = args.partial ? new URL(args.partial, `file://${process.cwd()}/`) : null;
  // A partial run must not be able to overwrite the canonical artifact. The
  // statewide-issue generator learned this the hard way: every count in a
  // --limit run is internally consistent, so nothing downstream can tell it
  // apart from a full one.
  if (limit !== null && !args.out) {
    throw new Error("--limit only writes somewhere else: pass --out <path> as well");
  }

  const root = new URL("..", import.meta.url);
  const readJson = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
  const coverage = await readJson("data/vtrapp-coverage.json");
  const elections = await readJson("data/elections.json");
  const issueArtifact = await readJson("data/statewide-issue-text.json");

  const electionId = electionIdFromKey(electionKey);
  const election = elections.elections.find((candidate) => candidate.id === electionId);
  if (!election) throw new Error(`data/elections.json has no election ${electionId}`);
  const issueText = certifiedIssueText(issueArtifact);
  if (issueArtifact.meta.election.id !== electionId) {
    throw new Error(
      `the certified issue text is for ${issueArtifact.meta.election.id}, not ${electionId}; ` +
        "surveying with another election's text would misclassify every statewide issue",
    );
  }

  const enumerable = Object.entries(coverage.counties)
    .filter(([, record]) => record.enumerable === true)
    .map(([countyId]) => countyId);
  const counties = limit === null ? enumerable : enumerable.slice(0, limit);

  const client = createVendorClient();
  const surveyed = {};
  const failures = {};
  const resumed = partialPath ? await readPartial(partialPath, electionKey) : {};
  for (const [index, countyId] of counties.entries()) {
    if (resumed[countyId]) {
      surveyed[countyId] = resumed[countyId];
      process.stderr.write(`[${index + 1}/${counties.length}] ${countyId} (resumed)\n`);
      continue;
    }
    process.stderr.write(`[${index + 1}/${counties.length}] ${countyId}\n`);
    let record = null;
    try {
      const read = await readFirstBallot({ client, countyId, electionKey });
      record = {
        precinct: read.precinct.id,
        precincts_listed: read.precincts_listed,
        contests_read: read.contests.length,
        source_updated_at: read.source_updated_at,
        ...surveyCounty(read.contests, { election, issueText }),
      };
      surveyed[countyId] = record;
    } catch (error) {
      // Recorded per county. One propagated timeout has ended a whole-state run
      // here twice, and a run that dies at county 60 has measured nothing.
      failures[countyId] = error instanceof VendorTransportError ? `transport: ${error.message}` : error.message;
    }
    // Only successes are logged. A failure is not resumable state: it may have
    // been the vendor having a moment, and a rerun must be free to try again.
    if (partialPath && record) {
      await appendFile(partialPath, `${JSON.stringify({ election: electionKey, county: countyId, record })}\n`);
    }
    await client.pause();
  }

  const summary = summarizeSurvey(surveyed, { failures, enumerableCounties: enumerable.length });
  const artifact = {
    meta: {
      schema_version: CONTEST_SURVEY_SCHEMA_VERSION,
      generated_by: "scripts/survey-contests.mjs",
      generated_on: new Date().toISOString().slice(0, 10),
      note: "Generated file. Do not hand-edit; re-run npm run survey:contests.",
      vendor_base: client.base,
      election: { id: election.id, vendor_key: electionKey },
      method:
        "One ballot per county, every contest classified by the projector's exported rules with no hand-written " +
        "mappings. Undercounts within a county: precincts differ by district and by local issue, so these are not " +
        "county coverage figures.",
      // Which certified text produced the issue verdicts. Without it, a
      // re-run against a re-generated artifact looks like the same measurement.
      certified_issue_text: Object.fromEntries(
        Object.entries(issueArtifact.issues).map(([id, record]) => [id, record.body_sha256]),
      ),
      summary,
      failures,
    },
    local_office_titles: localOfficeTitleIndex(surveyed),
    counties: surveyed,
  };

  const out = args.out ? new URL(args.out, `file://${process.cwd()}/`) : new URL("data/vtrapp-contest-survey.json", root);
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `${summary.contest_instances} contest instance(s) over ${summary.counties_read} county(ies): ` +
      `${summary.automatable_instances} need no hand entry (${summary.automatable_share}), ` +
      `${summary.hand_entries} do, ${Object.keys(artifact.local_office_titles).length} distinct local office title(s).`,
  );
  if (Object.keys(failures).length > 0) {
    console.log(`${Object.keys(failures).length} county(ies) failed: ${Object.keys(failures).join(", ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
