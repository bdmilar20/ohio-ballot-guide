// Projects a complete precinct-level vtrapp snapshot into the deliberately
// smaller county view the current product can publish safely.
//
// The projection includes only normalized contest content that appears on
// every enumerated precinct ballot. It emits a review artifact first; it never
// edits data/elections.json directly.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertBallotBundle, ballotContentId as exactBallotContentId } from "../src/exact-ballot.mjs";
import { ballotId, parseArgs, SCHEMA_VERSION as SNAPSHOT_SCHEMA_VERSION } from "./ingest/vtrapp.mjs";
import { projectExactFromArgs } from "./project-vtrapp-exact.mjs";

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

// The title is the weakest part of the statewide check: it is typed by each
// county and the survey found "(4th Distrit)" sitting in live data. Any title
// the matcher fails to recognize --- a typo, a wording this code has not seen,
// a qualifier in an unexpected place --- leaves possible_statewide_race_ids
// empty, and an empty list reads as "not a statewide race" rather than as "do
// not know". So the same question is asked a second time without consulting
// the title at all: two contests listing the same candidates with the same
// parties are the same contest, whatever either one is called.
export function statewideTwinByCandidates(contest, election) {
  if (!election || contest.kind !== "office") return null;
  const candidates = sourceCandidateSet(contest);
  if (candidates.length === 0) return null;
  const twin = election.statewide_races.find(
    (race) => arraysEqual(publishedCandidateSet(race), candidates),
  );
  return twin?.id ?? null;
}

export function possiblePublishedRaceMatches(contest, election) {
  if (!election || contest.kind !== "office") return [];
  return election.statewide_races.filter(
    (race) => comparableOffice(race.office) === comparableOffice(contest.title),
  );
}

export function publishedRaceMatch(contest, election) {
  const candidates = sourceCandidateSet(contest);
  const matches = possiblePublishedRaceMatches(contest, election).filter(
    (race) => arraysEqual(publishedCandidateSet(race), candidates),
  );
  invariant(matches.length <= 1, `contest "${contest.title}" matches multiple published statewide races`);
  return matches[0]?.id ?? null;
}

// Exported so the statewide-issue generator can identify the published issue a
// county contest belongs to using this exact rule rather than a second copy of
// it. A copy would drift, and the drift would read as agreement.
export function possiblePublishedIssueMatch(contest, election) {
  if (!election || contest.kind !== "issue") return null;
  const title = comparable(contest.title).replace(/^state /, "");
  const matches = election.issues.filter((issue) => comparable(issue.label).replace(/^state /, "") === title);
  invariant(matches.length <= 1, `contest "${contest.title}" matches multiple published statewide issues`);
  return matches[0]?.id ?? null;
}

/**
 * Reduces the generated statewide-issue artifact to the only thing the
 * projector needs from it: the certified ballot text of each published issue.
 *
 * The artifact is written by scripts/build-statewide-issues.mjs, which learns
 * that text from the counties printing it and refuses to emit an issue its
 * counties disagree about.
 */
export function certifiedIssueText(artifact) {
  invariant(
    artifact?.issues && typeof artifact.issues === "object" && !Array.isArray(artifact.issues),
    "a statewide issue text artifact needs an issues object",
  );
  return Object.fromEntries(
    Object.entries(artifact.issues).map(([id, record]) => {
      invariant(
        typeof record?.body_text === "string" && record.body_text.trim() !== "",
        `statewide issue ${id} needs non-empty certified ballot text`,
      );
      return [id, record.body_text];
    }),
  );
}

