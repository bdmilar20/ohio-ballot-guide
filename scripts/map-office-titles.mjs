// Labels the office a county's ballot prints, without a per-county mapping.
//
//   npm run map:offices
//
// Publishing a county office needs two things the vendor does not give us: the
// id of a published office description, and a name to show the voter. Until
// now both came from a hand-written `office_mappings` entry per county per
// title, which is why `data/vtrapp-contest-survey.json` measures every one of
// the 567 local-office instances it found as a hand entry. Onboarding a county
// meant writing its table out by hand.
//
// It does not have to. The survey's title population says the titles decompose
// into a small set of offices plus a qualifier --- a district, a court
// division, a term --- that the county prints and we should keep verbatim. So
// the office is curated once for the whole state in
// `data/office-title-patterns.json`, and the qualifier is carried through
// untouched.
//
// **A title this cannot label is a refusal, not a guess.** No fuzzy matching,
// no stemming, no edit distance. Two of the surveyed titles are misspellings in
// the county's own data (`For County Comissioner`, `(4th Distrit)`); they are
// listed whole as corrections rather than absorbed by a loose rule, because a
// rule loose enough to catch them is loose enough to label an office wrong, and
// a wrong office label on a ballot page is a voter-facing error.

import { readFile } from "node:fs/promises";

import { CONTEST_SURVEY_SCHEMA_VERSION } from "./survey-contests.mjs";

export const OFFICE_TITLE_PATTERNS_SCHEMA_VERSION = 1;

/**
 * Reads the curated pattern file and checks the shape every caller depends on.
 *
 * Done here rather than at each use because `officeFromTitle` runs inside the
 * projector, where a malformed pattern would otherwise surface as a missing
 * label on a published ballot rather than as a refusal to publish.
 */
export function readPatterns(artifact) {
  if (artifact?.meta?.schema_version !== OFFICE_TITLE_PATTERNS_SCHEMA_VERSION) {
    throw new Error(
      `office title patterns must be schema ${OFFICE_TITLE_PATTERNS_SCHEMA_VERSION}, not ${artifact?.meta?.schema_version}`,
    );
  }
  const patterns = artifact.patterns ?? [];
  const corrections = artifact.corrections ?? [];
  if (typeof artifact.meta.last_verified !== "string") {
    throw new Error("office title patterns need meta.last_verified: they are curated, so someone has to own the date");
  }
  const seen = new Set();
  for (const pattern of patterns) {
    if (!pattern.printed || !pattern.office_id || !pattern.office) {
      throw new Error(`office title pattern ${JSON.stringify(pattern)} needs printed, office_id and office`);
    }
    if (seen.has(pattern.printed)) {
      throw new Error(`office title pattern "${pattern.printed}" is listed twice; one printed phrase, one office`);
    }
    seen.add(pattern.printed);
  }
  const correctionSeen = new Set();
  for (const correction of corrections) {
    if (!correction.printed || !correction.read_as) {
      throw new Error(`office title correction ${JSON.stringify(correction)} needs printed and read_as`);
    }
    if (correction.printed === correction.read_as) {
      throw new Error(`office title correction "${correction.printed}" corrects nothing`);
    }
    if (correctionSeen.has(correction.printed)) {
      throw new Error(`office title correction "${correction.printed}" is listed twice`);
    }
    correctionSeen.add(correction.printed);
  }
  return { meta: artifact.meta, patterns, corrections };
}

/**
 * Strips the parts of a printed title that are not the office: the "For" every
 * board prints, and the county's own name where it prefixes its own office.
 *
 * Clinton prints "For Clinton County Auditor" where sixty-five counties print
 * "For County Auditor". Removing the ballot's own county name is a rule about
 * the county being read, not a pattern --- which is why it needs the county
 * name passed in and refuses to remove any other county's.
 */
export function officePhrase(title, { countyName = null } = {}) {
  const withoutFor = title.replace(/^For\s+(?:the\s+)?/i, "");
  if (withoutFor === title) return null;
  if (countyName && withoutFor.startsWith(`${countyName} County `)) {
    return withoutFor.slice(`${countyName} `.length);
  }
  return withoutFor;
}

