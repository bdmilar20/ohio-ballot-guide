import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ballotId, SCHEMA_VERSION as SNAPSHOT_SCHEMA_VERSION } from "../scripts/ingest/vtrapp.mjs";
import {
  CANDIDATE_ELECTIONS_FILE,
  candidateDigest,
  jsonText,
  manifestDigest,
  projectionFilename,
  refreshVtrapp,
  snapshotFilename,
  validateRefreshManifest,
} from "../scripts/refresh-vtrapp.mjs";

function office(title, order, choices) {
  const normalizedChoices = choices.map(([name, party = null, writeIn = false]) => ({
    name,
    party,
    write_in: writeIn,
    raw_lines: party ? [name, party] : [name],
  }));
  return {
    order,
    kind: "office",
    title,
    subtitles: [],
    instructions: ["(Vote for not more than 1)"],
    vote_for: 1,
    issue_text_lines: null,
    choices: normalizedChoices,
    allows_write_in: normalizedChoices.some(({ write_in: writeIn }) => writeIn),
    source_url: "https://example.gov/ballot",
    raw: { heading_lines: [title], choice_lines: normalizedChoices.map(({ raw_lines: lines }) => lines) },
    uncertain: [],
  };
}

// The local office title is a parameter because the ballot id is a digest of
// the ballot's normalized content: retitling a contest after the fact
// invalidates it, so a fixture that needs a different office has to be built
// with it rather than edited.
function snapshot(countyId, fetchedAt = "2026-10-16T18:00:00.000Z", localOfficeTitle = "For County Commissioner") {
  const contests = [
    office("For Governor and Lieutenant Governor", 1, [
      ["Amy Acton and David Pepper", "Democratic"],
      ["Don Kissick and James L. Mills", "Libertarian"],
      ["Vivek Ramaswamy and Robert A. McColley", "Republican"],
      ["Write-in", null, true],
    ]),
    office(localOfficeTitle, 2, [["Ada Lovelace", "Democratic"]]),
  ];
  const id = ballotId(contests);
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    election: { id: "2026-11-03-general", vendor_key: "20261103G" },
    county: { id: countyId, vendor_slug: countyId.replaceAll("-", "") },
    source: {
      listing_url: `https://lookup.boe.ohio.gov/vtrapp/${countyId}/ballotlist.aspx`,
      fetched_at: fetchedAt,
      source_updated_at: "2026-10-16T10:00:00.000Z",
      source_age_hours: 8,
    },
    enumeration: { listed_precincts: 1, parsed_precincts: 1, skipped: [], unexplained_rows: [] },
    precincts: [{ id: "01____1", ballot_id: id }],
    ballots: { [id]: { contests } },
  };
}

function electionData() {
  return {
    meta: { last_reviewed: "2026-10-15", coverage_note: "Old note" },
    elections: [{
      id: "2026-11-03-general",
      statewide_races: [{
        id: "governor",
        office: "Governor & Lieutenant Governor",
        candidates: [
          { name: "Amy Acton & David Pepper", party: "Democratic" },
          { name: "Don Kissick & James L. Mills", party: "Libertarian" },
          { name: "Vivek Ramaswamy & Robert A. McColley", party: "Republican" },
          { name: "Qualified Person", party: "Write-in" },
        ],
      }],
      issues: [],
      counties: {
        adams: { races: [{ id: "old" }], issues: [] },
        brown: { races: [], issues: [] },
      },
    }],
  };
}

function manifest(counties = ["adams", "brown"]) {
  return {
    schema_version: 1,
    jobs: counties.map((county) => ({
      county,
      election: "20261103G",
      projection: {
        max_source_age_hours: 24,
        county_name: county[0].toUpperCase() + county.slice(1),
        office_mappings: { "For County Commissioner": "county-commissioner" },
      },
    })),
  };
}

