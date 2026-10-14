export function normalizeQuery(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/,?\s+oh(?:io)?$/i, "")
    .replace(/\s+/g, " ");
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

export function racesForLocation(location, counties) {
  if (!location) return [];
  return counties[location.county_id]?.races ?? [];
}
