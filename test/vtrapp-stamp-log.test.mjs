import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertRefreshBundle, gateRefresh } from "../scripts/gate-vtrapp.mjs";
import {
  CANDIDATE_ELECTIONS_FILE,
  candidateDigest,
  jsonText,
  manifestDigest,
  REFRESH_BUNDLE_SCHEMA_VERSION,
  REFRESH_INPUT_FILES,
  REFRESH_MANIFEST_FILE,
} from "../scripts/refresh-vtrapp.mjs";
import {
  appendObservation,
  assertSettled,
  assertStampLog,
  emptyLog,
  observationFromCoverage,
  settleCounty,
  settlement,
  STAMP_LOG_SCHEMA_VERSION,
} from "../scripts/vtrapp-stamp-log.mjs";

const ELECTION = { id: "2026-11-03-general", vendor_key: "20261103G" };
const HOUR = 3_600_000;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const candidateText = await readFile(join(projectRoot, "data", "elections.json"), "utf8");

/** A log built from plain (when, what the stamp said) pairs. */
function logOf(...entries) {
  let log = emptyLog({ election: ELECTION });
  for (const [observedAt, stamps] of entries) {
    log = appendObservation(log, {
      observed_at: observedAt,
      election: ELECTION.vendor_key,
      surveyed: Object.keys(stamps),
      stamps,
    });
  }
  return log;
}

/**
 * A refresh job as refreshVtrapp writes one. The election key is part of the
 * real shape, so fixtures carry it rather than omitting the field the gate
 * compares against the log.
 */
const job = (fields) => ({ vendor_election_key: ELECTION.vendor_key, ...fields });
// The projection inputs a real bundle records a digest for. A summary without
// them is not replayable, so the gate refuses it and fixtures carry them.
const inputTexts = Object.fromEntries(REFRESH_INPUT_FILES.map((file) => [file, `{"fixture":"${file}"}\n`]));
const summaryInputs = REFRESH_INPUT_FILES.map((file) => ({
  file,
  sha256: candidateDigest(inputTexts[file]),
  source: "repository",
}));
// The manifest is the fourth projection input: it carries the office mappings
// and age limits. It is recorded by semantic digest, so the fixture text and
// the recorded digest have to be derived from the same value.
const manifestFixture = {
  schema_version: 1,
  jobs: [{
    county: "adams",
    election: ELECTION.vendor_key,
    projection: { max_source_age_hours: 24, office_mappings: { "For County Commissioner": "county-commissioner" } },
  }],
};
inputTexts[REFRESH_MANIFEST_FILE] = jsonText(manifestFixture);

function summaryOf(jobs, fields = {}) {
  return {
    schema_version: REFRESH_BUNDLE_SCHEMA_VERSION,
    status: "complete",
    completed_jobs: jobs.length,
    candidate_elections_file: CANDIDATE_ELECTIONS_FILE,
    candidate_sha256: candidateDigest(candidateText),
    validation: "Validated fixture candidate.",
    inputs: summaryInputs,
    manifest_sha256: manifestDigest(manifestFixture),
    jobs,
    ...fields,
  };
}

function gateJobs(log, jobs, options = {}) {
  return gateRefresh(log, summaryOf(jobs), { candidateText, ...options });
}

test("a single observation never settles a county, and does not accuse it of moving", () => {
  const log = logOf(["2026-10-18T12:00:00Z", { adams: "2026-10-12T14:32:40-04:00" }]);
  const result = settleCounty(log, "adams");
  assert.equal(result.status, "seen-once");
  assert.equal(result.agreeing_sightings, 1);
  assert.match(result.detail, /one more sighting decides it/);
});

test("an unmoved stamp settles once two observations span the quiet window", () => {
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf(["2026-10-18T12:00:00Z", { adams: stamp }], ["2026-10-20T13:00:00Z", { adams: stamp }]);
  assert.equal(settleCounty(log, "adams").status, "settled");
  assert.equal(settleCounty(log, "adams", { quietHours: 49 }).status, "settled", "the window is inclusive at its edge");
  assert.equal(settleCounty(log, "adams", { quietHours: 50 }).status, "unsettled");
  assert.equal(settleCounty(log, "adams", { quietHours: 50 }).quiet_hours, 49);
});