test("refreshes manifest jobs serially into a candidate file without mutating its input", async () => {
  const input = electionData();
  const original = structuredClone(input);
  const calls = [];
  const artifacts = [];
  let active = 0;
  const result = await refreshVtrapp({
    manifest: manifest(),
    electionData: input,
    now: () => new Date("2026-10-16T18:00:00.000Z"),
    ingest: async ({ countyId }) => {
      active += 1;
      assert.equal(active, 1, "county ingests must not overlap");
      calls.push(countyId);
      await Promise.resolve();
      active -= 1;
      return snapshot(countyId);
    },
    onSnapshot: async ({ job }) => artifacts.push(`snapshot:${job.county}`),
    onProjection: async ({ job }) => artifacts.push(`projection:${job.county}`),
  });

  assert.deepEqual(calls, ["adams", "brown"]);
  assert.deepEqual(artifacts, ["snapshot:adams", "projection:adams", "snapshot:brown", "projection:brown"]);
  assert.deepEqual(input, original);
  // A county refresh does not establish a dataset-wide review date or justify
  // rewriting the dataset's coverage description. Those claims stay exactly
  // as reviewed until a separate whole-dataset review changes them.
  assert.deepEqual(result.candidate.meta, original.meta);
  assert.equal(result.candidate.elections[0].counties.adams.races.length, 1);
  assert.equal(result.candidate.elections[0].counties.adams.races[0].office_id, "county-commissioner");
  assert.equal(result.candidate.elections[0].counties.brown.coverage.method, "common_to_all_precincts");
  assert.equal(result.summary.completed_jobs, 2);
  assert.deepEqual(result.summary.jobs[0].before, {
    races: 1,
    issues: 0,
    coverage_status: null,
    coverage_method: null,
  });
});

test("catalog mode publishes measured presence for every local contest", async () => {
  const input = electionData();
  const catalog = manifest(["adams"]);
  catalog.jobs[0].projection.mode = "catalog";
  const result = await refreshVtrapp({
    manifest: catalog,
    electionData: input,
    ingest: async ({ countyId }) => snapshot(countyId),
    now: () => new Date("2026-10-16T18:00:00.000Z"),
  });
  const county = result.candidate.elections[0].counties.adams;

  assert.equal(county.coverage.method, "all_precinct_contests");
  assert.deepEqual(county.races[0].ballot_presence, {
    scope: "all_precincts",
    precincts: 1,
    precincts_total: 1,
  });
});

test("refresh manifest rejects an unknown projection mode", async () => {
  const invalid = manifest(["adams"]);
  invalid.jobs[0].projection.mode = "exact-ish";
  assert.throws(() => validateRefreshManifest(invalid), /projection mode must be common or catalog/);
});

test("rejects duplicate jobs before starting an ingest", async () => {
  const duplicate = manifest(["adams", "adams"]);
  assert.throws(() => validateRefreshManifest(duplicate), /duplicates adams 20261103G/);
  let called = false;
  await assert.rejects(
    refreshVtrapp({ manifest: duplicate, electionData: electionData(), ingest: async () => { called = true; } }),
    /duplicates adams 20261103G/,
  );
  assert.equal(called, false);
});

test("continues after a county projection fails, but returns no partial candidate", async () => {
  const input = electionData();
  input.elections[0].counties.carroll = { races: [], issues: [] };
  const original = structuredClone(input);
  const broken = manifest(["adams", "brown", "carroll"]);
  broken.jobs[1].projection.office_mappings = {};
  const completed = [];
  const saved = [];
  const failed = [];

  await assert.rejects(
    refreshVtrapp({
      manifest: broken,
      electionData: input,
      now: () => new Date("2026-10-16T18:00:00.000Z"),
      ingest: async ({ countyId }) => snapshot(countyId),
      onSnapshot: async ({ job }) => saved.push(job.county),
      onProjection: async ({ job }) => completed.push(job.county),
      onProjectionFailure: async ({ failure }) => failed.push(failure),
    }),
    (error) => {
      assert.match(error.message, /1 of 3 refresh job\(s\) failed projection/);
      assert.match(error.message, /brown: common office contests need mappings: For County Commissioner/);
      assert.deepEqual(error.failures, failed);
      return true;
    },
  );
  assert.deepEqual(saved, ["adams", "brown", "carroll"]);
  assert.deepEqual(completed, ["adams", "carroll"]);
  assert.deepEqual(failed, [{
    county_id: "brown",
    election_id: "2026-11-03-general",
    vendor_election_key: "20261103G",
    stage: "projection",
    error: "common office contests need mappings: For County Commissioner",
  }]);
  assert.deepEqual(input, original);
});

