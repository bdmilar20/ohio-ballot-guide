// Projects a complete precinct-level vtrapp snapshot into the deliberately
// smaller county view the current product can publish safely.
//
// The projection includes only normalized contest content that appears on
// every enumerated precinct ballot. It emits a review artifact first; it never
// edits data/elections.json directly.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ballotId, parseArgs, SCHEMA_VERSION as SNAPSHOT_SCHEMA_VERSION } from "./ingest/vtrapp.mjs";

export const PROJECTION_SCHEMA_VERSION = 2;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Per-precinct position and provenance describe where a contest was printed,
// not which contest it is. Every content field still participates by default,
// so adding normalized content cannot silently fall outside the projection
// hash.
const NON_CONTENT_CONTEST_FIELDS = new Set(["order", "source_url"]);

function officeChoicePairs(contest) {
  invariant(Array.isArray(contest.choices), `office contest "${contest.title}" needs choices`);
  invariant(
    Array.isArray(contest.raw?.choice_lines) && contest.raw.choice_lines.length === contest.choices.length,
    `office contest "${contest.title}" needs one raw choice line group per choice`,
  );

  return contest.choices
    .map((choice, index) => ({ choice, raw_choice_lines: contest.raw.choice_lines[index] }))
    .sort((left, right) => {
      const leftChoice = left.choice;
      const rightChoice = right.choice;
      const leftKey = `${leftChoice.write_in ? "1" : "0"}\0${comparable(leftChoice.name)}\0${comparable(leftChoice.party)}\0${canonicalString(left)}`;
      const rightKey = `${rightChoice.write_in ? "1" : "0"}\0${comparable(rightChoice.name)}\0${comparable(rightChoice.party)}\0${canonicalString(right)}`;
      return compareKeys(leftKey, rightKey);
    });
}

function contestIdentityContent(contest) {
  const content = structuredClone(
    Object.fromEntries(
      Object.entries(contest).filter(([key]) => !NON_CONTENT_CONTEST_FIELDS.has(key)),
    ),
  );

  // ORC 3505.03 rotates candidate names between precinct ballots. `choices`
  // and `raw.choice_lines` are two representations of that same presentation
  // order, so they have to move together. Issue choices remain order-sensitive:
  // the statute rotates candidates, not FOR/AGAINST or YES/NO responses.
  if (content.kind === "office") {
    const pairs = officeChoicePairs(content);
    content.choices = pairs.map(({ choice }) => choice);
    content.raw.choice_lines = pairs.map(({ raw_choice_lines: lines }) => lines);
  }

  return content;
}

/**
 * Fingerprints contest identity. Source position, URL, and the legally rotated
 * order of candidates may differ by precinct while the contest itself is the
 * same. Titles are not identities: every other normalized content field still
 * participates, including issue text and candidate raw lines.
 */
export function contestContentId(contest) {
  return hash(contestIdentityContent(contest));
}

function timestamp(value, label) {
  const instant = Date.parse(value);
  invariant(Number.isFinite(instant), `${label} must be an ISO timestamp`);
  return instant;
}

