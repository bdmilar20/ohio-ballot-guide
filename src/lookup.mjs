const MILLISECONDS_PER_DAY = 86_400_000;

export function normalizeQuery(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/,?\s*oh(?:io)?$/i, "")
    .replace(/\s+/g, " ");
}

export const ZIP_PATTERN = /^\d{5}$/;

// `index` is data/locations.json: generated maps of every Ohio ZIP and place
// name. Both lookups are keyed by the normalized query, so neither scales with
// the size of the dataset.
export function resolveLocation(query, index) {
  const normalized = normalizeQuery(query);

  if (!normalized) return null;

  if (ZIP_PATTERN.test(normalized)) {
    const zip = index.zips[normalized];
    return zip ? { kind: "zip", display_name: normalized, ...zip } : null;
  }

  const place = index.places[normalized];
  return place ? { kind: "place", ...place } : null;
}

export function countiesWithContests(election) {
  return Object.entries(election.counties)
    .filter(([, county]) => county.races.length > 0 || (county.issues?.length ?? 0) > 0)
    .map(([countyId]) => countyId);
}

export function racesForCounty(countyId, counties) {
  return counties[countyId]?.races ?? [];
}

export function issuesForCounty(countyId, counties) {
  return counties[countyId]?.issues ?? [];
}