test("an adapter failure still stops before later counties", async () => {
  const input = electionData();
  input.elections[0].counties.carroll = { races: [], issues: [] };
  const called = [];
  const projectionFailures = [];

  await assert.rejects(
    refreshVtrapp({
      manifest: manifest(["adams", "brown", "carroll"]),
      electionData: input,
      now: () => new Date("2026-10-16T18:00:00.000Z"),
      ingest: async ({ countyId }) => {
        called.push(countyId);
        if (countyId === "brown") throw new Error("vendor maintenance");
        return snapshot(countyId);
      },
      onProjectionFailure: async ({ failure }) => projectionFailures.push(failure),
    }),
    /vendor maintenance/,
  );
  assert.deepEqual(called, ["adams", "brown"]);
  assert.deepEqual(projectionFailures, []);
});

test("CLI replays saved snapshots and emits a validated review bundle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-refresh-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotDirectory = join(directory, "snapshots");
  const outputDirectory = join(directory, "output");
  await mkdir(snapshotDirectory);

  const projectRoot = new URL("..", import.meta.url).pathname;
  const actualElections = JSON.parse(await readFile(join(projectRoot, "data", "elections.json"), "utf8"));
  const fetchedAt = new Date();
  const saved = snapshot("adams", fetchedAt.toISOString());
  saved.source.source_updated_at = new Date(fetchedAt.getTime() - 3_600_000).toISOString();
  saved.source.source_age_hours = 1;
  await writeFile(
    join(snapshotDirectory, snapshotFilename({ county: "adams", election: "20261103G" })),
    JSON.stringify(saved),
  );
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest(["adams"])));

  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
    "--manifest", manifestPath,
    "--elections", join(projectRoot, "data", "elections.json"),
    "--snapshots", snapshotDirectory,
    "--out", outputDirectory,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote complete refresh bundle/);
  const status = JSON.parse(await readFile(join(outputDirectory, "status.json"), "utf8"));
  const savedCandidateText = await readFile(join(outputDirectory, CANDIDATE_ELECTIONS_FILE), "utf8");
  const candidate = JSON.parse(savedCandidateText);
  const summary = JSON.parse(await readFile(join(outputDirectory, "summary.json"), "utf8"));
  assert.equal(status.status, "complete");
  assert.deepEqual(status.failed_jobs, []);
  assert.equal(summary.candidate_elections_file, CANDIDATE_ELECTIONS_FILE);
  assert.equal(summary.candidate_sha256, candidateDigest(savedCandidateText));
  assert.match(summary.validation, /Validated 4 elections/);
  assert.equal(candidate.elections[0].counties.adams.races[0].office_id, "county-commissioner");
  assert.deepEqual(candidate.meta, actualElections.meta);
  assert.notDeepEqual(candidate, actualElections);
});