function ohioDate(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function assertCompleteSnapshot(snapshot) {
  invariant(
    snapshot?.schema_version === SNAPSHOT_SCHEMA_VERSION,
    `snapshot.schema_version must be ${SNAPSHOT_SCHEMA_VERSION}`,
  );
  invariant(snapshot.election?.id && snapshot.election?.vendor_key, "snapshot needs an election identity");
  invariant(snapshot.county?.id && snapshot.county?.vendor_slug, "snapshot needs a county identity");
  invariant(snapshot.source?.listing_url, "snapshot needs source.listing_url");
  const sourceUpdatedAt = timestamp(snapshot.source?.source_updated_at, "snapshot.source.source_updated_at");
  const fetchedAt = timestamp(snapshot.source?.fetched_at, "snapshot.source.fetched_at");
  invariant(fetchedAt >= sourceUpdatedAt, "snapshot was fetched before its source update time");
  invariant(Number.isFinite(snapshot.source?.source_age_hours), "snapshot needs a finite source age");
  invariant(snapshot.source.source_age_hours >= 0, "snapshot source age cannot be negative");
  const recordedAge = Number(((fetchedAt - sourceUpdatedAt) / 3_600_000).toFixed(1));
  invariant(
    recordedAge === snapshot.source.source_age_hours,
    `snapshot source age ${snapshot.source.source_age_hours}h disagrees with its timestamps (${recordedAge}h)`,
  );
  invariant(Array.isArray(snapshot.enumeration?.skipped), "snapshot.enumeration.skipped must be an array");
  invariant(snapshot.enumeration.skipped.length === 0, "snapshot contains skipped precinct rows");
  // Every ingest gate has to hold at this boundary too: a snapshot read from
  // disk was not necessarily produced by the adapter in this working tree.
  // Without this, a snapshot whose results table carried an unparsed row --- a
  // pager, a repeated header --- projects as if its precinct list were the
  // whole county, and intersecting over fewer precincts admits *more* content
  // as common to all of them. Absence is missing evidence, not agreement.
  invariant(
    Array.isArray(snapshot.enumeration?.unexplained_rows),
    "snapshot.enumeration.unexplained_rows must be an array",
  );
  invariant(
    snapshot.enumeration.unexplained_rows.length === 0,
    "snapshot contains results-table rows the adapter did not parse",
  );
  invariant(Array.isArray(snapshot.precincts), "snapshot.precincts must be an array");
  invariant(snapshot.precincts.length > 0, "snapshot contains no precincts");
  invariant(
    snapshot.enumeration.listed_precincts === snapshot.enumeration.parsed_precincts &&
      snapshot.enumeration.parsed_precincts === snapshot.precincts.length,
    "snapshot precinct counts disagree",
  );
  invariant(snapshot.ballots && typeof snapshot.ballots === "object", "snapshot.ballots must be an object");

  const precinctIds = new Set();
  const referencedBallots = new Set();
  for (const precinct of snapshot.precincts) {
    invariant(precinct.id, "snapshot contains a precinct without an id");
    invariant(!precinctIds.has(precinct.id), `snapshot repeats precinct ${precinct.id}`);
    precinctIds.add(precinct.id);
    invariant(snapshot.ballots[precinct.ballot_id], `precinct ${precinct.id} references a missing ballot`);
    referencedBallots.add(precinct.ballot_id);
  }

  for (const [id, ballot] of Object.entries(snapshot.ballots)) {
    invariant(referencedBallots.has(id), `snapshot contains unreferenced ballot ${id}`);
    invariant(Array.isArray(ballot.contests) && ballot.contests.length > 0, `ballot ${id} contains no contests`);
    invariant(ballotId(ballot.contests) === id, `ballot ${id} does not match its normalized content`);
  }

  return snapshot;
}

function comparable(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/\bu\.?s\.?\b/gi, "united states")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Counties disagree about where the vendor application prints a seat's term
// qualifier. Adams puts "(Full term commencing 1-1-2027)" in the contest
// instructions; other counties put it inside the title, and only the title
// reaches the statewide matcher. An unstripped qualifier is worse than a near
// miss: it empties possible_statewide_race_ids, so the loud "add an explicit
// statewide race mapping" refusal is replaced by a demand for a local office
// mapping, and a county that supplies one publishes a statewide race as its own
// county content. Which seat a contest is for is decided by candidate set, not
// by this suffix, so dropping it only widens what the matcher can consider.
// A term qualifier is recognized by shape rather than by an enumerated list of
// opening words, because the list is the kind of hand-kept judgement that goes
// stale. Surveying one ballot in each of 22 counties produced 132 distinct
// contest titles carrying 65 distinct parentheticals, and "term" separates them
// exactly: the 5 term qualifiers contain it and the other 60 --- districts,
// court divisions, levy types, "(by Petition)" --- do not. Those 60 must be
// kept, because a district or division is what tells two genuinely different
// seats apart.
const TERM_QUALIFIER = /\([^)]*\bterm\b[^)]*\)/gi;

