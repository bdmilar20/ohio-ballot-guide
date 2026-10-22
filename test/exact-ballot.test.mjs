import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactBallotData,
  createExactBallotResolver,
  normalizeAddress,
} from "../src/exact-ballot.mjs";

const ODD_BALLOT = `sha256:${"a".repeat(64)}`;
const EVEN_BALLOT = `sha256:${"b".repeat(64)}`;
const SOURCE_URL = "https://votehamiltoncountyohio.gov/sample-ballot/";

function race(id) {
  return {
    id,
    scope: "Hamilton County · Vote for one",
    office: "Test office",
    office_id: "test-office",
    last_verified: "2026-10-21",
    source_url: SOURCE_URL,
    candidates: [{ name: "Test Candidate", party: null }],
  };
}

function fixture() {
  return {
    addressIndex: {
      schema_version: 1,
      election_id: "2026-11-03-general",
      county_id: "hamilton",
      provenance: {
        source_url: SOURCE_URL,
        source_sha256: "c".repeat(64),
        retrieved_at: "2026-10-21T18:55:00-04:00",
        last_verified: "2026-10-21",
      },
      coverage: {
        listed_ranges: 2,
        parsed_ranges: 2,
        precinct_count: 2,
        skipped: [],
        unexplained_rows: [],
      },
      street_ranges: [
        {
          pre_direction: "",
          street_name: "MAIN",
          street_suffix: "ST",
          post_direction: "",
          zip: "45202",
          from: 1,
          to: 99,
          parity: "odd",
          precinct_id: "CIN-01-A",
        },
        {
          pre_direction: "",
          street_name: "MAIN",
          street_suffix: "ST",
          post_direction: "",
          zip: "45202",
          from: 2,
          to: 100,
          parity: "even",
          precinct_id: "CIN-01-B",
        },
      ],
    },
    ballotBundle: {
      schema_version: 1,
      election_id: "2026-11-03-general",
      county_id: "hamilton",
      provenance: {
        source_url: SOURCE_URL,
        source_sha256: "d".repeat(64),
        retrieved_at: "2026-10-21T18:55:00-04:00",
        last_verified: "2026-10-21",
      },
      enumeration: {
        listed_precincts: 2,
        parsed_precincts: 2,
        skipped: [],
        unexplained_rows: [],
      },
      precincts: [
        { id: "CIN-01-A", name: "Cincinnati 01-A", ballot_id: ODD_BALLOT },
        { id: "CIN-01-B", name: "Cincinnati 01-B", ballot_id: EVEN_BALLOT },
      ],
      ballots: {
        [ODD_BALLOT]: { races: [race("odd-only")], issues: [] },
        [EVEN_BALLOT]: { races: [race("even-only")], issues: [] },
      },
    },
  };
}

test("normalizes only the structured address fields needed for a local match", () => {
  assert.deepEqual(
    normalizeAddress({
      house_number: " 11 ",
      pre_direction: "north",
      street_name: " O’Bryon.  Avenue ",
      street_suffix: "road.",
      post_direction: "",
      zip: "45202",
    }),
    {
      house_number: 11,
      pre_direction: "N",
      street_name: "O'BRYON AVENUE",
      street_suffix: "ROAD",
      post_direction: "",
      zip: "45202",
    },
  );
});

test("resolves odd and even street ranges to different exact ballots", () => {
  const resolve = createExactBallotResolver(fixture());
  assert.deepEqual(
    resolve({ house_number: 11, street_name: "Main", street_suffix: "St.", zip: "45202" }),
    {
      status: "matched",
      election_id: "2026-11-03-general",
      county_id: "hamilton",
      precinct: { id: "CIN-01-A", name: "Cincinnati 01-A" },
      ballot_id: ODD_BALLOT,
      ballot: { races: [race("odd-only")], issues: [] },
    },
  );
  assert.equal(
    resolve({ house_number: 12, street_name: "Main", street_suffix: "St", zip: "45202" }).ballot_id,
    EVEN_BALLOT,
  );
});

test("never repeats a voter's address in matched or failed results", () => {
  const resolve = createExactBallotResolver(fixture());
  const matched = JSON.stringify(
    resolve({ house_number: 11, street_name: "Main", street_suffix: "St", zip: "45202" }),
  );
  const unmatched = JSON.stringify(
    resolve({ house_number: 111, street_name: "Main", street_suffix: "St", zip: "45202" }),
  );
  assert.doesNotMatch(matched, /"(?:house_number|street_name|street_suffix|zip)"/);
  assert.doesNotMatch(matched, /"MAIN"|"45202"|:11(?:[,}])/);
  assert.doesNotMatch(unmatched, /"(?:house_number|street_name|street_suffix|zip)"/);
  assert.doesNotMatch(unmatched, /"MAIN"|"45202"|:111(?:[,}])/);
});

test("returns a bounded invalid result instead of guessing at malformed input", () => {
  const resolve = createExactBallotResolver(fixture());
  assert.deepEqual(
    resolve({ house_number: "12A", street_name: "Main", street_suffix: "St", zip: "45202" }),
    { status: "invalid", reason: "house number must be 1 to 5 digits" },
  );
});

test("rejects overlapping address ranges before any lookup can run", () => {
  const data = fixture();
  data.addressIndex.street_ranges[1] = {
    ...data.addressIndex.street_ranges[1],
    from: 1,
    parity: "all",
  };
  assert.throws(
    () => assertExactBallotData(data.addressIndex, data.ballotBundle),
    /street ranges 0 and 1 overlap/,
  );
});

test("rejects an index that omits a published precinct", () => {
  const data = fixture();
  data.addressIndex.street_ranges.pop();
  data.addressIndex.coverage = {
    listed_ranges: 1,
    parsed_ranges: 1,
    precinct_count: 1,
    skipped: [],
    unexplained_rows: [],
  };
  assert.throws(
    () => assertExactBallotData(data.addressIndex, data.ballotBundle),
    /does not cover every published precinct/,
  );
});

test("rejects an incomplete precinct enumeration", () => {
  const data = fixture();
  data.ballotBundle.enumeration.parsed_precincts = 1;
  assert.throws(
    () => assertExactBallotData(data.addressIndex, data.ballotBundle),
    /must preserve every listed precinct/,
  );
});

test("rejects an incomplete street-range enumeration", () => {
  const data = fixture();
  data.addressIndex.coverage.parsed_ranges = 1;
  assert.throws(
    () => assertExactBallotData(data.addressIndex, data.ballotBundle),
    /must preserve every listed street range/,
  );
});

test("rejects an exact-ballot bundle from another election", () => {
  const data = fixture();
  data.ballotBundle.election_id = "2027-05-04-primary";
  assert.throws(
    () => assertExactBallotData(data.addressIndex, data.ballotBundle),
    /name different elections/,
  );
});
