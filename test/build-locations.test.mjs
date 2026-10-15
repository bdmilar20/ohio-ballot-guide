import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildLocations, countySlug } from "../scripts/build-locations.mjs";

const ZCTA_HEADER =
  "GEOID_ZCTA5_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_PART";
const POP_HEADER = "ZCTA5,STATE,COUNTY,GEOID,POPPT";

function zctaRow(zip, fips, name, land) {
  return `${zip}|${fips}|${name}|${land}`;
}

function popRow(zip, fips, population) {
  return `${zip},39,${fips.slice(2)},${fips},${population}`;
}

function geonamesRow(zip, place, county) {
  return ["US", zip, place, "Ohio", "OH", county, "", "", "", "", "", ""].join("\t");
}

// Two counties, and a ZIP whose larger share of land is in the county with
// fewer residents — the shape that land-area ordering gets wrong.
async function fixture(t, { zcta, pop, geonames }) {
  const directory = await mkdtemp(join(tmpdir(), "obg-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const paths = {
    zcta: join(directory, "zcta.txt"),
    pop: join(directory, "pop.txt"),
    geonames: join(directory, "US.txt"),
  };

  await Promise.all([
    writeFile(paths.zcta, [ZCTA_HEADER, ...zcta].join("\n")),
    writeFile(paths.pop, [POP_HEADER, ...pop].join("\n")),
    writeFile(paths.geonames, geonames.join("\n")),
  ]);

  return buildLocations({ ...paths, today: "2026-10-15" });
}

test("slugs a county name the way the data files key it", () => {
  assert.equal(countySlug("Franklin County"), "franklin");
  assert.equal(countySlug("Van Wert County"), "van-wert");
});

test("orders a cross-county ZIP by residents, not by land area", async (t) => {
  const { data, stats } = await fixture(t, {
    zcta: [
      zctaRow("43001", "39001", "Rural County", 900_000_000),
      zctaRow("43001", "39002", "City County", 100_000_000),
    ],
    pop: [popRow("43001", "39001", 400), popRow("43001", "39002", 9_000)],
    geonames: [geonamesRow("43001", "Somewhere", "City")],
  });

  assert.deepEqual(data.zips["43001"].county_ids, ["city", "rural"]);
  assert.equal(data.zips["43001"].order_basis, "population-2010");
  assert.equal(stats.orderDisagreements, 1);
});

test("falls back to land area when a ZIP has no population row", async (t) => {
  const { data, stats } = await fixture(t, {
    zcta: [
      zctaRow("43002", "39001", "Rural County", 900_000_000),
      zctaRow("43002", "39002", "City County", 100_000_000),
    ],
    pop: [],
    geonames: [geonamesRow("43002", "Somewhere", "Rural")],
  });

  assert.deepEqual(data.zips["43002"].county_ids, ["rural", "city"]);
  assert.equal(data.zips["43002"].order_basis, "land-area-2020");
  assert.equal(stats.orderedByLandArea, 1);
  assert.equal(stats.orderDisagreements, 0);
});

test("adds a ZIP that has no ZCTA at all", async (t) => {
  const { data, stats } = await fixture(t, {
    zcta: [zctaRow("43003", "39001", "Rural County", 900_000_000)],
    pop: [popRow("43003", "39001", 400)],
    geonames: [geonamesRow("43003", "Somewhere", "Rural"), geonamesRow("43999", "Box Only", "Rural")],
  });

  assert.deepEqual(data.zips["43999"], {
    county_ids: ["rural"],
    source: "geonames-us-postal",
    order_basis: "single-county",
  });
  assert.equal(stats.geonamesOnlyZips, 1);
  assert.equal(data.zips["43003"].order_basis, "single-county");
});

test("a place inherits every county its ZIPs touch, not GeoNames' single column", async (t) => {
  const { data, stats } = await fixture(t, {
    zcta: [
      zctaRow("43004", "39002", "City County", 100_000_000),
      zctaRow("43005", "39002", "City County", 10_000_000),
      zctaRow("43005", "39001", "Rural County", 900_000_000),
    ],
    pop: [
      popRow("43004", "39002", 20_000),
      popRow("43005", "39002", 500),
      popRow("43005", "39001", 1_200),
    ],
    // GeoNames files both ZIPs under City County alone.
    geonames: [geonamesRow("43004", "Big Town", "City"), geonamesRow("43005", "Big Town", "City")],
  });

  assert.deepEqual(data.places["big town"].county_ids, ["city", "rural"]);
  assert.equal(data.places["big town"].display_name, "Big Town");
  assert.equal(stats.multiCountyPlaces, 1);
});

test("refuses a GeoNames county the Census file does not know", async (t) => {
  await assert.rejects(
    fixture(t, {
      zcta: [zctaRow("43006", "39001", "Rural County", 900_000_000)],
      pop: [popRow("43006", "39001", 400)],
      geonames: [geonamesRow("43006", "Somewhere", "Atlantis")],
    }),
    /absent from the Census county list: Atlantis/,
  );
});