export function contestSequenceLabels(races) {
  const totals = new Map();
  const keyFor = ({ office, scope }) => `${office}\0${scope ?? ""}`;
  for (const race of races) {
    const key = keyFor(race);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const seen = new Map();
  return races.map((race) => {
    const key = keyFor(race);
    const total = totals.get(key);
    if (total === 1) return null;
    const current = (seen.get(key) ?? 0) + 1;
    seen.set(key, current);
    return `Separate contest ${current} of ${total}`;
  });
}

export function issueSequenceLabels(issues) {
  const totals = new Map();
  const keyFor = ({ label, title }) => `${label}\0${title}`;
  for (const issue of issues) {
    const key = keyFor(issue);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const seen = new Map();
  return issues.map((issue) => {
    const key = keyFor(issue);
    const total = totals.get(key);
    if (total === 1) return null;
    const current = (seen.get(key) ?? 0) + 1;
    seen.set(key, current);
    return `Separate measure ${current} of ${total}`;
  });
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function countyCoverageNotice(countyName, coverage, raceCount, issueCount) {
  if (coverage.method === "common_to_all_precincts") {
    const precinctSpecific = [];
    if (coverage.precinct_specific_races > 0) {
      precinctSpecific.push(countPhrase(coverage.precinct_specific_races, "additional local contest"));
    }
    if (coverage.precinct_specific_issues > 0) {
      precinctSpecific.push(countPhrase(coverage.precinct_specific_issues, "additional local issue"));
    }
    const variationCopy = precinctSpecific.length > 0
      ? `${precinctSpecific.join(" and ")} appear only on some precinct ballots and are not shown here. `
      : "";
    return {
      lead: "Approximate location.",
      copy: `This match points to ${countyName}. The county section contains content verified on every enumerated precinct ballot. The candidate order here may differ from your ballot because Ohio rotates candidate order by precinct. ${variationCopy}Verify your exact contests and candidate order with the official sample-ballot link below.`,
    };
  }

  if (coverage.status === "partial") {
    return {
      lead: "Approximate location and partial coverage.",
      copy: `This match points to ${countyName}. The county section contains ${raceCount} selected ${raceCount === 1 ? "contest" : "contests"} and ${issueCount} ${issueCount === 1 ? "issue" : "issues"}, not a complete ballot. Verify your precinct with the official sample-ballot link below.`,
    };
  }

  return {
    lead: "Approximate location.",
    copy: `This match points to ${countyName}. The county section covers every verified countywide contest and issue in the official list, but it is not a complete precinct ballot. Verify your precinct with the official sample-ballot link below.`,
  };
}

function sentenceList(parts) {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

// Braeden searched his own ZIP on launch day and counted roughly a tenth of his
// ballot. Nothing on the page told him how much it had, so what he could see
// read as the whole election. Every result now opens with the count the data
// can defend, and says in the same breath that a count is not a ballot.
export function ballotCoverage(election, { countyId = null, countyName = null } = {}) {
  const county = countyId ? election.counties[countyId] : null;
  const statewideRaces = election.statewide_races.length;
  const statewideIssues = election.issues.length;
  const countyRaces = county?.races?.length ?? 0;
  const countyIssues = county?.issues?.length ?? 0;
  const total = statewideRaces + statewideIssues + countyRaces + countyIssues;

  if (total === 0) return null;

  const where = countyName ? ` in ${countyName}` : "";
  const parts = [];
  if (statewideRaces > 0) parts.push(countPhrase(statewideRaces, "statewide contest"));
  if (statewideIssues > 0) parts.push(countPhrase(statewideIssues, "statewide ballot issue"));
  if (countyRaces > 0) parts.push(`${countPhrase(countyRaces, "countywide contest")}${where}`);
  if (countyIssues > 0) parts.push(`${countPhrase(countyIssues, "county ballot issue")}${where}`);

  let gaps;
  if (countyRaces + countyIssues > 0) {
    gaps =
      "That is not your whole ballot. Each section below names the official list it came from and what that list leaves out.";
  } else if (countyId) {
    gaps =
      "That is not your whole ballot: no local contests are verified for your county yet, so everything here is content that appears statewide.";
  } else {
    gaps =
      "That is not your whole ballot, and it holds no local contests yet — everything here appears on every Ohio ballot.";
  }

  return {
    total,
    counts: `This guide has ${countPhrase(total, "contest or question", "contests and questions")} for you: ${sentenceList(parts)}.`,
    gaps,
  };
}

export function sourceLabel(race, label, sequenceLabel = null) {
  return [label, race.office, sequenceLabel, race.scope].filter(Boolean).join(" — ");
}

export function issueSourceLabel(issue, label, sequenceLabel = null) {
  return [label, issue.label, sequenceLabel, issue.title].filter(Boolean).join(" — ");
}

// A later-election row carries a date long before anyone files for it. Rendering
// name and date alone read as if the contests were known and there were none,
// so the row says which of the two it is.
export function scheduleOnlyNote(election) {
  if (hasPublishedBallotDetails(election)) return null;
  return "Date only — contests are not published yet, and an election is held only where one is scheduled.";
}

// Shareable result links. A guide with no URL state cannot be bookmarked, sent
// to someone, or cited in a bug report: every reader had to retype the search.
export function guideSearch({ query, countyId = null }) {
  const trimmed = query.trim();
  if (!trimmed) return "";
  const params = new URLSearchParams({ q: trimmed });
  if (countyId) params.set("county", countyId);
  return `?${params.toString()}`;
}

export function parseGuideSearch(search) {
  const params = new URLSearchParams(search);
  const query = (params.get("q") ?? "").trim();
  if (!query) return null;
  const countyId = (params.get("county") ?? "").trim();
  return { query, countyId: countyId || null };
}

export function hasPublishedBallotDetails(election) {
  return (
    election.statewide_races.length > 0 ||
    election.issues.length > 0 ||
    Object.values(election.counties).some(
      ({ races, issues = [] }) => races.length > 0 || issues.length > 0,
    )
  );
}

function datePartsInOhio(value) {
  if (typeof value === "string") return value;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateIndex(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY;
}

export function upcomingElections(elections, today = new Date()) {
  const todayIndex = dateIndex(datePartsInOhio(today));

  return elections
    .filter((election) => dateIndex(election.date) >= todayIndex)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function selectNextElection(elections, today = new Date()) {
  return upcomingElections(elections, today)[0] ?? null;
}

export function daysUntilElection(electionDate, today = new Date()) {
  return dateIndex(electionDate) - dateIndex(datePartsInOhio(today));
}

export const WRITE_IN_PARTY = "Write-in";

export function isWriteInCandidate(candidate) {
  return candidate.party === WRITE_IN_PARTY;
}

export function partitionCandidates(candidates) {
  return {
    onBallot: candidates.filter((candidate) => !isWriteInCandidate(candidate)),
    writeIn: candidates.filter(isWriteInCandidate),
  };
}