test("the quiet span is measured between observations, not from the stamp's age", () => {
  // A stamp six weeks old, seen twice two hours apart, is not settled: the
  // age-based reading would call it the stalest county in the state and the
  // movement-based reading simply has not watched it long enough yet.
  const stamp = "2026-09-02T09:00:00-04:00";
  const log = logOf(["2026-10-18T12:00:00Z", { huron: stamp }], ["2026-10-18T14:00:00Z", { huron: stamp }]);
  const result = settleCounty(log, "huron");
  assert.equal(result.status, "unsettled");
  assert.equal(result.quiet_hours, 2);
});

test("a stamp that moves resets the evidence rather than averaging it", () => {
  const log = logOf(
    ["2026-10-10T12:00:00Z", { summit: "2026-10-01T09:00:00-04:00" }],
    ["2026-10-14T12:00:00Z", { summit: "2026-10-01T09:00:00-04:00" }],
    ["2026-10-18T12:00:00Z", { summit: "2026-10-17T16:00:00-04:00" }],
  );
  const result = settleCounty(log, "summit");
  assert.equal(result.status, "moving");
  assert.equal(result.stamp, "2026-10-17T16:00:00-04:00");
  assert.match(result.detail, /still editing/);
});

test("agreement across a gap still counts, because the stamp only moves forward", () => {
  // A county absent from the middle run is not evidence of a change: an edit
  // would have advanced the stamp, and an advanced stamp cannot come back.
  const stamp = "2026-10-01T09:00:00-04:00";
  const log = logOf(
    ["2026-10-10T12:00:00Z", { noble: stamp }],
    ["2026-10-14T12:00:00Z", { adams: "2026-10-12T14:32:40-04:00" }],
    ["2026-10-18T12:00:00Z", { noble: stamp }],
  );
  const result = settleCounty(log, "noble");
  assert.equal(result.status, "settled");
  assert.equal(result.agreeing_sightings, 2);
  assert.equal(result.quiet_hours, 192);
});

test("a stamp moving backwards is reported rather than settled", () => {
  const log = logOf(
    ["2026-10-10T12:00:00Z", { pike: "2026-10-09T09:00:00-04:00" }],
    ["2026-10-18T12:00:00Z", { pike: "2026-10-01T09:00:00-04:00" }],
    ["2026-10-20T12:00:00Z", { pike: "2026-10-01T09:00:00-04:00" }],
  );
  const result = settleCounty(log, "pike");
  assert.equal(result.status, "inconsistent");
  assert.match(result.detail, /not supposed to move backwards/);
});

test("a stamp that leaves and returns is not two agreeing sightings", () => {
  // Pins the walk back through the agreeing run rather than a comparison of
  // the two ends: a revert makes the ends equal without the stamp having held,
  // and here it is the regression itself that gets reported.
  const original = "2026-10-01T09:00:00-04:00";
  const log = logOf(
    ["2026-10-08T12:00:00Z", { ross: original }],
    ["2026-10-12T12:00:00Z", { ross: "2026-10-11T09:00:00-04:00" }],
    ["2026-10-16T12:00:00Z", { ross: original }],
  );
  const result = settleCounty(log, "ross");
  assert.notEqual(result.status, "settled");
  assert.equal(result.status, "inconsistent");
});

test("a county with no stamp anywhere in the log is unobserved", () => {
  const log = logOf(["2026-10-18T12:00:00Z", { adams: "2026-10-12T14:32:40-04:00" }]);
  assert.equal(settleCounty(log, "lake").status, "unobserved");
});

test("settlement covers every county any observation looked at, stamp or not", () => {
  let log = emptyLog({ election: ELECTION });
  log = appendObservation(log, {
    observed_at: "2026-10-18T12:00:00Z",
    election: ELECTION.vendor_key,
    surveyed: ["adams", "lake"],
    stamps: { adams: "2026-10-12T14:32:40-04:00" },
  });
  const counties = settlement(log);
  assert.deepEqual(Object.keys(counties), ["adams", "lake"]);
  assert.equal(counties.lake.status, "unobserved");
});

