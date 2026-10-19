import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ballotId, SCHEMA_VERSION as SNAPSHOT_SCHEMA_VERSION } from "../scripts/ingest/vtrapp.mjs";
import {
  CANDIDATE_ELECTIONS_FILE,
  candidateDigest,
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

function snapshot(countyId, fetchedAt = "2026-10-16T18:00:00.000Z") {
  const contests = [
    office("For Governor and Lieutenant Governor", 1, [
      ["Amy Acton and David Pepper", "Democratic"],
      ["Don Kissick and James L. Mills", "Libertarian"],
      ["Vivek Ramaswamy and Robert A. McColley", "Republican"],
      ["Write-in", null, true],
    ]),
    office("For County Commissioner", 2, [["Ada Lovelace", "Democratic"]]),
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

test("keeps the production input unchanged when a later projection fails", async () => {
  const input = electionData();
  const original = structuredClone(input);
  const broken = manifest();
  broken.jobs[1].projection.office_mappings = {};
  const completed = [];

  await assert.rejects(
    refreshVtrapp({
      manifest: broken,
      electionData: input,
      now: () => new Date("2026-10-16T18:00:00.000Z"),
      ingest: async ({ countyId }) => snapshot(countyId),
      onProjection: async ({ job }) => completed.push(job.county),
    }),
    /common office contests need mappings: For County Commissioner/,
  );
  assert.deepEqual(completed, ["adams"]);
  assert.deepEqual(input, original);
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
  const saved = snapshot("adams", fetchedAt.toISOString());
  saved.source.source_updated_at = new Date(fetchedAt.getTime() - 3_600_000).toISOString();
  saved.source.source_age_hours = 1;
  await writeFile(
    join(snapshotDirectory, snapshotFilename({ county: "adams", election: "20261103G" })),
    JSON.stringify(saved),
  );
  const brokenManifest = manifest(["adams"]);
  brokenManifest.jobs[0].projection.office_mappings = {};
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(brokenManifest));

  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts", "refresh-vtrapp.mjs"),
    "--manifest", manifestPath,
    "--snapshots", snapshotDirectory,
    "--out", outputDirectory,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /common office contests need mappings/);
  const status = JSON.parse(await readFile(join(outputDirectory, "status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.match(status.error, /common office contests need mappings/);
  await access(join(outputDirectory, snapshotFilename({ county: "adams", election: "20261103G" })));
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