test("CLI preserves artifacts but withholds the candidate when projection fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-refresh-failed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotDirectory = join(directory, "snapshots");
  const outputDirectory = join(directory, "output");
  await mkdir(snapshotDirectory);

  const projectRoot = new URL("..", import.meta.url).pathname;
  const fetchedAt = new Date();
  // Brown's unmapped title is between two clean jobs. The curated patterns
  // label "For County Commissioner", so the refusal needs an office nothing
  // can label --- no mapping, no pattern, and no measurement behind it.
  const saved = [
    snapshot("adams", fetchedAt.toISOString()),
    snapshot("brown", fetchedAt.toISOString(), "For County Dogcatcher"),
    snapshot("carroll", fetchedAt.toISOString()),
  ];
  for (const county of saved) {
    county.source.source_updated_at = new Date(fetchedAt.getTime() - 3_600_000).toISOString();
    county.source.source_age_hours = 1;
    await writeFile(
      join(snapshotDirectory, snapshotFilename({ county: county.county.id, election: "20261103G" })),
      JSON.stringify(county),
    );
  }
  const brokenManifest = manifest(["adams", "brown", "carroll"]);
  brokenManifest.jobs[1].projection.office_mappings = {};
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(brokenManifest));

  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
    "--manifest", manifestPath,
    "--snapshots", snapshotDirectory,
    "--out", outputDirectory,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1 of 3 refresh job\(s\) failed projection/);
  assert.match(result.stderr, /brown: common office contests need mappings/);
  const status = JSON.parse(await readFile(join(outputDirectory, "status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.match(status.error, /common office contests need mappings/);
  assert.deepEqual(status.completed_jobs, ["adams:20261103G", "carroll:20261103G"]);
  assert.deepEqual(status.failed_jobs, [{
    county_id: "brown",
    election_id: "2026-11-03-general",
    vendor_election_key: "20261103G",
    stage: "projection",
    error: "common office contests need mappings: For County Dogcatcher",
  }]);
  for (const county of ["adams", "brown", "carroll"]) {
    await access(join(outputDirectory, snapshotFilename({ county, election: "20261103G" })));
  }
  for (const county of ["adams", "carroll"]) {
    await access(join(outputDirectory, projectionFilename({ county, election: "20261103G" })));
  }
  await assert.rejects(
    access(join(outputDirectory, projectionFilename({ county: "brown", election: "20261103G" }))),
    { code: "ENOENT" },
  );
  await assert.rejects(access(join(outputDirectory, "elections.candidate.json")), { code: "ENOENT" });
});

test("CLI refuses an existing output directory without changing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-refresh-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDirectory = join(directory, "output");
  await mkdir(outputDirectory);
  const statusPath = join(outputDirectory, "status.json");
  await writeFile(statusPath, "owner data\n");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest(["adams"])));
  const projectRoot = new URL("..", import.meta.url).pathname;

  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
    "--manifest", manifestPath,
    "--out", outputDirectory,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output directory already exists/);
  assert.equal(await readFile(statusPath, "utf8"), "owner data\n");
});

// A county ballot carrying the published statewide amendment under a title the
// matcher does not recognize --- the lorain/tuscarawas shape, measured in 2 of
// the 70 enumerable counties.
function snapshotWithRetitledStateIssue(countyId) {
  const base = snapshot(countyId);
  const [ballot] = Object.values(base.ballots);
  ballot.contests.push({
    order: 3,
    kind: "issue",
    title: "3 Proposed Constitutional Amendment",
    subtitles: [],
    instructions: [],
    vote_for: null,
    issue_text_lines: ["Statewide amendment text"],
    choices: [
      { name: "YES", party: null, write_in: false, raw_lines: ["YES"] },
      { name: "NO", party: null, write_in: false, raw_lines: ["NO"] },
    ],
    allows_write_in: false,
    source_url: "https://example.gov/ballot",
    raw: { heading_lines: ["3 Proposed Constitutional Amendment"], choice_lines: [["YES"], ["NO"]] },
    uncertain: [],
  });
  const id = ballotId(ballot.contests);
  base.ballots = { [id]: ballot };
  base.precincts = [{ id: "01____1", ballot_id: id }];
  return base;
}

