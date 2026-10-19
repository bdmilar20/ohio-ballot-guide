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
  {
    elections = () => {},
    locations = () => {},
    offices = () => {},
    countyBoards = () => {},
    coverage = () => {},
    stampLog = () => {},
    statewideIssueText = () => {},
  },
) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohio-ballot-guide-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const electionData = await readData("elections.json");
  const locationData = await readData("locations.json");
  const officeData = await readData("offices.json");
  const countyBoardData = await readData("county-boards.json");
  const coverageData = await readData("vtrapp-coverage.json");
  const stampLogData = await readData("vtrapp-stamp-log.json");
  const statewideIssueTextData = await readData("statewide-issue-text.json");
  elections(electionData);
  locations(locationData);
  offices(officeData);
  countyBoards(countyBoardData);
  coverage(coverageData);
  stampLog(stampLogData);
  statewideIssueText(statewideIssueTextData);

  const electionFixture = join(temporaryDirectory, "elections.json");
  const locationFixture = join(temporaryDirectory, "locations.json");
  const officeFixture = join(temporaryDirectory, "offices.json");
  const countyBoardFixture = join(temporaryDirectory, "county-boards.json");
  const coverageFixture = join(temporaryDirectory, "vtrapp-coverage.json");
  const stampLogFixture = join(temporaryDirectory, "vtrapp-stamp-log.json");
  const statewideIssueTextFixture = join(temporaryDirectory, "statewide-issue-text.json");
  await writeFile(electionFixture, JSON.stringify(electionData));
  await writeFile(locationFixture, JSON.stringify(locationData));
  await writeFile(officeFixture, JSON.stringify(officeData));
  await writeFile(countyBoardFixture, JSON.stringify(countyBoardData));
  await writeFile(coverageFixture, JSON.stringify(coverageData));
  await writeFile(stampLogFixture, JSON.stringify(stampLogData));
  await writeFile(statewideIssueTextFixture, JSON.stringify(statewideIssueTextData));

  return spawnSync(
    process.execPath,
    // Every generated file the validator reads has to arrive as a fixture. A
    // path left off this list makes the checks over it read the real committed
    // data, so they pass whatever the test does and can never be exercised.
    [
      validator,
      electionFixture,
      locationFixture,
      officeFixture,
      countyBoardFixture,
      coverageFixture,
      stampLogFixture,
      statewideIssueTextFixture,
    ],
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

// The stamp log is the one file under data/ that cannot be rebuilt, and the
// gate reads "the stamp did not move" straight out of it. Until these tests
// existed the validator read the real log on every run, which is always valid,
// so none of its stamp-log checks were exercised by anything.
test("validator rejects a stamp log whose timeline is out of order", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => data.observations.reverse(),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not after the one before it; the log is read as a timeline/);
});

test("validator rejects a stamp log that observes two elections", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => {
      data.observations.at(-1).election = "20270504P";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /observes a different election than the log claims/);
});

test("validator rejects a stamp log whose observation count was edited", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => {
      data.meta.observations += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /meta.observations must match the number of observations recorded/);
});

test("validator rejects a stamp log observation that surveyed a county Ohio does not have", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => data.observations.at(-1).surveyed.push("marion-indiana"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /surveyed marion-indiana, which is not an Ohio county/);
});

test("validator rejects a stamp for a county the observation did not look at", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => {
      const observation = data.observations.at(-1);
      observation.surveyed = observation.surveyed.filter((countyId) => countyId !== "adams");
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /records a stamp for adams without listing it as surveyed/);
});

test("validator rejects a stamp that is not a timestamp", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => {
      data.observations.at(-1).stamps.adams = "sometime last week";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has an unparseable stamp for adams/);
});

test("validator rejects a stamp log that is not a list of observations", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => {
      data.observations = { "2026-10-18": {} };
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs an observations array/);
});

test("validator rejects a stamp log that does not name the election it observes", async (t) => {
  const result = await validateFixture(t, {
    stampLog: (data) => {
      delete data.meta.election;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must name the election it observes/);
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

// data/statewide-issue-text.json is generated, and the checks over it exist
// because the projector now resolves a statewide issue by comparing a county
// contest to this text. A wrong entry publishes a statewide amendment as one
// county's own content, or suppresses a genuine local issue.
test("validator rejects statewide issue text whose digest does not match its body", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.issues["state-issue-3"].body_text += " and one more sentence.";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /body_sha256 does not match its own body_text/);
});

test("validator rejects statewide issue text that omits a published issue", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => delete data.issues["state-issue-3"],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must carry exactly the issues/);
});

test("validator rejects statewide issue text for an issue nobody publishes", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.issues["state-issue-9"] = structuredClone(data.issues["state-issue-3"]);
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must carry exactly the issues/);
});

test("validator rejects statewide issue text with empty ballot text", async (t) => {
  // An empty body would match every other empty-bodied contest the projector
  // compares against it.
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      const record = data.issues["state-issue-3"];
      record.body_text = "   ";
      record.body_sha256 = null;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs non-empty ballot text/);
});

test("validator rejects a county count that disagrees with the county list", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => data.issues["state-issue-3"].counties.pop(),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /but lists/);
});

test("validator rejects statewide issue text claiming more counties than were read", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.issues["state-issue-3"].counties_read = 2;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must read every enumerable county/);
});

test("validator rejects a title reach larger than the text reach", async (t) => {
  // identified_by_title_in counts a subset of body_present_in by construction,
  // so the reverse means the counting is wrong and the measured 68-of-70 gap
  // this whole artifact exists for cannot be trusted.
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.issues["state-issue-3"].identified_by_title_in = data.issues["state-issue-3"].body_present_in + 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claims the title rule reached more counties/);
});

test("validator rejects statewide issue text that lists an unknown county", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.issues["state-issue-3"].counties[0] = "nothing";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lists non-enumerable or unknown county nothing/);
});

test("validator rejects statewide issue text generated by an older schema", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.meta.schema_version += 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /re-run npm run generate:statewide-issues/);
});

test("validator rejects statewide issue text for an election that is not published", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.meta.election.id = "1999-11-02-general";
      data.meta.election.vendor_key = "19991102G";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /which is not published/);
});

test("validator rejects a statewide issue election id that disagrees with its vendor key", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.meta.election.id = "1999-11-02-general";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /election id must match its vendor key/);
});

test("validator rejects a statewide issue artifact with county failures", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.meta.failures = { lorain: "timeout" };
      data.meta.summary.counties_failed = 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot contain county failures/);
});

test("validator recomputes the statewide issue summary", async (t) => {
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.meta.summary.body_present_in -= 1;
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /summary must be recomputable/);
});

test("validator rejects statewide issue text that does not name its generator", async (t) => {
  // The one hand edit to a generated file that leaves every other field
  // consistent: rewrite it by hand and claim something else produced it.
  const result = await validateFixture(t, {
    statewideIssueText: (data) => {
      data.meta.generated_by = "scripts/something-else.mjs";
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must name the generator that produced it/);
});