/**
 * The office description and display name for one printed title, or null.
 *
 * The longest matching phrase wins, and it must end on a word boundary: "For
 * Coroner" and "For County Coroner" are both the county coroner, but "Auditor"
 * must not claim a title that merely starts with the letters.
 *
 * Whatever follows the office phrase is the county's own qualifier and is kept
 * exactly as printed. A district, a court division, and a term qualifier are
 * the difference between two seats on one ballot, so dropping one would show a
 * voter two contests with the same name and no way to tell them apart.
 *
 * **The qualifier must be parenthesised, or there must be none.** Accepting
 * free text after a known phrase is not conservative, it is the opposite:
 * `For Mayor and County Commissioner` would have published under `mayor`, and
 * `For County Auditor and Treasurer` under `county-auditor`, from a single
 * changed vendor title and with no explicit mapping anywhere. The five titles
 * whose qualifier the counties did not parenthesise are listed as whole
 * printed phrases instead, which is a decision someone made about a title
 * that exists rather than a rule about titles that do not.
 */
const PARENTHESISED_QUALIFIER = /^(?:\([^()]*\)\s*)*$/;
export function officeFromTitle(title, { patterns = [], corrections = [], countyName = null } = {}) {
  const correction = corrections.find((entry) => entry.printed === title);
  const corrected = correction ? correction.read_as : title;
  const phrase = officePhrase(corrected, { countyName });
  if (!phrase) return null;

  let best = null;
  for (const pattern of patterns) {
    const printed = pattern.printed;
    if (phrase !== printed && !phrase.startsWith(`${printed} `)) continue;
    if (!best || printed.length > best.printed.length) best = pattern;
  }
  if (!best) return null;

  const qualifier = phrase.slice(best.printed.length).trim().replace(/\s+/g, " ");
  if (!PARENTHESISED_QUALIFIER.test(qualifier)) return null;
  return {
    office_id: best.office_id,
    office: qualifier ? `${best.office} ${qualifier}` : best.office,
    matched: best.printed,
    corrected: Boolean(correction),
  };
}

/**
 * The office labels the curated patterns can derive for one county, from the
 * titles the survey recorded that county printing.
 *
 * This is what lets a county be onboarded with an empty `office_mappings`:
 * `check-refresh-config.mjs` requires every published office to be
 * reproducible from the durable job, and a label derived from a measured title
 * is reproducible in exactly the way a hand-written mapping is.
 */
export function derivableOfficeLabels(survey, { patterns, corrections, countyId, countyName, electionId }) {
  const labels = new Set();
  for (const title of surveyedTitlesFor(survey, countyId, electionId)) {
    const labelled = officeFromTitle(title, { patterns, corrections, countyName });
    if (labelled) labels.add(`${labelled.office_id}\0${labelled.office}`);
  }
  return labels;
}

/**
 * Runs every title the survey found through the mapper and reports what it
 * covers --- in contest instances, because that is the figure the survey
 * reports and the one that describes the ballot a voter sees.
 *
 * A pattern set is only as good as the population it was measured against, so
 * this reads the generated survey rather than a list kept beside the patterns.
 */
export function measureCoverage(survey, { patterns, corrections, countyNameFor }) {
  // The instance counts this reports come from the survey's title index, which
  // only carries them from schema 2 on. Reading an older artifact produced a
  // coverage figure of NaN and still exited zero.
  if (survey?.meta?.schema_version !== CONTEST_SURVEY_SCHEMA_VERSION) {
    throw new Error(
      `the contest survey must be schema ${CONTEST_SURVEY_SCHEMA_VERSION} to measure instance coverage, ` +
        `not ${survey?.meta?.schema_version}; re-run npm run survey:contests`,
    );
  }
  const labelled = [];
  const unlabelled = [];
  const used = new Set();
  for (const [title, record] of Object.entries(survey.local_office_titles)) {
    // One county's name cannot label another county's title, so a title is
    // covered only when every county printing it maps.
    const results = record.counties.map((countyId) =>
      officeFromTitle(title, { patterns, corrections, countyName: countyNameFor(countyId) }),
    );
    if (results.every((result) => result !== null)) {
      labelled.push({
        title,
        counties: record.counties,
        instances: record.instances,
        office: results[0].office,
        office_id: results[0].office_id,
      });
      for (const result of results) used.add(result.matched);
    } else {
      // Only the counties that could not read the title, because those are
      // the ones a reader has to go and look at.
      unlabelled.push({ title, counties: record.counties.filter((countyId, index) => results[index] === null) });
    }
  }

  // Instances, from the survey's own per-title count. A county prints some
  // titles more than once, so counting the counties that print a title
  // understates what labelling it covers by fifty-eight contests statewide.
  const instancesFor = (titles) => titles.reduce((total, entry) => total + entry.instances, 0);
  const localOfficeInstances = Object.values(survey.counties).reduce(
    (total, record) => total + (record.classes.local_office ?? 0),
    0,
  );
  return {
    titles_total: Object.keys(survey.local_office_titles).length,
    titles_labelled: labelled.length,
    local_office_instances: localOfficeInstances,
    instances_labelled: instancesFor(labelled),
    patterns_unused: patterns.map((pattern) => pattern.printed).filter((printed) => !used.has(printed)),
    labelled: labelled.sort((left, right) => left.title.localeCompare(right.title)),
    unlabelled: unlabelled.sort((left, right) => left.title.localeCompare(right.title)),
  };
}