test("a refresh resolves a retitled statewide issue from the certified text it is given", async () => {
  // The pipeline, not just the projector: a refresh that did not pass the
  // certified text through would publish the amendment as county content with
  // every unit test still green.
  const input = electionData();
  input.elections[0].issues = [{ id: "state-issue-3", label: "State Issue 3" }];

  const withoutText = await refreshVtrapp({
    manifest: manifest(["adams"]),
    electionData: structuredClone(input),
    now: () => new Date("2026-10-16T18:00:00.000Z"),
    ingest: async ({ countyId }) => snapshotWithRetitledStateIssue(countyId),
  });
  assert.deepEqual(
    withoutText.candidate.elections[0].counties.adams.issues.map(({ label }) => label),
    ["3 Proposed Constitutional Amendment"],
    "with no certified text the statewide amendment becomes county content",
  );

  const result = await refreshVtrapp({
    manifest: manifest(["adams"]),
    electionData: structuredClone(input),
    statewideIssueText: { "state-issue-3": "Statewide amendment text" },
    now: () => new Date("2026-10-16T18:00:00.000Z"),
    ingest: async ({ countyId }) => snapshotWithRetitledStateIssue(countyId),
  });
  assert.deepEqual(result.candidate.elections[0].counties.adams.issues, []);
  assert.deepEqual(result.summary.jobs[0].removed_statewide_duplicates, ["governor", "state-issue-3"]);
});

