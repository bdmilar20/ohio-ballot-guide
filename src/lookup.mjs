const MILLISECONDS_PER_DAY = 86_400_000;

export function normalizeQuery(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/,?\s*oh(?:io)?$/i, "")
    .replace(/\s+/g, " ");
}

export function isZipQuery(value) {
  return /^\d{5}$/.test(normalizeQuery(value));
}

export function resolveLocation(query, locations) {
  const normalized = normalizeQuery(query);

  if (!normalized) return null;

  return (
    locations.find((location) =>
      location.aliases.some((alias) => normalizeQuery(alias) === normalized),
    ) ?? null
  );
}

export function racesForCounty(countyId, counties) {
  return counties[countyId]?.races ?? [];
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