test("the log refuses to be rewritten out of order or across elections", () => {
  const log = logOf(["2026-10-18T12:00:00Z", { adams: "2026-10-12T14:32:40-04:00" }]);
  assert.throws(
    () =>
      appendObservation(log, {
        observed_at: "2026-10-17T12:00:00Z",
        election: ELECTION.vendor_key,
        surveyed: ["adams"],
        stamps: { adams: "2026-10-12T14:32:40-04:00" },
      }),
    /does not follow the last one/,
  );
  assert.throws(
    () =>
      appendObservation(log, {
        observed_at: "2026-10-19T12:00:00Z",
        election: "20260505P",
        surveyed: ["adams"],
        stamps: { adams: "2026-10-12T14:32:40-04:00" },
      }),
    /this log observes election "20261103G"/,
  );
  assert.equal(log.observations.length, 1, "a rejected append must not mutate the log");
});

test("a coverage survey reduces to one observation carrying only observed stamps", () => {
  const observation = observationFromCoverage(
    {
      meta: { generated_by: "scripts/survey-vtrapp.mjs", election: ELECTION },
      counties: {
        adams: { source_updated_at: "2026-10-12T14:32:40-04:00", enumerable: true },
        lake: { source_updated_at: "2026-10-05T09:00:00-04:00", enumerable: false },
        butler: { response: "not-a-customer" },
      },
    },
    { observedAt: new Date("2026-10-18T12:00:00Z") },
  );
  assert.deepEqual(observation.surveyed, ["adams", "lake", "butler"]);
  assert.deepEqual(Object.keys(observation.stamps), ["adams", "lake"]);
  assert.equal(observation.election, "20261103G");
  assert.equal(observation.observed_at, "2026-10-18T12:00:00.000Z");
});

test("the gate counts the walk itself as the newest sighting", () => {
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf(["2026-10-18T12:00:00Z", { adams: stamp }]);
  // One survey plus a walk two days later is two agreeing sightings, so the
  // ingest closes the gap between the last survey and the published data.
  const result = assertSettled(log, { countyId: "adams", stamp, observedAt: "2026-10-20T13:00:00Z" });
  assert.equal(result.status, "settled");
  assert.equal(result.quiet_hours, 49);

  // A board that edited after the survey moved the stamp, so the walk
  // disagrees with every sighting before it and the county waits.
  assert.throws(
    () => assertSettled(log, { countyId: "adams", stamp: "2026-10-19T08:00:00-04:00", observedAt: "2026-10-20T13:00:00Z" }),
    /adams is not settled: the stamp changed/,
  );
});

test("a later survey vouches for an earlier walk at the same stamp", () => {
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf(["2026-10-18T12:00:00Z", { adams: stamp }], ["2026-10-21T12:00:00Z", { adams: stamp }]);
  // The walk sits between two agreeing surveys. Since the stamp only moves
  // forward, the later survey proves the captured ballot is still current, so
  // walking first and settling afterwards is allowed.
  const result = assertSettled(log, { countyId: "adams", stamp, observedAt: "2026-10-18T13:00:00Z" });
  assert.equal(result.status, "settled");
  assert.equal(result.quiet_hours, 72);
});

test("the gate refuses a walk the board superseded, even once the new stamp settles", () => {
  // This is the failure the status check alone misses: adams settles fine at
  // its new stamp while the data in hand is the ballot it replaced.
  const walked = "2026-10-12T14:32:40-04:00";
  const current = "2026-10-19T08:00:00-04:00";
  const log = logOf(["2026-10-20T12:00:00Z", { adams: current }], ["2026-10-23T12:00:00Z", { adams: current }]);
  assert.equal(settleCounty(log, "adams").status, "settled");
  assert.throws(
    () => assertSettled(log, { countyId: "adams", stamp: walked, observedAt: "2026-10-18T13:00:00Z" }),
    /adams settled at 2026-10-19T08:00:00-04:00, but the data in hand was walked at the superseded 2026-10-12T14:32:40-04:00/,
  );
});