// The issue counterpart of statewideTwinByCandidates, and it exists for the
// same reason: possiblePublishedIssueMatch compares the contest TITLE to the
// published label, and the title is typed by each county. Two of the seventy
// enumerable counties title the November 2026 amendment "3 Proposed
// Constitutional Amendment" rather than "Issue 3", so the title rule does not
// see it --- and an unrecognized statewide issue is published as that county's
// own, showing a voter the same amendment twice.
//
// So the question is asked again without consulting the title: a contest that
// prints the certified ballot text of a published issue IS that issue. The
// comparison is exact, with no normalization, because that is what was
// measured --- all 70 counties carry the November 2026 amendment's 1139-char
// body byte-identically, and 138 distinct issue bodies statewide make a full
// body effectively a unique key. A county whose text differs by one byte
// deliberately falls through to the loud title refusal rather than being
// fuzzily matched to the wrong issue.
export function statewideIssueTwinByText(contest, issueText) {
  if (contest.kind !== "issue") return null;
  const body = (contest.issue_text_lines ?? []).join("\n");
  if (body.trim() === "") return null;
  const matches = Object.entries(issueText).filter(([, certified]) => certified === body);
  invariant(
    matches.length <= 1,
    `contest "${contest.title}" prints the certified text of ${matches.map(([id]) => id).join(" and ")}`,
  );
  return matches[0]?.[0] ?? null;
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

function raceScope(contest, countyName, { includeHeading = false } = {}) {
  const detail = [...contest.subtitles, ...contest.instructions]
    .filter((line) => !/^\(\s*(?:to )?vote\b/i.test(line))
    .map(stripParens);
  if (contest.vote_for) {
    detail.push(contest.vote_for === 1 ? "Vote for one" : `Vote for no more than ${contest.vote_for}`);
  }
  const heading = includeHeading && !/^For\s+/i.test(contest.title) ? [contest.title] : [];
  return [`${countyName} County`, ...heading, ...detail].join(" · ");
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

function exactProductRace(entry, mapping, snapshot, countyName, published = null) {
  const contest = entry.contest;
  const mappedOffice = typeof mapping === "string" ? contest.title.replace(/^For\s+/i, "") : mapping?.office;
  const mappedOfficeId = typeof mapping === "string" ? mapping : mapping?.office_id;
  const office = published?.office ?? mappedOffice;
  const officeId = published?.office_id ?? mappedOfficeId;
  invariant(officeId && office, `office mapping for "${contest.title}" needs office_id and office`);

  // An exact precinct ballot keeps the source's printed candidate order.
  // The countywide projection canonicalizes that order because Ohio rotates
  // candidates between precincts and no one rotation represents the county.
  const candidates = contest.choices
    .filter((choice) => !choice.write_in)
    .map((choice) => ({
      name: choice.name,
      party: choice.party ?? "No party printed",
    }));
  invariant(candidates.length > 0, `contest "${contest.title}" has no named candidates to publish`);
  const fingerprintSuffix = entry.fingerprint.slice("sha256:".length, "sha256:".length + 12);
  return {
    id: published?.id ?? `${snapshot.county.id}-${slug(contest.title)}-${fingerprintSuffix}`,
    scope: published?.scope ?? raceScope(contest, countyName, { includeHeading: true }),
    office,
    office_id: officeId,
    last_verified: ohioDate(timestamp(snapshot.source.fetched_at, "snapshot.source.fetched_at")),
    source_url: contest.source_url ?? snapshot.source.listing_url,
    source_fingerprint: entry.fingerprint,
    write_in_available: contest.allows_write_in,
    candidates,
  };
}

function exactProductIssue(entry, snapshot, published = null) {
  const issue = productIssue(entry, snapshot);
  return {
    ...issue,
    id: published?.id ?? issue.id,
    source_url: entry.contest.source_url ?? snapshot.source.listing_url,
  };
}

function exactEntry(entry, contest) {
  return { ...entry, contest, title: contest.title };
}

function catalogPresence(entry) {
  invariant(
    Number.isInteger(entry.precinct_count) && Number.isInteger(entry.precinct_total),
    `contest "${entry.title}" needs measured precinct presence`,
  );
  invariant(
    entry.precinct_count > 0 && entry.precinct_count <= entry.precinct_total,
    `contest "${entry.title}" has invalid precinct presence`,
  );
  return {
    scope: entry.precinct_count === entry.precinct_total ? "all_precincts" : "some_precincts",
    precincts: entry.precinct_count,
    precincts_total: entry.precinct_total,
  };
}

function derivedOfficeMapping(entry, labelOffice) {
  const labels = [entry.title, ...entry.contest.subtitles]
    .map((printed) => labelOffice(printed))
    .filter(Boolean);
  const distinct = new Map(labels.map((mapping) => [canonicalString(mapping), mapping]));
  invariant(
    distinct.size <= 1,
    `office contest "${entry.title}" has conflicting title and subtitle mappings`,
  );
  return distinct.values().next().value ?? null;
}

function exactRace(entry, snapshot, election, options) {
  const directId = entry.published_statewide_race_id;
  if (directId) {
    const published = election.statewide_races.find(({ id }) => id === directId);
    invariant(published, `contest "${entry.title}" references missing statewide race ${directId}`);
    return exactProductRace(entry, null, snapshot, options.countyName, published);
  }

  const mappedId = mappingFor(options.statewideRaceMappings, entry);
  if (mappedId) {
    invariant(
      entry.possible_statewide_race_ids.includes(mappedId),
      `statewide race mapping for "${entry.title}" references ${mappedId}, which does not match its office`,
    );
    const published = election.statewide_races.find(({ id }) => id === mappedId);
    invariant(published, `statewide race mapping for "${entry.title}" references missing race ${mappedId}`);
    return exactProductRace(entry, null, snapshot, options.countyName, published);
  }

  invariant(
    entry.possible_statewide_race_ids.length === 0,
    `office "${entry.title}" may duplicate ${entry.possible_statewide_race_ids.join(" or ")}; add an explicit statewide race mapping`,
  );
  const twin = statewideTwinByCandidates(entry.contest, election);
  invariant(
    !twin,
    `office "${entry.title}" lists the same candidates as statewide race ${twin}; add an explicit statewide race mapping`,
  );
  const mapping = mappingFor(options.officeMappings, entry)
    ?? derivedOfficeMapping(entry, options.labelOffice);
  invariant(mapping, `office contest needs a mapping: ${entry.title}`);
  return exactProductRace(entry, mapping, snapshot, options.countyName);
}

function exactIssue(entry, snapshot, election, options) {
  const issueTwin = statewideIssueTwinByText(entry.contest, options.statewideIssueText);
  const mappedId = mappingFor(options.statewideIssueMappings, entry);
  let statewideId = null;
  if (mappedId) {
    invariant(
      election.issues.some(({ id }) => id === mappedId),
      `statewide issue mapping for "${entry.title}" references unknown issue ${mappedId}`,
    );
    invariant(
      !issueTwin || issueTwin === mappedId,
      `statewide issue mapping for "${entry.title}" references ${mappedId} but its certified ballot text identifies ${issueTwin}`,
    );
    statewideId = mappedId;
  } else if (issueTwin) {
    invariant(
      !entry.possible_statewide_issue_id || entry.possible_statewide_issue_id === issueTwin,
      `issue "${entry.title}" is titled as ${entry.possible_statewide_issue_id} but prints the certified ballot text of ${issueTwin}`,
    );
    statewideId = issueTwin;
  } else {
    invariant(
      !entry.possible_statewide_issue_id,
      `issue "${entry.title}" may duplicate ${entry.possible_statewide_issue_id}; add an explicit statewide issue mapping`,
    );
  }

  const published = statewideId ? election.issues.find(({ id }) => id === statewideId) : null;
  invariant(!statewideId || published, `contest "${entry.title}" references missing statewide issue ${statewideId}`);
  return exactProductIssue(entry, snapshot, published);
}

export function projectCounty(snapshot, election, {
  maxSourceAgeHours,
  officeMappings = {},
  statewideRaceMappings = {},
  statewideIssueMappings = {},
  statewideIssueText = {},
  // Labels an office the config has no explicit mapping for. A function rather
  // than a data file, so the projector holds no opinion about where a label
  // comes from and an explicit mapping always wins over a derived one.
  labelOffice = () => null,
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
  invariant(
    statewideIssueText && typeof statewideIssueText === "object" && !Array.isArray(statewideIssueText),
    "statewideIssueText must be an object",
  );
  invariant(typeof labelOffice === "function", "labelOffice must be a function");
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
      const mapping = mappingFor(officeMappings, entry) ?? derivedOfficeMapping(entry, labelOffice);
      if (!mapping) {
        unmapped.push(entry.title);
        continue;
      }
      // Reached only once the title check has already decided this is county
      // content, so this is the last place to catch a statewide race the title
      // failed to identify. Publishing it here shows a voter the same contest
      // twice, once statewide and once as their county's own.
      const twin = statewideTwinByCandidates(entry.contest, election);
      invariant(
        !twin,
        `office "${entry.title}" lists the same candidates as statewide race ${twin}; it is that race under another name, not county content`,
      );
      races.push(productRace(entry, mapping, snapshot, countyName));
      continue;
    }

    // Compute the text identity before consulting an override. An explicit
    // mapping remains the escape hatch when the county's text has genuinely
    // drifted, but it must not be allowed to contradict an exact certified
    // body match.
    const issueTwin = statewideIssueTwinByText(entry.contest, statewideIssueText);
    const statewideIssueId = mappingFor(statewideIssueMappings, entry);
    if (statewideIssueId) {
      invariant(
        election.issues.some((issue) => issue.id === statewideIssueId),
        `statewide issue mapping for "${entry.title}" references unknown issue ${statewideIssueId}`,
      );
      invariant(
        !issueTwin || issueTwin === statewideIssueId,
        `statewide issue mapping for "${entry.title}" references ${statewideIssueId} but its certified ballot text identifies ${issueTwin}`,
      );
      removedStatewide.push({ fingerprint: entry.fingerprint, id: statewideIssueId });
      continue;
    }
    // Reached only once the title check and the config have both declined to
    // call this a statewide issue, so it is the last place to catch one. Every
    // county that prints the certified text is resolved here without a hand
    // mapping, which is why onboarding a county no longer needs one.
    if (issueTwin) {
      invariant(
        !entry.possible_statewide_issue_id || entry.possible_statewide_issue_id === issueTwin,
        `issue "${entry.title}" is titled as ${entry.possible_statewide_issue_id} but prints the certified ballot text of ${issueTwin}`,
      );
      removedStatewide.push({ fingerprint: entry.fingerprint, id: issueTwin });
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

/**
 * Publishes the union of every distinct local contest found anywhere in a
 * county's complete precinct snapshot. This is the city/ZIP product: it gives
 * a voter the county's full catalog without pretending the catalog is their
 * exact ballot. Each record carries the measured number of precinct ballots
 * it appeared on, and the UI labels narrower contests before a voter reads the
 * card.
 */
export function projectCountyCatalog(snapshot, election, options = {}) {
  // Reuse the conservative projection's completeness, freshness, statewide
  // duplicate, and common-office gates before widening from the intersection
  // to the union.
  const commonProjection = projectCounty(snapshot, election, options);
  const review = commonProjection.review;
  const {
    officeMappings = {},
    statewideRaceMappings = {},
    statewideIssueMappings = {},
    statewideIssueText = {},
    labelOffice = () => null,
    countyName = displayCounty(snapshot.county.id),
  } = options;
  const sharedOptions = {
    officeMappings,
    statewideRaceMappings,
    statewideIssueMappings,
    statewideIssueText,
    labelOffice,
    countyName,
  };
  const statewideRaceIds = new Set(election.statewide_races.map(({ id }) => id));
  const statewideIssueIds = new Set(election.issues.map(({ id }) => id));
  const races = [];
  const issues = [];
  const removedStatewide = [];

  for (const entry of [...review.common_to_all_precincts, ...review.precinct_specific]) {
    invariant(
      Array.isArray(entry.uncertain) && entry.uncertain.length === 0,
      `contest "${entry.title}" contains an uncertain parse`,
    );
    const ballotPresence = catalogPresence(entry);
    if (entry.kind === "office") {
      if (entry.published_statewide_race_id) {
        invariant(
          statewideRaceIds.has(entry.published_statewide_race_id),
          `contest "${entry.title}" references missing statewide race ${entry.published_statewide_race_id}`,
        );
        removedStatewide.push({
          fingerprint: entry.fingerprint,
          id: entry.published_statewide_race_id,
        });
        continue;
      }
      const mappedStatewideId = mappingFor(statewideRaceMappings, entry);
      if (mappedStatewideId) {
        invariant(
          entry.possible_statewide_race_ids.includes(mappedStatewideId),
          `statewide race mapping for "${entry.title}" references ${mappedStatewideId}, which does not match its office`,
        );
        invariant(
          statewideRaceIds.has(mappedStatewideId),
          `statewide race mapping for "${entry.title}" references missing race ${mappedStatewideId}`,
        );
        removedStatewide.push({ fingerprint: entry.fingerprint, id: mappedStatewideId });
        continue;
      }
      // exactRace owns the statewide-identity and office-mapping decision for
      // both common and precinct-specific contests. The catalog then
      // canonicalizes candidate rotation because no precinct's order
      // represents a county-wide list.
      const classified = exactRace(entry, snapshot, election, sharedOptions);
      if (statewideRaceIds.has(classified.id)) {
        removedStatewide.push({ fingerprint: entry.fingerprint, id: classified.id });
        continue;
      }
      races.push({
        ...productRace(
          entry,
          { office_id: classified.office_id, office: classified.office },
          snapshot,
          countyName,
        ),
        ballot_presence: ballotPresence,
      });
      continue;
    }

    invariant(entry.kind === "issue", `contest "${entry.title}" has unknown kind ${entry.kind}`);
    const classified = exactIssue(entry, snapshot, election, sharedOptions);
    if (statewideIssueIds.has(classified.id)) {
      removedStatewide.push({ fingerprint: entry.fingerprint, id: classified.id });
      continue;
    }
    issues.push({ ...productIssue(entry, snapshot), ballot_presence: ballotPresence });
  }

  const ids = [...races, ...issues].map(({ id }) => id);
  invariant(new Set(ids).size === ids.length, "county catalog generated duplicate product ids");
  const precinctSpecificRaces = races.filter(
    ({ ballot_presence: presence }) => presence.scope === "some_precincts",
  ).length;
  const precinctSpecificIssues = issues.filter(
    ({ ballot_presence: presence }) => presence.scope === "some_precincts",
  ).length;
  const baseCoverage = commonProjection.county.coverage;

  return {
    schema_version: PROJECTION_SCHEMA_VERSION,
    election_id: snapshot.election.id,
    county_id: snapshot.county.id,
    county: {
      coverage: {
        ...baseCoverage,
        method: "all_precinct_contests",
        scope: `Every distinct contest found across ${snapshot.precincts.length} enumerated precinct ballots`,
        summary: "This county catalog includes every race and issue found on any enumerated precinct ballot. Contests limited to some precincts are labeled and may not apply to your address. Candidate order may differ because Ohio rotates candidates by precinct.",
        precinct_specific_races: precinctSpecificRaces,
        precinct_specific_issues: precinctSpecificIssues,
      },
      races,
      issues,
    },
    removed_statewide_duplicates: removedStatewide,
    review,
  };
}

/**
 * Converts every enumerated precinct ballot into the browser's exact-ballot
 * bundle. Unlike the countywide projection, this path retains precinct-only
 * contests and each precinct's printed candidate order. It deliberately emits
 * no manifest entry: a bundle is publishable only after an independently
 * sourced address index covers every precinct.
 */
export async function projectExactBallotBundle(snapshot, election, {
  maxSourceAgeHours,
  officeMappings = {},
  statewideRaceMappings = {},
  statewideIssueMappings = {},
  statewideIssueText = {},
  labelOffice = () => null,
  countyName = displayCounty(snapshot.county.id),
  reviewedAt = new Date(),
} = {}) {
  // Reuse every completeness, freshness, statewide-duplicate, and common
  // office-mapping gate that already protects the countywide projection.
  const sharedOptions = {
    maxSourceAgeHours,
    officeMappings,
    statewideRaceMappings,
    statewideIssueMappings,
    statewideIssueText,
    labelOffice,
    countyName,
    reviewedAt,
  };
  const countyProjection = projectCounty(snapshot, election, sharedOptions);
  const entries = new Map(
    [...countyProjection.review.common_to_all_precincts, ...countyProjection.review.precinct_specific]
      .map((entry) => [entry.fingerprint, entry]),
  );

  const sourceBallotIds = new Map();
  const ballots = {};
  for (const [sourceBallotId, ballot] of Object.entries(snapshot.ballots)) {
    let priorOrder = 0;
    const races = [];
    const issues = [];
    for (const contest of ballot.contests) {
      invariant(
        Number.isInteger(contest.order) && contest.order > priorOrder,
        `ballot ${sourceBallotId} contest order must be strictly increasing`,
      );
      priorOrder = contest.order;
      invariant(
        Array.isArray(contest.uncertain) && contest.uncertain.length === 0,
        `contest "${contest.title}" contains an uncertain parse`,
      );
      const fingerprint = contestContentId(contest);
      const observed = entries.get(fingerprint);
      invariant(observed, `ballot ${sourceBallotId} contains unanalyzed contest ${fingerprint}`);
      const entry = exactEntry(observed, contest);
      if (contest.kind === "office") {
        races.push(exactRace(entry, snapshot, election, sharedOptions));
      } else {
        invariant(contest.kind === "issue", `contest "${contest.title}" has unknown kind ${contest.kind}`);
        issues.push(exactIssue(entry, snapshot, election, sharedOptions));
      }
    }

    const content = { races, issues };
    const productBallotId = await exactBallotContentId(content);
    if (ballots[productBallotId]) {
      invariant(
        canonicalString(ballots[productBallotId]) === canonicalString(content),
        `exact ballot digest collision at ${productBallotId}`,
      );
    } else {
      ballots[productBallotId] = content;
    }
    sourceBallotIds.set(sourceBallotId, productBallotId);
  }

  const precincts = snapshot.precincts.map((precinct) => {
    invariant(
      typeof precinct.name === "string" && precinct.name.trim() !== "",
      `precinct ${precinct.id} needs a source name`,
    );
    const productBallotId = sourceBallotIds.get(precinct.ballot_id);
    invariant(productBallotId, `precinct ${precinct.id} references an unprojected ballot`);
    const split = typeof precinct.split === "string" ? precinct.split.trim() : "";
    return {
      id: precinct.id,
      name: split && split !== precinct.name.trim()
        ? `${precinct.name.trim()} · ${split}`
        : precinct.name.trim(),
      ballot_id: productBallotId,
    };
  });

  const bundle = {
    schema_version: 1,
    election_id: snapshot.election.id,
    county_id: snapshot.county.id,
    provenance: {
      source_url: snapshot.source.listing_url,
      // The official application is a multi-page stateful flow, so there is no
      // single response body to hash. The complete normalized snapshot is the
      // immutable input this artifact was derived from, and this digest pins
      // every enumerated precinct, source URL, and parsed contest together.
      source_sha256: hash(snapshot),
      retrieved_at: snapshot.source.fetched_at,
      last_verified: ohioDate(timestamp(snapshot.source.fetched_at, "snapshot.source.fetched_at")),
    },
    enumeration: structuredClone(snapshot.enumeration),
    precincts,
    ballots,
  };
  await assertBallotBundle(bundle);
  return bundle;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const argv = process.argv.slice(2);
    const exactFlags = argv.filter((argument) => argument === "--exact");
    invariant(exactFlags.length <= 1, "--exact may be supplied only once");
    const exact = exactFlags.length === 1;
    const args = parseArgs(argv.filter((argument) => argument !== "--exact"));
    if (exact) {
      await projectExactFromArgs(args, { certifiedIssueText, projectExactBallotBundle });
    } else {
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
        // Read rather than defaulted to empty: an absent artifact silently
        // removes the backstop, and "silently" is how the duplicate it prevents
        // reaches a voter.
        const issueTextPath = args["issue-text"]
          ?? fileURLToPath(new URL("../data/statewide-issue-text.json", import.meta.url));
        artifact = projectCounty(snapshot, election, {
          maxSourceAgeHours: config.max_source_age_hours,
          officeMappings: config.office_mappings,
          statewideRaceMappings: config.statewide_race_mappings,
          statewideIssueMappings: config.statewide_issue_mappings,
          statewideIssueText: certifiedIssueText(await readJson(issueTextPath)),
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
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
