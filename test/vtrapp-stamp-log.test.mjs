import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gateRefresh } from "../scripts/gate-vtrapp.mjs";
import {
  appendObservation,
  assertSettled,
  emptyLog,
  observationFromCoverage,
  settleCounty,
  settlement,
  STAMP_LOG_SCHEMA_VERSION,
} from "../scripts/vtrapp-stamp-log.mjs";

const ELECTION = { id: "2026-11-03-general", vendor_key: "20261103G" };
const HOUR = 3_600_000;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
        adams: { source_updated_at: "2026-10-12T14:32:40-04:00", ingestable: true },
        lake: { source_updated_at: "2026-10-05T09:00:00-04:00", ingestable: false },
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
  const results = gateRefresh(log, {
    jobs: [
      { county_id: "adams", source_updated_at: adamsStamp, fetched_at: "2026-10-21T13:00:00Z" },
      { county_id: "huron", source_updated_at: "2026-10-20T15:00:00-04:00", fetched_at: "2026-10-21T13:00:00Z" },
    ],
  });
  assert.deepEqual(
    results.map(({ county_id: county, passed }) => [county, passed]),
    [["adams", true], ["huron", false]],
  );
  assert.match(results[1].detail, /huron is not settled/);
});

test("gateRefresh rejects a bundle with nothing in it rather than passing it", () => {
  const log = logOf(["2026-10-18T12:00:00Z", { adams: "2026-10-12T14:32:40-04:00" }]);
  assert.throws(() => gateRefresh(log, { jobs: [] }), /no jobs to gate/);
  assert.throws(() => gateRefresh(log, {}), /no jobs to gate/);
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

  const bundle = async (jobs) => {
    const path = join(directory, `refresh-${jobs[0].county_id}-${jobs.length}`);
    await mkdir(path);
    await writeFile(join(path, "summary.json"), JSON.stringify({ jobs }));
    return path;
  };
  const gate = (args) =>
    spawnSync(process.execPath, [join(projectRoot, "scripts", "gate-vtrapp.mjs"), "--log", logPath, ...args], {
      encoding: "utf8",
    });

  const settled = await bundle([{ county_id: "adams", source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" }]);
  const pass = gate(["--refresh", settled]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /All 1 counties .* are settled at the stamp they were walked at/);

  // Huron's board edited after the only survey, so the walk disagrees with it.
  const moved = await bundle([
    { county_id: "huron", source_updated_at: "2026-10-19T08:00:00-04:00", fetched_at: "2026-10-20T13:00:00Z" },
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

test("gateRefresh rejects a malformed bundle instead of blaming the county", () => {
  // A job missing a field this gate reads would otherwise come back as the
  // county being unsettled, which reads as a finding about a board.
  const stamp = "2026-10-12T14:32:40-04:00";
  const log = logOf(["2026-10-18T12:00:00Z", { adams: stamp }]);
  assert.throws(() => gateRefresh(log, { jobs: [{ source_updated_at: stamp, fetched_at: "2026-10-20T13:00:00Z" }] }), /refresh job 1 does not name a county/);
  assert.throws(
    () => gateRefresh(log, { jobs: [{ county_id: "adams", fetched_at: "2026-10-20T13:00:00Z" }] }),
    /refresh job 1 \(adams\) has no source_updated_at/,
  );
  assert.throws(
    () => gateRefresh(log, { jobs: [{ county_id: "adams", source_updated_at: stamp }] }),
    /refresh job 1 \(adams\) has no fetched_at/,
  );
});