test("gateRefresh blocks the unsettled jobs in a bundle and names them", () => {
  const adamsStamp = "2026-10-12T14:32:40-04:00";
  const huronStamp = "2026-09-02T09:00:00-04:00";
  const log = logOf(
    ["2026-10-18T12:00:00Z", { adams: adamsStamp, huron: huronStamp }],
    ["2026-10-21T12:00:00Z", { adams: adamsStamp, huron: "2026-10-20T15:00:00-04:00" }],
  );
  const results = gateJobs(log, [
    job({ county_id: "adams", source_updated_at: adamsStamp, fetched_at: "2026-10-21T13:00:00Z" }),
    job({ county_id: "huron", source_updated_at: "2026-10-20T15:00:00-04:00", fetched_at: "2026-10-21T13:00:00Z" }),
  ]);
  assert.deepEqual(
    results.map(({ county_id: county, passed }) => [county, passed]),
    [["adams", true], ["huron", false]],
  );
  assert.match(results[1].detail, /huron is not settled/);
});

test("gateRefresh rejects a bundle with nothing in it rather than passing it", () => {
  const log = logOf(["2026-10-18T12:00:00Z", { adams: "2026-10-12T14:32:40-04:00" }]);
  assert.throws(() => gateRefresh(log, summaryOf([]), { candidateText }), /no jobs to gate/);
  assert.throws(() => gateRefresh(log, {}, { candidateText }), /must be schema 3/);
});

test("the publication gate is bound to one complete, validated candidate artifact", async (t) => {
  const jobs = [job({
    county_id: "adams",
    source_updated_at: "2026-10-12T14:32:40-04:00",
    fetched_at: "2026-10-20T13:00:00Z",
  })];
  const valid = summaryOf(jobs);
  assert.equal(assertRefreshBundle(valid, candidateText), valid);

  await t.test("complete status", () => {
    assert.throws(() => assertRefreshBundle({ ...valid, status: "running" }, candidateText), /is not complete/);
  });
  await t.test("job count", () => {
    assert.throws(() => assertRefreshBundle({ ...valid, completed_jobs: 0 }, candidateText), /completed_jobs does not match/);
  });
  await t.test("fixed candidate path", () => {
    assert.throws(
      () => assertRefreshBundle({ ...valid, candidate_elections_file: "../elections.json" }, candidateText),
      /must name elections\.candidate\.json/,
    );
  });
  await t.test("validation evidence", () => {
    for (const validation of ["", "   "]) {
      assert.throws(
        () => assertRefreshBundle({ ...valid, validation }, candidateText),
        /no recorded candidate validation/,
      );
    }
  });
  await t.test("recorded digest", () => {
    assert.throws(() => assertRefreshBundle({ ...valid, candidate_sha256: "sha256:nope" }, candidateText), /no valid candidate_sha256/);
  });
  await t.test("candidate presence", () => {
    assert.throws(() => assertRefreshBundle(valid), /has no readable elections\.candidate\.json/);
  });
  await t.test("exact candidate bytes", () => {
    assert.throws(
      () => assertRefreshBundle(valid, jsonText({ elections: [{ id: "another-run" }] })),
      /candidate file digest is .* but this refresh summary records/,
    );
  });

  // A projection decision depends on three data files beside the manifest. A
  // summary that does not record them describes a bundle nobody can replay,
  // and a recorded digest nobody compares is a claim about bytes rather than a
  // check of them.
  await t.test("every projection input is recorded", () => {
    assert.throws(() => assertRefreshBundle({ ...valid, inputs: undefined }, candidateText), /records no inputs/);
    for (const file of REFRESH_INPUT_FILES) {
      assert.throws(
        () => assertRefreshBundle({ ...valid, inputs: summaryInputs.filter((entry) => entry.file !== file) }, candidateText),
        new RegExp(`records no digest for ${file.replace(".", "\\.")}`),
      );
      assert.throws(
        () => assertRefreshBundle(
          { ...valid, inputs: summaryInputs.map((entry) => (entry.file === file ? { ...entry, sha256: "sha256:nope" } : entry)) },
          candidateText,
        ),
        new RegExp(`no valid sha256 for ${file.replace(".", "\\.")}`),
      );
    }
  });

  // Found in review: the three data files were verified and the manifest was
  // not, so the one input that actually names an office could be swapped with
  // every other check still passing.
  await t.test("the manifest the run projected under is recorded and verified", () => {
    assert.throws(
      () => assertRefreshBundle({ ...valid, manifest_sha256: undefined }, candidateText),
      /no valid manifest_sha256/,
    );
    assert.throws(
      () => assertRefreshBundle({ ...valid, manifest_sha256: "sha256:nope" }, candidateText),
      /no valid manifest_sha256/,
    );
    assert.throws(
      () => assertRefreshBundle(valid, candidateText, { ...inputTexts, [REFRESH_MANIFEST_FILE]: null }),
      /has no readable manifest\.json/,
    );
    assert.throws(
      () => assertRefreshBundle(valid, candidateText, { ...inputTexts, [REFRESH_MANIFEST_FILE]: "{" }),
      /unreadable manifest\.json/,
    );
    assert.throws(
      () => assertRefreshBundle(valid, candidateText, { ...inputTexts, [REFRESH_MANIFEST_FILE]: '{"edited":true}\n' }),
      /manifest\.json in this refresh bundle is .* but its summary records/,
    );
  });

  // Reformatting a manifest changes no decision, so it must not refuse: the
  // digest is over a key-sorted form for exactly this reason.
  await t.test("a reformatted manifest carrying the same decisions still verifies", () => {
    const reordered = { jobs: manifestFixture.jobs, schema_version: manifestFixture.schema_version };
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(manifestFixture));
    assert.equal(
      assertRefreshBundle(valid, candidateText, { ...inputTexts, [REFRESH_MANIFEST_FILE]: JSON.stringify(reordered) }),
      valid,
    );
  });

  await t.test("a recorded input digest is verified against the bundle's bytes", () => {
    assert.equal(assertRefreshBundle(valid, candidateText, inputTexts), valid);
    for (const file of REFRESH_INPUT_FILES) {
      assert.throws(
        () => assertRefreshBundle(valid, candidateText, { ...inputTexts, [file]: null }),
        new RegExp(`has no readable ${file.replace(".", "\\.")}`),
      );
      assert.throws(
        () => assertRefreshBundle(valid, candidateText, { ...inputTexts, [file]: '{"edited":true}\n' }),
        /in this refresh bundle is .* but its summary records/,
      );
    }
  });
});

