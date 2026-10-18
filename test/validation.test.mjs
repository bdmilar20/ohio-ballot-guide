import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(projectRoot, "scripts", "validate-data.mjs");

async function readData(name) {
  return JSON.parse(await readFile(join(projectRoot, "data", name), "utf8"));
}

// Writes both data files to a scratch directory so a test can corrupt either
// one and watch the validator refuse it.
async function validateFixture(
  t,
  { elections = () => {}, locations = () => {}, offices = () => {}, countyBoards = () => {}, coverage = () => {} },
) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohio-ballot-guide-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const electionData = await readData("elections.json");
  const locationData = await readData("locations.json");
  const officeData = await readData("offices.json");
  const countyBoardData = await readData("county-boards.json");
  const coverageData = await readData("vtrapp-coverage.json");
  elections(electionData);
  locations(locationData);
  offices(officeData);
  countyBoards(countyBoardData);
  coverage(coverageData);

  const electionFixture = join(temporaryDirectory, "elections.json");
  const locationFixture = join(temporaryDirectory, "locations.json");
  const officeFixture = join(temporaryDirectory, "offices.json");
  const countyBoardFixture = join(temporaryDirectory, "county-boards.json");
  const coverageFixture = join(temporaryDirectory, "vtrapp-coverage.json");
  await writeFile(electionFixture, JSON.stringify(electionData));
  await writeFile(locationFixture, JSON.stringify(locationData));
  await writeFile(officeFixture, JSON.stringify(officeData));
  await writeFile(countyBoardFixture, JSON.stringify(countyBoardData));
  await writeFile(coverageFixture, JSON.stringify(coverageData));

  return spawnSync(
    process.execPath,
    [validator, electionFixture, locationFixture, officeFixture, countyBoardFixture, coverageFixture],
    { encoding: "utf8" },
  );
}

test("validator rejects a county board directory with a missing county", async (t) => {
  const result = await validateFixture(t, {
    countyBoards: (data) => delete data.counties.vinton,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /county board directory must cover the same counties/);
});

test("validator rejects a contest without a geographic scope", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => delete data.elections[0].statewide_races[0].scope,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor needs a scope/);
});

test("validator rejects an election that references an unknown county", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[0].counties["mariom"] = { races: [] };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /references unknown county mariom/);
});

test("validator rejects a hand-entered election deadline that disagrees with its rule", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[1].registration_deadline = "2027-04-04";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registration_deadline disagrees with Ohio law/);
});

test("validator cannot bypass an August rule by changing the month", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[2].id = "2027-09-03-special";
      data.elections[2].date = "2027-09-03";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /date disagrees with Ohio law/);
});

test("validator cannot bypass schedule checks with a non-August special", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const election = data.elections[2];
      election.id = "2027-05-04-special";
      election.date = "2027-05-04";
      election.registration_deadline = "2027-05-03";
      election.early_voting_end = "2027-05-01";
      delete election.schedule_rule;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schedule_rule is required for every election/);
});

test("validator accepts a documented one-off office closure", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[1].schedule_exceptions = { additional_closed_dates: ["2027-04-05"] };
      data.elections[1].registration_deadline = "2027-04-06";
    },
  });

  assert.equal(result.status, 0, result.stderr);
});

test("validator rejects a place name that would shadow a ZIP lookup", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.places["43215"] = { display_name: "43215", county_ids: ["franklin"], source: "geonames-us-postal" };
      data.meta.counts.places += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /place key 43215 would shadow a ZIP lookup/);
});

test("validator rejects a place key the query normalizer would never produce", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.places["Dublin, Ohio"] = { display_name: "Dublin", county_ids: ["franklin"], source: "geonames-us-postal" };
      data.meta.counts.places += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be query-normalized/);
});

test("validator rejects a ZIP pointing at a county that is not in the registry", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.zips["43215"].county_ids = ["fairborn"];
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /references unknown county fairborn/);
});

test("validator rejects a regeneration that lost a county", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      delete data.counties.vinton;
      data.meta.counts.counties -= 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 88 Ohio counties/);
});

test("validator rejects counts that disagree with the generated file", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.meta.counts.zips += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locations\.meta\.counts does not match/);
});

test("validator rejects a cross-county ZIP recorded as single-county", async (t) => {
  const result = await validateFixture(t, {
    locations: (data) => {
      data.zips["43235"].order_basis = "single-county";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /order basis disagrees with its county count/);
});

test("validator rejects populated county data without coverage metadata", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      delete data.elections[0].counties.franklin.coverage;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /franklin needs coverage metadata/);
});

