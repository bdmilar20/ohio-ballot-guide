import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactBallotData,
  ballotContentId,
  createExactBallotResolver,
  normalizeAddress,
} from "../src/exact-ballot.mjs";

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

const ODD_BALLOT_CONTENT = { races: [race("odd-only")], issues: [] };
const EVEN_BALLOT_CONTENT = { races: [race("even-only")], issues: [] };
const ODD_BALLOT = await ballotContentId(ODD_BALLOT_CONTENT);
const EVEN_BALLOT = await ballotContentId(EVEN_BALLOT_CONTENT);

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
        [ODD_BALLOT]: ODD_BALLOT_CONTENT,
        [EVEN_BALLOT]: EVEN_BALLOT_CONTENT,
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
      street_suffix: "RD",
      post_direction: "",
      zip: "45202",
    },
  );
});

test("canonicalizes full and abbreviated street suffixes", () => {
  for (const street_suffix of ["Street", "STREET", "St.", "ST"]) {
    assert.equal(
      normalizeAddress({ house_number: 11, street_name: "Main", street_suffix, zip: "45202" }).street_suffix,
      "ST",
    );
  }
});

test("canonicalizes USPS common suffix forms and RAMP", () => {
  const cases = new Map([
    ["AV", "AVE"],
    ["AVEN", "AVE"],
    ["DRV", "DR"],
    ["TERR", "TER"],
    ["PKY", "PKWY"],
    ["CIRC", "CIR"],
    ["HIWAY", "HWY"],
    ["LA", "LN"],
    ["STR", "ST"],
    ["PLC", "PL"],
    ["RAMP", "RAMP"],
  ]);
  for (const [street_suffix, expected] of cases) {
    assert.equal(
      normalizeAddress({ house_number: 11, street_name: "Main", street_suffix, zip: "45202" }).street_suffix,
      expected,
    );
  }
});

test("resolves odd and even street ranges to different exact ballots", async () => {
  const resolve = await createExactBallotResolver(fixture());
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

test("resolves a direction consistently whether the source stores it in the name or direction field", async () => {
  for (const sourceShape of [
    { pre_direction: "", street_name: "N BEND" },
    { pre_direction: "N", street_name: "BEND" },
  ]) {
    const data = fixture();
    data.addressIndex.street_ranges = data.addressIndex.street_ranges.map((rule) => ({
      ...rule,
      ...sourceShape,
    }));
    const resolve = await createExactBallotResolver(data);
    for (const address of [
      { pre_direction: "North", street_name: "Bend" },
      { pre_direction: "N", street_name: "Bend" },
      { street_name: "North Bend" },
      { street_name: "N Bend" },
    ]) {
      assert.equal(
        resolve({ house_number: 11, street_suffix: "Street", zip: "45202", ...address }).ballot_id,
        ODD_BALLOT,
      );
    }
  }
});

test("resolves a post-direction in either the name or direction field", async () => {
  const data = fixture();
  data.addressIndex.street_ranges = data.addressIndex.street_ranges.map((rule) => ({
    ...rule,
    street_name: "MAIN W",
  }));
  const resolve = await createExactBallotResolver(data);
  assert.equal(
    resolve({ house_number: 11, street_name: "Main West", street_suffix: "Street", zip: "45202" }).ballot_id,
    ODD_BALLOT,
  );
  assert.equal(
    resolve({ house_number: 11, street_name: "Main", street_suffix: "St", post_direction: "W", zip: "45202" }).ballot_id,
    ODD_BALLOT,
  );
});

test("rejects a collision between structurally different direction readings", async () => {
  const data = fixture();
  data.addressIndex.street_ranges[0].street_name = "N BEND";
  data.addressIndex.street_ranges.push({
    ...data.addressIndex.street_ranges[0],
    pre_direction: "N",
    street_name: "BEND",
    precinct_id: "CIN-01-B",
  });
  data.addressIndex.coverage.listed_ranges = 3;
  data.addressIndex.coverage.parsed_ranges = 3;
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /street ranges 0 and 2 overlap/,
  );
});

test("requires direction words inside published street names to use canonical abbreviations", async () => {
  const data = fixture();
  data.addressIndex.street_ranges[0].street_name = "NORTH BEND";
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /street_name must be normalized/,
  );
});

test("never repeats a voter's address in matched or failed results", async () => {
  const resolve = await createExactBallotResolver(fixture());
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

test("returns a bounded invalid result instead of guessing at malformed input", async () => {
  const resolve = await createExactBallotResolver(fixture());
  assert.deepEqual(
    resolve({ house_number: "12A", street_name: "Main", street_suffix: "St", zip: "45202" }),
    { status: "invalid", reason: "house number must be 1 to 5 digits" },
  );
});

test("rejects overlapping address ranges before any lookup can run", async () => {
  const data = fixture();
  data.addressIndex.street_ranges[1] = {
    ...data.addressIndex.street_ranges[1],
    from: 1,
    parity: "all",
  };
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /street ranges 0 and 1 overlap/,
  );
});

test("rejects an index that omits a published precinct", async () => {
  const data = fixture();
  data.addressIndex.street_ranges.pop();
  data.addressIndex.coverage = {
    listed_ranges: 1,
    parsed_ranges: 1,
    precinct_count: 1,
    skipped: [],
    unexplained_rows: [],
  };
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /does not cover every published precinct/,
  );
});

test("rejects an incomplete precinct enumeration", async () => {
  const data = fixture();
  data.ballotBundle.enumeration.parsed_precincts = 1;
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /must preserve every listed precinct/,
  );
});

test("rejects an incomplete street-range enumeration", async () => {
  const data = fixture();
  data.addressIndex.coverage.parsed_ranges = 1;
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /must preserve every listed street range/,
  );
});

test("rejects an exact-ballot bundle from another election", async () => {
  const data = fixture();
  data.ballotBundle.election_id = "2027-05-04-primary";
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /name different elections/,
  );
});

test("rejects a ballot id that does not match its canonical content", async () => {
  const data = fixture();
  const falseId = `sha256:${"a".repeat(64)}`;
  data.ballotBundle.ballots[falseId] = data.ballotBundle.ballots[ODD_BALLOT];
  delete data.ballotBundle.ballots[ODD_BALLOT];
  data.ballotBundle.precincts[0].ballot_id = falseId;
  await assert.rejects(
    assertExactBallotData(data.addressIndex, data.ballotBundle),
    /does not match its content digest/,
  );
});