test("a zero quiet window still requires two independent sightings", () => {
  // --quiet-hours 0 is a reasonable thing to type while debugging; it must not
  // turn one sighting into proof that nothing moved.
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf([new Date(Date.now() - HOUR).toISOString(), { adams: stamp }]);
  assert.equal(settleCounty(log, "adams", { quietHours: 0 }).status, "seen-once");
  assert.equal(
    assertSettled(log, { countyId: "adams", stamp, observedAt: new Date().toISOString(), quietHours: 0 }).status,
    "settled",
  );
});

test("the schema version is pinned so a reshaped log cannot be read as this one", () => {
  assert.equal(STAMP_LOG_SCHEMA_VERSION, 1);
  assert.throws(
    () =>
      appendObservation(
        { meta: { schema_version: 2, election: ELECTION }, observations: [] },
        { observed_at: "2026-10-18T12:00:00Z", election: ELECTION.vendor_key, surveyed: ["adams"], stamps: {} },
      ),
    /must be schema 1/,
  );
});

test("the CLI exits nonzero on an unsettled bundle and zero on a settled one", async (t) => {
  // The exit code is the whole point of the gate: it has to be usable in front
  // of publishing without anyone reading its output.
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-gate-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const stamp = "2026-10-12T14:32:40-04:00";
  const logPath = join(directory, "log.json");
  await writeFile(
    logPath,
    JSON.stringify(logOf(["2026-10-18T12:00:00Z", { adams: stamp, huron: "2026-09-02T09:00:00-04:00" }])),
  );

  // The gate verifies each recorded input digest against the bundle's own copy
  // and hands those copies to the canonical validator, so a bundle fixture
  // carries the repository's real input files rather than placeholders.
  const repositoryInputs = Object.fromEntries(
    await Promise.all(REFRESH_INPUT_FILES.map(async (file) => [
      file,
      await readFile(join(projectRoot, "data", file), "utf8"),
    ])),
  );
  const repositoryInputDigests = REFRESH_INPUT_FILES.map((file) => ({
    file,
    sha256: candidateDigest(repositoryInputs[file]),
    source: "repository",
  }));
  const writeInputs = async (path, inputs = repositoryInputs) => {
    for (const [file, text] of Object.entries(inputs)) await writeFile(join(path, file), text);
    if (!(REFRESH_MANIFEST_FILE in inputs)) {
      await writeFile(join(path, REFRESH_MANIFEST_FILE), inputTexts[REFRESH_MANIFEST_FILE]);
    }
  };
  const bundle = async (jobs) => {
    const path = join(directory, `refresh-${jobs[0].county_id}-${jobs.length}`);
    await mkdir(path);
    await writeFile(join(path, CANDIDATE_ELECTIONS_FILE), candidateText);
    await writeInputs(path);
    await writeFile(join(path, "summary.json"), JSON.stringify(summaryOf(jobs, { inputs: repositoryInputDigests })));
    return path;
  };
  const gate = (args) =>
    spawnSync(process.execPath, [join(projectRoot, "scripts", "gate-vtrapp.mjs"), "--log", logPath, ...args], {
      encoding: "utf8",
    });

  const settled = await bundle([job({ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })]);
  const pass = gate(["--refresh", settled]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /All 1 counties .* are settled at the stamp they were walked at/);

  // A hand-built summary can recompute the digest and claim "lgtm". The gate
  // must re-run the canonical validator rather than trust that string.
  const invalidCandidateText = jsonText({ elections: [] });
  const forged = join(directory, "refresh-forged-validation");
  await mkdir(forged);
  await writeFile(join(forged, CANDIDATE_ELECTIONS_FILE), invalidCandidateText);
  await writeInputs(forged);
  await writeFile(
    join(forged, "summary.json"),
    JSON.stringify(summaryOf(
      [job({ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })],
      { validation: "lgtm", candidate_sha256: candidateDigest(invalidCandidateText), inputs: repositoryInputDigests },
    )),
  );
  const unvalidated = gate(["--refresh", forged]);
  assert.equal(unvalidated.status, 1);
  assert.match(unvalidated.stderr, /candidate elections data failed validation/);

  // The office a county publishes is derived from the bundled patterns and
  // bounded by the bundled survey, so editing one of those after the refresh
  // changes what a replay would publish. The gate reads the bundle's own
  // copies and must refuse when they no longer match the recorded digest.
  const editedInput = join(directory, "refresh-edited-input");
  await mkdir(editedInput);
  await writeFile(join(editedInput, CANDIDATE_ELECTIONS_FILE), candidateText);
  await writeInputs(editedInput, { ...repositoryInputs, "office-title-patterns.json": '{"edited":true}\n' });
  await writeFile(
    join(editedInput, "summary.json"),
    JSON.stringify(summaryOf(
      [job({ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })],
      { inputs: repositoryInputDigests },
    )),
  );
  const tampered = gate(["--refresh", editedInput]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /office-title-patterns\.json in this refresh bundle is .* but its summary records/);

  // The gate re-runs the canonical validator, and it has to run it over the
  // bundle's own inputs. Before this it passed only the candidate, locations,
  // offices and county boards, so a bundled pattern file the validator would
  // refuse was never read: the repository's good copy was checked instead.
  const unusedPattern = JSON.parse(await readFile(join(projectRoot, "data", "office-title-patterns.json"), "utf8"));
  unusedPattern.patterns.push({ printed: "Dogcatcher", office_id: "county-auditor", office: "County Dogcatcher" });
  const unusedPatternText = `${JSON.stringify(unusedPattern, null, 2)}\n`;
  const badInput = join(directory, "refresh-bad-input");
  await mkdir(badInput);
  await writeFile(join(badInput, CANDIDATE_ELECTIONS_FILE), candidateText);
  await writeInputs(badInput, { ...repositoryInputs, "office-title-patterns.json": unusedPatternText });
  await writeFile(
    join(badInput, "summary.json"),
    JSON.stringify(summaryOf(
      [job({ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })],
      {
        inputs: repositoryInputDigests.map((entry) => (entry.file === "office-title-patterns.json"
          ? { ...entry, sha256: candidateDigest(unusedPatternText) }
          : entry)),
      },
    )),
  );
  const badBundledInput = gate(["--refresh", badInput]);
  assert.equal(badBundledInput.status, 1);
  assert.match(badBundledInput.stderr, /every office title pattern must match at least one title the survey found/);

  // The stamp evidence belongs to the exact validated candidate. Editing the
  // candidate after refresh must invalidate the bundle before county
  // settlement is considered.
  await writeFile(join(settled, CANDIDATE_ELECTIONS_FILE), jsonText({ elections: [{ id: "mixed-in" }] }));
  const altered = gate(["--refresh", settled]);
  assert.equal(altered.status, 1);
  assert.match(altered.stderr, /candidate file digest is .* but this refresh summary records/);
  await rm(join(settled, CANDIDATE_ELECTIONS_FILE));
  const missing = gate(["--refresh", settled]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /refresh bundle is missing elections\.candidate\.json/);

  // Huron's board edited after the only survey, so the walk disagrees with it.
  const moved = await bundle([
    job({ county_id: "huron", source_updated_at: "2026-10-19T08:00:00-04:00", fetched_at: "2026-10-20T13:00:00Z" }),
  ]);
  const fail = gate(["--refresh", moved]);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /BLOCKED huron/);
  assert.match(fail.stderr, /1 of 1 counties .* are not settled enough to publish/);

  // The report form needs no bundle and names what the log does and does not support.
  const report = gate([]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /seen-once \(2\): adams, huron/);
  assert.match(report.stdout, /1 observation\(s\) in the log/);

  // A quiet window the log cannot support must not be silently rounded down.
  const bad = gate(["--refresh", settled, "--quiet-hours", "nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--quiet-hours must be a nonnegative number/);
});

test("the gate CLI refuses a log that would not survive npm run check", async (t) => {
  // --log takes any file, and this command decides whether to publish from it.
  // A hand-edited log must stop the gate rather than be read as a timeline.
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-gate-badlog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const stamp = "2026-10-12T14:32:40-04:00";
  const ordered = logOf(["2026-10-14T12:00:00Z", { adams: stamp }], ["2026-10-18T12:00:00Z", { adams: stamp }]);
  const write = async (name, log) => {
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(log));
    return path;
  };
  const gate = (logPath, args = []) =>
    spawnSync(process.execPath, [join(projectRoot, "scripts", "gate-vtrapp.mjs"), "--log", logPath, ...args], {
      encoding: "utf8",
    });

  const good = gate(await write("ordered.json", ordered));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /settled \(1\): adams/);

  const scrambled = { ...ordered, observations: [ordered.observations[1], ordered.observations[0]] };
  const bad = gate(await write("scrambled.json", scrambled));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /observation 2 is not after the one before it/);

  // The report form and the bundle form read the same log, so both must refuse it.
  const bundle = join(directory, "refresh");
  await mkdir(bundle);
  await writeFile(
    join(bundle, "summary.json"),
    JSON.stringify({ jobs: [job({ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })] }),
  );
  const badBundle = gate(await write("scrambled2.json", scrambled), ["--refresh", bundle]);
  assert.equal(badBundle.status, 1);
  assert.match(badBundle.stderr, /observation 2 is not after the one before it/);
});