test("validator accepts exact county ballot text with projection provenance", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const county = data.elections[0].counties.franklin;
      for (const race of county.races) race.source_fingerprint = `sha256:${"b".repeat(64)}`;
      county.issues.push({
        id: "franklin-children-services-levy",
        label: "Proposed Tax Levy (Additional)",
        title: "Franklin County children services levy",
        ballot_text: "Exact ballot language retained from the source.",
        choices: ["For the Levy", "Against the Levy"],
        source_url: "https://lookup.boe.ohio.gov/vtrapp/franklin/xmlview.aspx",
        source_fingerprint: `sha256:${"a".repeat(64)}`,
        last_verified: "2026-10-16",
      });
      county.coverage = {
        status: "complete",
        method: "common_to_all_precincts",
        scope: "Content present on all 10 enumerated precinct ballots",
        summary: "Precinct-specific content remains excluded.",
        source_url: "https://lookup.boe.ohio.gov/vtrapp/franklin/ballotlist.aspx",
        source_updated_at: "2026-10-16T10:00:00-04:00",
        source_age_hours_at_review: 4,
        precincts_verified: 10,
        precinct_specific_races: 0,
        precinct_specific_issues: 3,
        reviewed_at: "2026-10-16T18:00:00.000Z",
        last_verified: "2026-10-16",
      };
    },
  });

  assert.equal(result.status, 0, result.stderr);
});

test("validator rejects a county issue that lost both summary and ballot text", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[0].counties.franklin.issues.push({
        id: "franklin-empty-issue",
        label: "Issue",
        title: "Missing content",
        source_url: "https://example.gov/issue",
        last_verified: "2026-10-16",
      });
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs a summary or exact ballot text/);
});

test("validator rejects common projection metadata without a precinct count", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const coverage = data.elections[0].counties.franklin.coverage;
      coverage.status = "complete";
      coverage.method = "common_to_all_precincts";
      coverage.source_updated_at = "2026-10-16T10:00:00-04:00";
      coverage.source_age_hours_at_review = 4;
      coverage.reviewed_at = "2026-10-16T18:00:00.000Z";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /precincts_verified must be a positive integer/);
});

test("validator requires projected coverage to disclose precinct-specific content counts", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const county = data.elections[0].counties.franklin;
      for (const race of county.races) race.source_fingerprint = `sha256:${"b".repeat(64)}`;
      county.coverage = {
        status: "complete",
        method: "common_to_all_precincts",
        scope: "Content present on all 10 enumerated precinct ballots",
        summary: "Precinct-specific content remains excluded.",
        source_url: "https://lookup.boe.ohio.gov/vtrapp/franklin/ballotlist.aspx",
        source_updated_at: "2026-10-16T10:00:00-04:00",
        source_age_hours_at_review: 4,
        precincts_verified: 10,
        reviewed_at: "2026-10-16T18:00:00.000Z",
        last_verified: "2026-10-16",
      };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /precinct_specific_races must be a nonnegative integer/);
});

test("validator rejects projected county content without source fingerprints", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const county = data.elections[0].counties.franklin;
      county.coverage = {
        status: "complete",
        method: "common_to_all_precincts",
        scope: "Content present on all 10 enumerated precinct ballots",
        summary: "Precinct-specific content remains excluded.",
        source_url: "https://lookup.boe.ohio.gov/vtrapp/franklin/ballotlist.aspx",
        source_updated_at: "2026-10-16T10:00:00-04:00",
        source_age_hours_at_review: 4,
        precincts_verified: 10,
        precinct_specific_races: 0,
        precinct_specific_issues: 3,
        reviewed_at: "2026-10-16T18:00:00.000Z",
        last_verified: "2026-10-16",
      };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs a source fingerprint for common projection/);
});

test("validator rejects projected coverage whose recorded age disagrees with its timestamps", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      const county = data.elections[0].counties.franklin;
      for (const race of county.races) race.source_fingerprint = `sha256:${"b".repeat(64)}`;
      county.coverage = {
        status: "complete",
        method: "common_to_all_precincts",
        scope: "Content present on all 10 enumerated precinct ballots",
        summary: "Precinct-specific content remains excluded.",
        source_url: "https://lookup.boe.ohio.gov/vtrapp/franklin/ballotlist.aspx",
        source_updated_at: "2026-10-16T10:00:00-04:00",
        source_age_hours_at_review: 1,
        precincts_verified: 10,
        precinct_specific_races: 0,
        precinct_specific_issues: 3,
        reviewed_at: "2026-10-16T18:00:00.000Z",
        last_verified: "2026-10-16",
      };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source age disagrees with its timestamps/);
});