function comparableOffice(value) {
  return comparable(String(value ?? "").replace(TERM_QUALIFIER, " "))
    .split(" ")
    .filter((word, index) => !(index === 0 && word === "for") && !["the", "of", "ohio"].includes(word))
    .join(" ");
}

function sourceCandidateSet(contest) {
  return contest.choices
    .filter((choice) => !choice.write_in)
    .map((choice) => `${comparable(choice.name)}|${comparable(choice.party ?? "nonpartisan")}`)
    .sort();
}

function publishedCandidateSet(race) {
  return race.candidates
    .filter((candidate) => comparable(candidate.party) !== "write in")
    .map((candidate) => `${comparable(candidate.name)}|${comparable(candidate.party ?? "nonpartisan")}`)
    .sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function possiblePublishedRaceMatches(contest, election) {
  if (!election || contest.kind !== "office") return [];
  return election.statewide_races.filter(
    (race) => comparableOffice(race.office) === comparableOffice(contest.title),
  );
}

function publishedRaceMatch(contest, election) {
  const candidates = sourceCandidateSet(contest);
  const matches = possiblePublishedRaceMatches(contest, election).filter(
    (race) => arraysEqual(publishedCandidateSet(race), candidates),
  );
  invariant(matches.length <= 1, `contest "${contest.title}" matches multiple published statewide races`);
  return matches[0]?.id ?? null;
}

function possiblePublishedIssueMatch(contest, election) {
  if (!election || contest.kind !== "issue") return null;
  const title = comparable(contest.title).replace(/^state /, "");
  const matches = election.issues.filter((issue) => comparable(issue.label).replace(/^state /, "") === title);
  invariant(matches.length <= 1, `contest "${contest.title}" matches multiple published statewide issues`);
  return matches[0]?.id ?? null;
}

function presentedChoiceOrder(contest) {
  if (contest.kind !== "office") return null;
  return contest.choices.map(({ name, party, write_in: writeIn }) => ({
    name,
    party,
    write_in: writeIn,
  }));
}

function addObservedChoiceOrder(entry, contest, precinctId) {
  const choices = presentedChoiceOrder(contest);
  if (!choices) return;
  const key = hash(choices);
  const observed = entry.choice_orders.get(key) ?? { choices, precinct_ids: new Set() };
  observed.precinct_ids.add(precinctId);
  entry.choice_orders.set(key, observed);
}

function observedChoiceOrders(entry) {
  return [...entry.choice_orders.values()].map(({ choices, precinct_ids: precinctIds }) => ({
    choices,
    precinct_count: precinctIds.size,
    sample_precinct_ids: [...precinctIds].slice(0, 5),
  }));
}

function observedPositions(entry) {
  return [...entry.positions.entries()]
    .sort(([left], [right]) => left - right)
    .map(([position, precinctIds]) => ({
      position,
      precinct_count: precinctIds.size,
      sample_precinct_ids: [...precinctIds].slice(0, 5),
    }));
}

function reportEntry(entry, precinctTotal, election) {
  const possibleStatewideRaceIds = possiblePublishedRaceMatches(entry.contest, election)
    .map(({ id }) => id);
  return {
    fingerprint: entry.fingerprint,
    kind: entry.contest.kind,
    title: entry.contest.title,
    subtitles: entry.contest.subtitles,
    precinct_count: entry.precinct_ids.size,
    precinct_total: precinctTotal,
    sample_precinct_ids: [...entry.precinct_ids].slice(0, 5),
    orders: [...entry.orders].sort((left, right) => left - right),
    observed_positions: observedPositions(entry),
    observed_choice_orders: observedChoiceOrders(entry),
    published_statewide_race_id: publishedRaceMatch(entry.contest, election),
    possible_statewide_race_ids: possibleStatewideRaceIds,
    possible_statewide_issue_id: possiblePublishedIssueMatch(entry.contest, election),
    uncertain: entry.contest.uncertain,
    contest: entry.contest,
  };
}

export function analyzeSnapshot(snapshot, election = null) {
  assertCompleteSnapshot(snapshot);
  if (election) {
    invariant(election.id === snapshot.election.id, "snapshot and election ids disagree");
  }

  const occurrences = new Map();
  for (const precinct of snapshot.precincts) {
    const ballot = snapshot.ballots[precinct.ballot_id];
    const seenOnBallot = new Set();
    for (const contest of ballot.contests) {
      const fingerprint = contestContentId(contest);
      invariant(
        !seenOnBallot.has(fingerprint),
        `precinct ${precinct.id} repeats normalized contest ${fingerprint}`,
      );
      seenOnBallot.add(fingerprint);
      const entry = occurrences.get(fingerprint) ?? {
        fingerprint,
        contest,
        precinct_ids: new Set(),
        orders: new Set(),
        positions: new Map(),
        choice_orders: new Map(),
      };
      entry.precinct_ids.add(precinct.id);
      entry.orders.add(contest.order);
      const positionPrecincts = entry.positions.get(contest.order) ?? new Set();
      positionPrecincts.add(precinct.id);
      entry.positions.set(contest.order, positionPrecincts);
      addObservedChoiceOrder(entry, contest, precinct.id);
      occurrences.set(fingerprint, entry);
    }
  }

  const precinctTotal = snapshot.precincts.length;
  const entries = [...occurrences.values()]
    .map((entry) => reportEntry(entry, precinctTotal, election))
    .sort((left, right) => Math.min(...left.orders) - Math.min(...right.orders) || left.title.localeCompare(right.title));
  const common = entries.filter((entry) => entry.precinct_count === precinctTotal);
  const precinctSpecific = entries.filter((entry) => entry.precinct_count !== precinctTotal);

  return {
    schema_version: PROJECTION_SCHEMA_VERSION,
    election: snapshot.election,
    county: snapshot.county,
    source: snapshot.source,
    enumeration: snapshot.enumeration,
    summary: {
      precincts: precinctTotal,
      distinct_ballots: Object.keys(snapshot.ballots).length,
      distinct_contests: entries.length,
      common_to_all_precincts: common.length,
      precinct_specific: precinctSpecific.length,
      uncertain_common: common.filter((entry) => entry.uncertain.length > 0).length,
    },
    common_to_all_precincts: common,
    precinct_specific: precinctSpecific,
  };
}

function slug(value) {
  return comparable(value).replace(/\s+/g, "-") || "contest";
}

function displayCounty(countyId) {
  return countyId
    .split("-")
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function stripParens(value) {
  return value.replace(/^\((.*)\)$/, "$1");
}

function raceScope(contest, countyName) {
  const detail = [...contest.subtitles, ...contest.instructions]
    .filter((line) => !/^\(\s*(?:to )?vote\b/i.test(line))
    .map(stripParens);
  if (contest.vote_for) {
    detail.push(contest.vote_for === 1 ? "Vote for one" : `Vote for no more than ${contest.vote_for}`);
  }
  return [`${countyName} County`, ...detail].join(" · ");
}

function mappingFor(mappings, entry) {
  return mappings[entry.fingerprint] ?? mappings[entry.title] ?? null;
}

function productRace(entry, mapping, snapshot, countyName) {
  const contest = entry.contest;
  const office = typeof mapping === "string" ? contest.title.replace(/^For\s+/i, "") : mapping.office;
  const officeId = typeof mapping === "string" ? mapping : mapping.office_id;
  invariant(officeId && office, `office mapping for "${contest.title}" needs office_id and office`);
  // No precinct's rotation is authoritative for the county. Publish the same
  // deterministic canonical order used by the identity normalizer and tell
  // the voter explicitly that their official ballot order will differ.
  const candidates = officeChoicePairs(contest)
    .map(({ choice }) => choice)
    .filter((choice) => !choice.write_in)
    .map((choice) => ({
      name: choice.name,
      party: choice.party ?? "No party printed",
    }));
  invariant(candidates.length > 0, `contest "${contest.title}" has no named candidates to publish`);
  const fingerprintSuffix = entry.fingerprint.slice("sha256:".length, "sha256:".length + 12);
  return {
    id: `${snapshot.county.id}-${slug(contest.title)}-${fingerprintSuffix}`,
    scope: raceScope(contest, countyName),
    office,
    office_id: officeId,
    last_verified: ohioDate(timestamp(snapshot.source.fetched_at, "snapshot.source.fetched_at")),
    source_url: snapshot.source.listing_url,
    source_fingerprint: entry.fingerprint,
    write_in_available: contest.allows_write_in,
    candidates,
  };
}

function productIssue(entry, snapshot) {
  const contest = entry.contest;
  const fingerprintSuffix = entry.fingerprint.slice("sha256:".length, "sha256:".length + 12);
  return {
    id: `${snapshot.county.id}-${slug(contest.title)}-${fingerprintSuffix}`,
    label: contest.title,
    title: contest.subtitles.join(" — ") || contest.title,
    ballot_text: (contest.issue_text_lines ?? []).join("\n"),
    choices: contest.choices.map((choice) => choice.name).filter(Boolean),
    last_verified: ohioDate(timestamp(snapshot.source.fetched_at, "snapshot.source.fetched_at")),
    source_url: snapshot.source.listing_url,
    source_fingerprint: entry.fingerprint,
  };
}

export function projectCounty(snapshot, election, {
  maxSourceAgeHours,
  officeMappings = {},
  statewideRaceMappings = {},
  statewideIssueMappings = {},
  countyName = displayCounty(snapshot.county.id),
  reviewedAt = new Date(),
} = {}) {
  const review = analyzeSnapshot(snapshot, election);
  invariant(Number.isFinite(maxSourceAgeHours) && maxSourceAgeHours >= 0, "projection requires maxSourceAgeHours");
  invariant(
    officeMappings && typeof officeMappings === "object" && !Array.isArray(officeMappings),
    "officeMappings must be an object",
  );
  invariant(
    statewideRaceMappings && typeof statewideRaceMappings === "object" && !Array.isArray(statewideRaceMappings),
    "statewideRaceMappings must be an object",
  );
  invariant(
    statewideIssueMappings && typeof statewideIssueMappings === "object" && !Array.isArray(statewideIssueMappings),
    "statewideIssueMappings must be an object",
  );
  const reviewedAtInstant = reviewedAt instanceof Date ? reviewedAt.getTime() : Date.parse(reviewedAt);
  invariant(Number.isFinite(reviewedAtInstant), "reviewedAt must be a valid timestamp");
  const fetchedAtInstant = timestamp(snapshot.source.fetched_at, "snapshot.source.fetched_at");
  invariant(reviewedAtInstant >= fetchedAtInstant, "projection review time cannot precede the snapshot fetch");
  const sourceUpdatedAtInstant = timestamp(snapshot.source.source_updated_at, "snapshot.source.source_updated_at");
  const sourceAgeAtReview = Number(((reviewedAtInstant - sourceUpdatedAtInstant) / 3_600_000).toFixed(1));
  invariant(
    sourceAgeAtReview <= maxSourceAgeHours,
    `source is ${sourceAgeAtReview}h old at review, above the accepted ${maxSourceAgeHours}h limit`,
  );

  const uncertain = review.common_to_all_precincts.filter((entry) => entry.uncertain.length > 0);
  invariant(uncertain.length === 0, `common contest "${uncertain[0]?.title}" contains an uncertain parse`);

  const races = [];
  const issues = [];
  const removedStatewide = [];
  const unmapped = [];
  for (const entry of review.common_to_all_precincts) {
    if (entry.published_statewide_race_id) {
      removedStatewide.push({ fingerprint: entry.fingerprint, id: entry.published_statewide_race_id });
      continue;
    }

    if (entry.kind === "office") {
      const statewideRaceId = mappingFor(statewideRaceMappings, entry);
      if (statewideRaceId) {
        invariant(
          entry.possible_statewide_race_ids.includes(statewideRaceId),
          `statewide race mapping for "${entry.title}" references ${statewideRaceId}, which does not match its office`,
        );
        removedStatewide.push({ fingerprint: entry.fingerprint, id: statewideRaceId });
        continue;
      }
      invariant(
        entry.possible_statewide_race_ids.length === 0,
        `office "${entry.title}" may duplicate ${entry.possible_statewide_race_ids.join(" or ")}; add an explicit statewide race mapping`,
      );
      const mapping = mappingFor(officeMappings, entry);
      if (!mapping) {
        unmapped.push(entry.title);
        continue;
      }
      races.push(productRace(entry, mapping, snapshot, countyName));
      continue;
    }

    const statewideIssueId = mappingFor(statewideIssueMappings, entry);
    if (statewideIssueId) {
      invariant(
        election.issues.some((issue) => issue.id === statewideIssueId),
        `statewide issue mapping for "${entry.title}" references unknown issue ${statewideIssueId}`,
      );
      removedStatewide.push({ fingerprint: entry.fingerprint, id: statewideIssueId });
      continue;
    }
    invariant(
      !entry.possible_statewide_issue_id,
      `issue "${entry.title}" may duplicate ${entry.possible_statewide_issue_id}; add an explicit statewide issue mapping`,
    );
    issues.push(productIssue(entry, snapshot));
  }

  invariant(unmapped.length === 0, `common office contests need mappings: ${unmapped.join(", ")}`);
  const ids = [...races, ...issues].map((entry) => entry.id);
  invariant(new Set(ids).size === ids.length, "projection generated duplicate product ids");
  const precinctSpecificRaces = review.precinct_specific.filter(({ kind }) => kind === "office").length;
  const precinctSpecificIssues = review.precinct_specific.filter(({ kind }) => kind === "issue").length;

  return {
    schema_version: PROJECTION_SCHEMA_VERSION,
    election_id: snapshot.election.id,
    county_id: snapshot.county.id,
    county: {
      coverage: {
        status: "complete",
        method: "common_to_all_precincts",
        scope: `Content present on all ${snapshot.precincts.length} enumerated precinct ballots`,
        summary: "Every office and issue shown appears on every enumerated precinct ballot. Candidate order here may differ from the official ballot because Ohio rotates candidate order by precinct. Additional precinct-specific content remains excluded.",
        source_url: snapshot.source.listing_url,
        source_updated_at: snapshot.source.source_updated_at,
        source_age_hours_at_review: sourceAgeAtReview,
        precincts_verified: snapshot.precincts.length,
        precinct_specific_races: precinctSpecificRaces,
        precinct_specific_issues: precinctSpecificIssues,
        reviewed_at: new Date(reviewedAtInstant).toISOString(),
        last_verified: ohioDate(reviewedAtInstant),
      },
      races,
      issues,
    },
    removed_statewide_duplicates: removedStatewide,
    review,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.snapshot) throw new Error("--snapshot is required");
    const snapshot = await readJson(args.snapshot);
    const electionData = args.elections ? await readJson(args.elections) : null;
    const election = electionData?.elections?.find(({ id }) => id === snapshot.election.id) ?? null;
    if (args.elections) {
      invariant(election, `election ${snapshot.election.id} is absent from --elections data`);
    }
    const review = analyzeSnapshot(snapshot, election);
    let artifact = { review };

    if (args.config) {
      invariant(election, `election ${snapshot.election.id} is absent from --elections data`);
      const config = await readJson(args.config);
      artifact = projectCounty(snapshot, election, {
        maxSourceAgeHours: config.max_source_age_hours,
        officeMappings: config.office_mappings,
        statewideRaceMappings: config.statewide_race_mappings,
        statewideIssueMappings: config.statewide_issue_mappings,
        countyName: config.county_name,
      });
    }

    const output = `${JSON.stringify(artifact, null, 2)}\n`;
    if (args.out) {
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, output);
      console.log(`Wrote ${args.out}`);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