/**
 * The county name as the published data spells it, which is the same name the
 * refresh config is required to pass the projector. Derived rather than
 * capitalised from the id so that "van-wert" and any future county whose name
 * is not a capitalised id read correctly.
 */
export function countyNamesFrom(locations) {
  return Object.fromEntries(
    Object.entries(locations.counties).map(([countyId, county]) => [countyId, county.name.replace(/ County$/, "")]),
  );
}

/**
 * The office labeller to hand `projectCounty`, bound to one county.
 *
 * The projector takes a function rather than importing this module so that it
 * keeps no opinion about where a label comes from, and so that an explicit
 * mapping in the refresh config still wins over a pattern.
 */
export function officeLabeller({ patterns, corrections, countyName, allowedTitles }) {
  // Required, not defaulted. The safe value is a set, so a caller that forgets
  // it must say so rather than get the permissive behaviour for free.
  if (allowedTitles !== null && !(allowedTitles instanceof Set)) {
    throw new Error("officeLabeller needs allowedTitles: a Set of measured titles, or null to accept any title");
  }
  return (title) => {
    // A title the committed survey never saw this county print has had no
    // measurement and no review. Labelling it would mean publishing an office
    // on evidence that does not exist yet.
    if (allowedTitles && !allowedTitles.has(title)) return null;
    const labelled = officeFromTitle(title, { patterns, corrections, countyName });
    return labelled ? { office_id: labelled.office_id, office: labelled.office } : null;
  };
}

/**
 * The local office titles the committed survey saw one county print on one
 * election's ballot.
 *
 * Scoped to the election as well as the county, because a ballot is an
 * election's ballot. A primary and a general print different offices, and a
 * survey of one is no measurement of the other: read without this check, a
 * March primary survey authorised `For County Auditor` for a November job.
 * `electionId` is required for the same reason `allowedTitles` is --- the safe
 * value must be asked for, not arrived at by forgetting.
 */
export function surveyedTitlesFor(survey, countyId, electionId) {
  if (typeof electionId !== "string" || !electionId) {
    throw new Error("surveyedTitlesFor needs the election id the titles are being authorized for");
  }
  // No survey, or a survey of another election, measured nothing about this
  // ballot. An empty set labels nothing and the projector refuses, which is
  // the outcome a missing measurement should produce.
  if (survey?.meta?.election?.id !== electionId) return new Set();
  return new Set(
    Object.entries(survey.local_office_titles ?? {})
      .filter(([, record]) => record.counties.includes(countyId))
      .map(([title]) => title),
  );
}

async function main() {
  const root = new URL("..", import.meta.url);
  const readJson = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
  const { patterns, corrections } = readPatterns(await readJson("data/office-title-patterns.json"));
  const survey = await readJson("data/vtrapp-contest-survey.json");
  const countyNames = countyNamesFrom(await readJson("data/locations.json"));

  const coverage = measureCoverage(survey, {
    patterns,
    corrections,
    countyNameFor: (countyId) => countyNames[countyId],
  });
  const share = (part, whole) => (whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`);
  console.log(
    `${coverage.titles_labelled} of ${coverage.titles_total} distinct local office title(s) labelled, ` +
      `${coverage.instances_labelled} of ${coverage.local_office_instances} instance(s) ` +
      `(${share(coverage.instances_labelled, coverage.local_office_instances)}).`,
  );
  const surveyed = survey.meta.summary;
  const automatable = surveyed.automatable_instances + coverage.instances_labelled;
  console.log(
    `Across the whole surveyed ballot that moves ${surveyed.automatable_share} -> ` +
      `${share(automatable, surveyed.contest_instances)} of ${surveyed.contest_instances} contest instance(s).`,
  );
  for (const entry of coverage.unlabelled) {
    console.log(`UNLABELLED  ${entry.title}  (${entry.counties.join(", ")})`);
  }
  for (const printed of coverage.patterns_unused) {
    console.log(`UNUSED      ${printed}`);
  }
  if (coverage.unlabelled.length > 0 || coverage.patterns_unused.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
