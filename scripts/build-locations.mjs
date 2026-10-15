// Generates data/locations.json: every Ohio ZIP and place name mapped to its county.
//
// Nothing in the output is hand-written. Re-run this script instead of editing
// data/locations.json. See CONTRIBUTING.md for where to download the sources.
//
//   node scripts/build-locations.mjs \
//     --zcta .cache/tab20_zcta520_county20_natl.txt \
//     --pop .cache/zcta_county_rel_10.txt \
//     --geonames .cache/US.txt

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { normalizeQuery } from "../src/lookup.mjs";

const STATE_FIPS = "39";
const STATE_USPS = "OH";

export const SOURCES = {
  zcta: {
    id: "census-zcta-county-2020",
    name: "Census Bureau 2020 ZCTA-to-county relationship file",
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
    provides: "which counties each ZCTA touches",
  },
  pop: {
    id: "census-zcta-county-2010",
    name: "Census Bureau 2010 ZCTA-to-county relationship file",
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel/zcta_county_rel_10.txt",
    provides: "population in each ZCTA-county part, used to order the county picker",
  },
  geonames: {
    id: "geonames-us-postal",
    name: "GeoNames US postal code file (CC BY 4.0)",
    url: "https://download.geonames.org/export/zip/US.zip",
    provides: "place names, and ZIP codes that have no ZCTA",
  },
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
  }
  return args;
}

