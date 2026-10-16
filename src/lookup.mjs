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
    .filter(([, county]) => county.races.length > 0)
    .map(([countyId]) => countyId);
}

export function racesForCounty(countyId, counties) {
  return counties[countyId]?.races ?? [];
}

export function sourceLabel(race, label) {
  return `${label} — ${race.office} — ${race.scope}`;
}

export function hasPublishedBallotDetails(election) {
  return (
    election.statewide_races.length > 0 ||
    election.issues.length > 0 ||
    Object.values(election.counties).some(({ races }) => races.length > 0)
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