test("a bundle carries every input a projection decision depended on, and a replay reads the bundle's copy", async (t) => {
  // Found in review: before this, a bundle held only the manifest, so the same
  // saved snapshot replayed differently after anyone edited the certified
  // issue text, the office patterns, or the survey that bounds them.
  const directory = await mkdtemp(join(tmpdir(), "vtrapp-refresh-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotDirectory = join(directory, "snapshots");
  const firstOutput = join(directory, "first");
  const secondOutput = join(directory, "second");
  await mkdir(snapshotDirectory);

  const projectRoot = new URL("..", import.meta.url).pathname;
  const fetchedAt = new Date();
  const saved = snapshot("adams", fetchedAt.toISOString());
  saved.source.source_updated_at = new Date(fetchedAt.getTime() - 3_600_000).toISOString();
  saved.source.source_age_hours = 1;
  await writeFile(
    join(snapshotDirectory, snapshotFilename({ county: "adams", election: "20261103G" })),
    JSON.stringify(saved),
  );
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest(["adams"])));

  const run = (snapshots, out) =>
    spawnSync(process.execPath, [
      join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
      "--manifest", manifestPath,
      "--snapshots", snapshots,
      "--out", out,
    ], { encoding: "utf8" });

  const first = run(snapshotDirectory, firstOutput);
  assert.equal(first.status, 0, first.stderr);
  const firstSummary = JSON.parse(await readFile(join(firstOutput, "summary.json"), "utf8"));
  assert.deepEqual(
    firstSummary.inputs.map(({ file }) => file).sort(),
    ["office-title-patterns.json", "statewide-issue-text.json", "vtrapp-contest-survey.json"],
  );
  for (const input of firstSummary.inputs) {
    const copied = await readFile(join(firstOutput, input.file), "utf8");
    assert.equal(candidateDigest(copied), input.sha256, `${input.file} digest must describe the copy in the bundle`);
    assert.equal(input.source, "repository");
  }
  // The manifest is the fourth input, recorded by the decisions it makes
  // rather than beside the three data files, because it is compared against a
  // caller-supplied file whose formatting is not ours to dictate.
  assert.equal(
    firstSummary.manifest_sha256,
    manifestDigest(manifest(["adams"])),
    "a bundle records the manifest it projected under",
  );
  assert.equal(
    manifestDigest(JSON.parse(await readFile(join(firstOutput, "manifest.json"), "utf8"))),
    firstSummary.manifest_sha256,
    "that digest must describe the manifest copy in the bundle",
  );

  // Replaying the first bundle must use the first bundle's inputs, not the
  // working tree's, and reach the same candidate.
  const second = run(firstOutput, secondOutput);
  assert.equal(second.status, 0, second.stderr);
  const secondSummary = JSON.parse(await readFile(join(secondOutput, "summary.json"), "utf8"));
  assert.deepEqual(
    secondSummary.inputs.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file)),
    firstSummary.inputs.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file)),
  );
  assert.ok(
    secondSummary.inputs.every(({ source }) => source === "bundle"),
    "a replay reads the bundle it is replaying",
  );

  // Every projection decision has to be the same. The candidate digest is not
  // the measure of that: freshness is recalculated at replay time, so
  // `coverage.reviewed_at` legitimately advances and the digest legitimately
  // changes. Asserting digest equality was asserting an invariant the system
  // does not have --- so compare the decisions, and name the one field
  // allowed to differ.
  const withoutReviewClock = (value) => {
    if (Array.isArray(value)) return value.map(withoutReviewClock);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "reviewed_at")
        .map(([key, nested]) => [key, withoutReviewClock(nested)]),
    );
  };
  const firstCandidate = JSON.parse(await readFile(join(firstOutput, CANDIDATE_ELECTIONS_FILE), "utf8"));
  const secondCandidate = JSON.parse(await readFile(join(secondOutput, CANDIDATE_ELECTIONS_FILE), "utf8"));
  assert.deepEqual(withoutReviewClock(secondCandidate), withoutReviewClock(firstCandidate));
  const reviewClock = (candidate) => candidate.elections[0].counties.adams.coverage.reviewed_at;
  assert.notEqual(reviewClock(secondCandidate), undefined, "the replay still records when it reviewed");
  assert.ok(
    Date.parse(reviewClock(secondCandidate)) >= Date.parse(reviewClock(firstCandidate)),
    "the replay's review clock cannot run backwards",
  );

  // Carrying a digest is not the same as checking one. Before this, a replay
  // computed a fresh digest from whatever now sat in the snapshot directory,
  // so an edited bundled input produced a new digest and a different
  // candidate instead of a refusal.
  await t.test("an edited bundled input refuses rather than replaying differently", async () => {
    const edited = join(directory, "edited");
    await cp(firstOutput, edited, { recursive: true });
    const patternsPath = join(edited, "office-title-patterns.json");
    const patterns = JSON.parse(await readFile(patternsPath, "utf8"));
    patterns.patterns.push({ printed: "Dogcatcher", office_id: "county-auditor", office: "Dogcatcher" });
    await writeFile(patternsPath, jsonText(patterns));

    const replay = run(edited, join(directory, "edited-replay"));
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /office-title-patterns\.json is sha256:.* but that bundle's summary records/);
  });

  await t.test("a recorded input the bundle no longer holds refuses", async () => {
    const stripped = join(directory, "stripped");
    await cp(firstOutput, stripped, { recursive: true });
    await rm(join(stripped, "vtrapp-contest-survey.json"));

    const replay = run(stripped, join(directory, "stripped-replay"));
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /records vtrapp-contest-survey\.json, but the bundle holds no copy/);
  });

  await t.test("a flag cannot stand in for a recorded input", async () => {
    const replay = spawnSync(process.execPath, [
      join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
      "--manifest", manifestPath,
      "--snapshots", firstOutput,
      "--office-title-patterns", join(projectRoot, "data", "office-title-patterns.json"),
      "--out", join(directory, "override-replay"),
    ], { encoding: "utf8" });
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /--office-title-patterns conflicts with the office-title-patterns\.json recorded in/);
  });

  // Found in review: the refresh invoked the canonical validator with only the
  // candidate, locations, offices and county boards, so the validator re-read
  // the repository's patterns and survey no matter which copies the
  // projection had used. A malformed-but-shaped bundled input could drive a
  // publication while the good repository copy was what got checked.
  await t.test("validation reads the same inputs the projection did", async () => {
    const patterns = JSON.parse(await readFile(join(projectRoot, "data", "office-title-patterns.json"), "utf8"));
    // Shaped well enough for readPatterns and harmless to projection, but the
    // validator refuses a pattern no surveyed title reaches.
    patterns.patterns.push({ printed: "Dogcatcher", office_id: "county-auditor", office: "County Dogcatcher" });
    const patternsPath = join(directory, "unused-pattern.json");
    await writeFile(patternsPath, jsonText(patterns));

    const result = spawnSync(process.execPath, [
      join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
      "--manifest", manifestPath,
      "--snapshots", snapshotDirectory,
      "--office-title-patterns", patternsPath,
      "--out", join(directory, "unused-pattern-out"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /every office title pattern must match at least one title the survey found/);
  });

  // Found in review: the three data inputs were verified and the manifest was
  // not, so a complete bundle replayed under a different --manifest
  // republished the same snapshot under a different office. Both runs exited
  // 0, both recorded successful validation, and all three data inputs read
  // `source: bundle` --- none of them is where an office mapping lives. The
  // visible name stayed "County Commissioner" while office_id became
  // county-auditor, so the published race would have read correctly and
  // linked a voter to the wrong office.
  await t.test("a replay under a different manifest refuses rather than republishing a different office", async () => {
    const otherManifest = manifest(["adams"]);
    otherManifest.jobs[0].projection.office_mappings = { "For County Commissioner": "county-auditor" };
    const otherManifestPath = join(directory, "other-manifest.json");
    await writeFile(otherManifestPath, JSON.stringify(otherManifest));

    const out = join(directory, "other-manifest-replay");
    const replay = spawnSync(process.execPath, [
      join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
      "--manifest", otherManifestPath,
      "--snapshots", firstOutput,
      "--out", out,
    ], { encoding: "utf8" });
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /--manifest is sha256:.* but .*summary\.json records sha256:/);
    await assert.rejects(access(join(out, CANDIDATE_ELECTIONS_FILE)), "a refused replay publishes no candidate");
  });

  await t.test("an edited bundled manifest refuses", async () => {
    const edited = join(directory, "edited-manifest");
    await cp(firstOutput, edited, { recursive: true });
    const manifestFile = join(edited, "manifest.json");
    const bundled = JSON.parse(await readFile(manifestFile, "utf8"));
    bundled.jobs[0].projection.office_mappings = { "For County Commissioner": "county-auditor" };
    await writeFile(manifestFile, jsonText(bundled));

    const replay = run(edited, join(directory, "edited-manifest-replay"));
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /manifest\.json is sha256:.* but that bundle's summary records/);
  });

  await t.test("a bundle that records no manifest digest cannot be replayed", async () => {
    const unrecorded = join(directory, "unrecorded-manifest");
    await cp(firstOutput, unrecorded, { recursive: true });
    const summary = JSON.parse(await readFile(join(unrecorded, "summary.json"), "utf8"));
    delete summary.manifest_sha256;
    await writeFile(join(unrecorded, "summary.json"), jsonText(summary));

    const replay = run(unrecorded, join(directory, "unrecorded-manifest-replay"));
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /records no manifest_sha256/);
  });

  await t.test("a recorded manifest the bundle no longer holds refuses", async () => {
    const stripped = join(directory, "stripped-manifest");
    await cp(firstOutput, stripped, { recursive: true });
    await rm(join(stripped, "manifest.json"));

    const replay = run(stripped, join(directory, "stripped-manifest-replay"));
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /holds no manifest\.json to replay/);
  });

  // The decisions are what must match, not the bytes. A manifest kept in a
  // repository with different formatting is still that manifest, and refusing
  // it would make the check cost more than it is worth.
  await t.test("a reformatted manifest carrying the same decisions still replays", async () => {
    const reformattedPath = join(directory, "reformatted-manifest.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8"));
    const reordered = { jobs: original.jobs, schema_version: original.schema_version };
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(original));
    await writeFile(reformattedPath, JSON.stringify(reordered, null, 4));

    const out = join(directory, "reformatted-manifest-replay");
    const replay = spawnSync(process.execPath, [
      join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
      "--manifest", reformattedPath,
      "--snapshots", firstOutput,
      "--out", out,
    ], { encoding: "utf8" });
    assert.equal(replay.status, 0, replay.stderr);
  });

  await t.test("a bundle whose summary records no inputs cannot be replayed", async () => {
    const unverifiable = join(directory, "unverifiable");
    await cp(firstOutput, unverifiable, { recursive: true });
    const summary = JSON.parse(await readFile(join(unverifiable, "summary.json"), "utf8"));
    delete summary.inputs;
    await writeFile(join(unverifiable, "summary.json"), jsonText(summary));

    const replay = run(unverifiable, join(directory, "unverifiable-replay"));
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /has no inputs to verify/);
  });
});