export function countySlug(namelsad) {
  return namelsad
    .replace(/\s+County$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function splitLines(text) {
  return text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.length > 0);
}

function parseDelimited(text, delimiter) {
  const lines = splitLines(text);
  const header = lines[0].split(delimiter);
  return lines.slice(1).map((line) => {
    const cells = line.split(delimiter);
    return Object.fromEntries(header.map((key, index) => [key, cells[index]]));
  });
}

// 2020 relationship file: every county each ZCTA overlaps, with the land area of
// the overlap. Authoritative for *which* counties a ZIP touches.
function readZctaParts(text) {
  const counties = new Map();
  const zips = new Map();

  for (const row of parseDelimited(text, "|")) {
    const zip = row.GEOID_ZCTA5_20;
    const fips = row.GEOID_COUNTY_20;
    if (!zip || !fips?.startsWith(STATE_FIPS)) continue;
    counties.set(fips, row.NAMELSAD_COUNTY_20);
    if (!zips.has(zip)) zips.set(zip, new Map());
    zips.get(zip).set(fips, { land: Number(row.AREALAND_PART || 0) });
  }

  return { counties, zips };
}

// 2010 relationship file: the newest edition that carries population per
// ZCTA-county part. Land area is a poor proxy for where the voters are.
function readPartPopulations(text) {
  const populations = new Map();
  for (const row of parseDelimited(text, ",")) {
    if (row.STATE !== STATE_FIPS) continue;
    populations.set(`${row.ZCTA5}:${row.GEOID}`, Number(row.POPPT || 0));
  }
  return populations;
}

// GeoNames postal file: place names, and the ZIPs that have no ZCTA at all
// (PO-box-only ZIPs are absent from every Census ZCTA file).
function readGeonames(text) {
  const rows = [];
  for (const line of splitLines(text)) {
    const cells = line.split("\t");
    if (cells[4] !== STATE_USPS) continue;
    rows.push({ zip: cells[1], place: cells[2], county: cells[5] });
  }
  return rows;
}

function orderCounties(parts, populations, zip) {
  const entries = [...parts.entries()].map(([fips, { land }]) => ({
    fips,
    land,
    population: populations.get(`${zip}:${fips}`),
  }));

  const basis = entries.every((entry) => entry.population !== undefined)
    ? "population-2010"
    : "land-area-2020";

  const byLand = (left, right) => right.land - left.land || left.fips.localeCompare(right.fips);
  const ordered = [...entries].sort(
    basis === "population-2010"
      ? (left, right) => right.population - left.population || byLand(left, right)
      : byLand,
  );

  return { basis, ordered, byLand: [...entries].sort(byLand) };
}

export async function buildLocations({ zcta, pop, geonames, today }) {
  const [zctaText, popText, geonamesText] = await Promise.all([
    readFile(zcta, "utf8"),
    readFile(pop, "utf8"),
    readFile(geonames, "utf8"),
  ]);

  const { counties: countyNames, zips: zctaParts } = readZctaParts(zctaText);
  const populations = readPartPopulations(popText);
  const geonamesRows = readGeonames(geonamesText);

  const slugByFips = new Map(
    [...countyNames].map(([fips, namelsad]) => [fips, countySlug(namelsad)]),
  );
  const slugBySlug = new Map(
    [...countyNames].map(([fips, namelsad]) => [countySlug(namelsad), { fips, name: namelsad }]),
  );

  if (slugBySlug.size !== countyNames.size) {
    throw new Error("two counties produced the same slug");
  }

  const zips = {};
  const stats = { singleCounty: 0, orderedByPopulation: 0, orderedByLandArea: 0, orderDisagreements: 0 };

  for (const [zip, parts] of [...zctaParts].sort(([left], [right]) => left.localeCompare(right))) {
    const { basis, ordered, byLand } = orderCounties(parts, populations, zip);
    const countyIds = ordered.map(({ fips }) => slugByFips.get(fips));

    // Nothing was ordered when a ZIP sits in one county, and the picker never
    // appears, so the ordering rule is only recorded where it decided something.
    if (countyIds.length === 1) {
      stats.singleCounty += 1;
    } else if (basis === "population-2010") {
      stats.orderedByPopulation += 1;
      if (ordered[0].fips !== byLand[0].fips) stats.orderDisagreements += 1;
    } else {
      stats.orderedByLandArea += 1;
    }

    zips[zip] = {
      county_ids: countyIds,
      source: SOURCES.zcta.id,
      order_basis: countyIds.length === 1 ? "single-county" : basis,
    };
  }

  // Places, and the ZIPs the Census ZCTA files do not cover.
  //
  // A place's counties come from its ZIPs' Census county parts, not from
  // GeoNames' single county-per-ZIP column. GeoNames files every "Columbus"
  // ZIP under Franklin, which would hide the Delaware County part of 43235.
  const places = new Map();
  const unknownCounties = new Set();
  let geonamesOnlyZips = 0;

  for (const { zip, place, county } of geonamesRows) {
    const slug = countySlug(`${county} County`);
    if (!slugBySlug.has(slug)) {
      unknownCounties.add(county);
      continue;
    }

    if (!zctaParts.has(zip) && !zips[zip]) {
      zips[zip] = { county_ids: [slug], source: SOURCES.geonames.id, order_basis: "single-county" };
      geonamesOnlyZips += 1;
    }

    const key = normalizeQuery(place);
    if (!key || /^\d{5}$/.test(key)) continue;
    if (!places.has(key)) places.set(key, { display_name: place, counties: new Map() });

    const counties = places.get(key).counties;
    for (const countyId of zips[zip].county_ids) {
      const fips = slugBySlug.get(countyId).fips;
      const population = populations.get(`${zip}:${fips}`) ?? 0;
      counties.set(countyId, (counties.get(countyId) ?? 0) + population);
    }
  }

  if (unknownCounties.size > 0) {
    throw new Error(
      `GeoNames county names absent from the Census county list: ${[...unknownCounties].join(", ")}`,
    );
  }

  const placeOutput = {};
  let multiCountyPlaces = 0;
  for (const key of [...places.keys()].sort()) {
    const { display_name, counties } = places.get(key);
    const countyIds = [...counties.entries()]
      .sort(([leftSlug, left], [rightSlug, right]) => right - left || leftSlug.localeCompare(rightSlug))
      .map(([slug]) => slug);
    if (countyIds.length > 1) multiCountyPlaces += 1;
    placeOutput[key] = { display_name, county_ids: countyIds, source: SOURCES.geonames.id };
  }

  const countyOutput = {};
  for (const slug of [...slugBySlug.keys()].sort()) {
    const { fips, name } = slugBySlug.get(slug);
    countyOutput[slug] = { name, fips };
  }

  const sortedZips = {};
  for (const zip of Object.keys(zips).sort()) sortedZips[zip] = zips[zip];

  return {
    data: {
      meta: {
        generated_by: "scripts/build-locations.mjs",
        generated_on: today,
        state: "Ohio",
        note: "Generated file. Do not hand-edit; re-run the build script.",
        sources: Object.values(SOURCES),
        counts: {
          counties: Object.keys(countyOutput).length,
          zips: Object.keys(sortedZips).length,
          places: Object.keys(placeOutput).length,
        },
      },
      counties: countyOutput,
      zips: sortedZips,
      places: placeOutput,
    },
    stats: { ...stats, geonamesOnlyZips, multiCountyPlaces },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const missing = ["zcta", "pop", "geonames"].filter((flag) => !args[flag]);
  if (missing.length > 0) {
    console.error(`Missing ${missing.map((flag) => `--${flag}`).join(", ")}.`);
    console.error("Download the sources listed in CONTRIBUTING.md, then pass their paths.");
    process.exit(1);
  }

  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const out = args.out ?? fileURLToPath(new URL("../data/locations.json", import.meta.url));
  const { data, stats } = await buildLocations({ ...args, today });
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);

  console.log(
    [
      `Wrote ${out}`,
      `  counties: ${data.meta.counts.counties}`,
      `  ZIPs: ${data.meta.counts.zips} (${stats.geonamesOnlyZips} with no ZCTA, from GeoNames)`,
      `  places: ${data.meta.counts.places} (${stats.multiCountyPlaces} cross county lines)`,
      `  single-county ZIPs: ${stats.singleCounty}`,
      `  cross-county ZIPs ordered: ${stats.orderedByPopulation} by 2010 population, ${stats.orderedByLandArea} by 2020 land area`,
      `  orderings land area would have gotten wrong: ${stats.orderDisagreements}`,
    ].join("\n"),
  );
}