test("validator rejects a contest whose office has no description", async (t) => {
  const result = await validateFixture(t, {
    elections: (data) => {
      data.elections[0].statewide_races[0].office_id = "grand-vizier";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor references unknown office grand-vizier/);
});

test("validator rejects an office description with no official source", async (t) => {
  const result = await validateFixture(t, {
    offices: (data) => {
      data.offices.governor.sources = [];
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor needs at least one official source/);
});

test("validator rejects an office source that is not HTTPS", async (t) => {
  const result = await validateFixture(t, {
    offices: (data) => {
      data.offices.auditor.sources[0].url = "http://codes.ohio.gov/ohio-revised-code/section-117.11";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use HTTPS/);
});

// The generated coverage artifact is the project's answer to "which counties
// does the vendor enumerate a complete precinct list for?". Every check below
// is aimed at the same failure: the file claiming more coverage than the survey
// actually found.
//
// Each mutation changes exactly one thing and asserts exactly one message. A
// mutation that breaks two gates at once passes on whichever fires first, which
// leaves the gate under test free to be deleted with the test still green.

test("validator rejects a coverage summary that disagrees with its own records", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      data.meta.summary.enumerable += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /summary must be recomputable/);
});

test("validator rejects a coverage run that skipped part of Ohio", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => delete data.counties.vinton,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /coverage must cover the same counties/);
});

test("validator rejects a county marked enumerable without a freshness stamp", async (t) => {
  // The summary counts enumerable counties and precinct rows, not stamps, so
  // removing the stamp leaves it recomputable and this reaches the stamp gate.
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      delete data.counties[countyId].source_updated_at;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is marked enumerable without a source update stamp/);
});

test("validator rejects a county marked enumerable the vendor did not serve", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].response = "not-a-customer";
      // Keep the summary recomputable: served is counted from this field.
      data.meta.summary.served -= 1;
      data.meta.summary.not_a_customer += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is marked enumerable but the vendor did not serve it/);
});

test("validator rejects a county marked enumerable that was never offered this election", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].election_offered = false;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is marked enumerable but does not offer this election/);
});

test("validator rejects a county marked enumerable that left rows unparsed", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].unexplained_row_reasons = { "a row shape this adapter does not parse": 2 };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is marked enumerable but left rows unparsed/);
});

test("validator rejects a county marked enumerable on a request that failed", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].transport_error = true;
      // transport_errors is a summarized field, so the stored summary has to
      // follow or the recomputability gate fires first and this stops testing
      // the per-county gate it is named for.
      data.meta.summary.transport_errors += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be enumerable on a request that failed/);
});

test("validator rejects a county marked enumerable that parsed fewer rows than listed", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].precinct_rows_parsed -= 1;
      // precinct_splits sums parsed rows, so it has to follow or the summary
      // gate fires first and this stops testing the row-count gate.
      data.meta.summary.precinct_splits -= 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /parsed fewer rows than the vendor listed/);
});

test("validator rejects a county marked enumerable that declined some rows", async (t) => {
  // summarize() does not read skipped_row_reasons, so the stored summary stays
  // recomputable and this reaches the gate it is named for.
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].skipped_row_reasons = { "no ballot links in the Link cell": 3 };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is marked enumerable but declined some of the vendor's rows/);
});

test("validator rejects a county marked enumerable with no precinct rows", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId, record] = Object.entries(data.counties).find(([, candidate]) => candidate.enumerable);
      // Zero both counts so the parsed-equals-listed gate stays satisfied, and
      // follow precinct_splits so recomputability does, leaving only the
      // rows-above-zero gate to fire.
      data.meta.summary.precinct_splits -= record.precinct_rows_parsed;
      data.counties[countyId].precinct_rows_parsed = 0;
      data.counties[countyId].precinct_rows_listed = 0;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is marked enumerable with no precinct rows/);
});

test("validator rejects a county that is both enumerable and blocked", async (t) => {
  // The summary's `blocked` count is derived from `enumerable`, not from this
  // field, so adding a reason leaves the summary recomputable.
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => record.enumerable);
      data.counties[countyId].blocked = "precinct enumeration yielded no ballots";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be both enumerable and blocked/);
});

test("validator rejects a blocked county that does not say why", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      const [countyId] = Object.entries(data.counties).find(([, record]) => !record.enumerable);
      delete data.counties[countyId].blocked;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not enumerable and must say why/);
});

test("validator rejects a coverage artifact from an older survey schema", async (t) => {
  const result = await validateFixture(t, {
    coverage: (data) => {
      data.meta.schema_version = 0;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /re-run npm run survey:vtrapp/);
});