test("gateRefresh rejects a malformed bundle instead of blaming the county", () => {
  // A job missing a field this gate reads would otherwise come back as the
  // county being unsettled, which reads as a finding about a board.
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf(["2026-10-18T12:00:00Z", { adams: stamp }]);
  assert.throws(
    () => gateJobs(log, [job({ source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })]),
    /refresh job 1 does not name a county/,
  );
  assert.throws(
    () => gateJobs(log, [job({ county_id: "adams", fetched_at: "2026-10-20T13:00:00Z" })]),
    /refresh job 1 \(adams\) has no source_updated_at/,
  );
  assert.throws(
    () => gateJobs(log, [job({ county_id: "adams", source_updated_at: stamp })]),
    /refresh job 1 \(adams\) has no fetched_at/,
  );
  assert.throws(
    () => gateJobs(log, [{ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" }]),
    /refresh job 1 \(adams\) does not name the vendor election it walked/,
  );
  // A log with no election names nothing for the job to match, so there is no
  // comparison to make. Reading it as "no mismatch found" would pass the bundle.
  assert.throws(
    () => gateJobs(
      { ...log, meta: { ...log.meta, election: undefined } },
      [job({ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" })],
    ),
    /the stamp log does not name the election it observes/,
  );
});

test("a settled stamp for the wrong election is a malformed bundle, not a settled county", () => {
  // The bypass this is here for: settlement compares stamp strings, so a log of
  // November observations would settle a May bundle whose stamp happens to
  // match and report it as watched evidence. Two elections' stamps are not
  // comparable at all, so the bundle fails before any county is evaluated.
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf(
    ["2026-10-14T12:00:00Z", { adams: stamp }],
    ["2026-10-18T12:00:00Z", { adams: stamp }],
  );
  const wrongElection = [{
    county_id: "adams",
    vendor_election_key: "20270504P",
    source_updated_at: stamp,
    fetched_at: "2026-10-20T13:00:00Z",
  }];

  // Settled on every other axis: same county, same stamp, a long quiet span.
  assert.equal(assertSettled(log, { countyId: "adams", stamp, observedAt: "2026-10-20T13:00:00Z" }).status, "settled");
  assert.throws(
    () => gateJobs(log, wrongElection),
    /refresh job 1 \(adams\) walked election 20270504P, but this stamp log observes 20261103G/,
  );
});

test("the gate validates the log it was handed, not just the one check reads", () => {
  // `--log <path>` takes any file. A log that never went through npm run check
  // could be out of order or observing another election, and the settlement
  // rule would answer from it confidently. Both callers use this function, so
  // the gate's rules cannot drift weaker than the validator's.
  const ohio = ["adams", "huron"];
  assert.throws(
    () => assertStampLog({ meta: { schema_version: 2 }, observations: [] }, { countyIds: ohio }),
    /must be schema 1, not 2/,
  );
  assert.throws(
    () => assertStampLog({ ...logOf(), meta: { ...emptyLog({ election: ELECTION }).meta, observations: 4 } }, { countyIds: ohio }),
    /meta.observations must match/,
  );

  const stamp = "2026-10-12T14:32:40-04:00";
  const ordered = logOf(["2026-10-14T12:00:00Z", { adams: stamp }], ["2026-10-18T12:00:00Z", { adams: stamp }]);
  assert.equal(assertStampLog(ordered, { countyIds: ohio }), ordered);

  // appendObservation refuses to build these, so a log carrying them was
  // hand-edited -- exactly the file the gate must not trust.
  const scrambled = { ...ordered, observations: [ordered.observations[1], ordered.observations[0]] };
  assert.throws(() => assertStampLog(scrambled, { countyIds: ohio }), /observation 2 is not after the one before it/);

  const crossElection = {
    ...ordered,
    observations: [ordered.observations[0], { ...ordered.observations[1], election: "20270504P" }],
  };
  assert.throws(() => assertStampLog(crossElection, { countyIds: ohio }), /observation 2 observes a different election/);

  const foreignCounty = {
    ...ordered,
    observations: [ordered.observations[0], { ...ordered.observations[1], surveyed: ["marion-indiana"] }],
  };
  assert.throws(() => assertStampLog(foreignCounty, { countyIds: ohio }), /surveyed marion-indiana, which is not an Ohio county/);

  // A county list is required: an optional one is how the gate ends up with a
  // weaker version of the validator's rules.
  assert.throws(() => assertStampLog(ordered, { countyIds: [] }), /needs the set of counties/);
});
