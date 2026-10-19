// Re-derives the certified ballot text of each published statewide issue from
// the county ballots that carry it, and writes it as a generated artifact.
//
//   npm run generate:statewide-issues -- --election 20261103G
//
// Why this is generated rather than curated. A statewide issue's ballot text
// changes every election, so by the project's own rule it cannot be a file
// somebody types. It is also the only reliable way to recognize the issue:
// possiblePublishedIssueMatch compares the contest TITLE to the published
// label, and counties disagree about the title. Two of the seventy title the
// November 2026 amendment "3 Proposed Constitutional Amendment" rather than
// "Issue 3", so the title rule does not see it at all --- and a statewide issue
// the projector fails to recognize is published as that county's own, showing
// a voter the same amendment twice.
//
// The mechanism is deliberately circular in one direction only. The title rule
// is reliable WHERE IT FIRES, so it is used to learn which body text belongs to
// which published issue; the learned text then generalizes to the counties the
// title rule cannot reach. The generator reports both numbers, because the gap
// between them is the whole point:
//
//   identified_by_title_in  68 of 70     <- what the projector can do today
//   body_present_in         70 of 70     <- what the text can do
//
// **Cross-county agreement is the verification.** Unanimity across seventy
// independently operated county boards is stronger evidence for the certified
// text than one PDF this code cannot read, so the generator refuses to emit an
// issue whose counties disagree. A disagreement is a finding, not a rounding
// error, and it must stop the build rather than be averaged away.
//
// Like the coverage survey, this talks to a live government server and is run
// by hand, never from CI. It costs one full ballot walk per county.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  accessibleBallotUrl,
  classifyCountyResponse,
  createVendorClient,
  electionIdFromKey,
  hiddenFields,
  listingUrl,
  parseArgs,
  parseListing,
  parsePrecincts,
  requireSameStamp,
  vendorSlug,
  VendorTransportError,
  walkBallot,
} from "./ingest/vtrapp.mjs";
import { possiblePublishedIssueMatch } from "./project-vtrapp.mjs";

export const STATEWIDE_ISSUE_SCHEMA_VERSION = 1;

/**
 * The comparison key for a statewide issue.
 *
 * Only the issue BODY, never the heading. Counties draw the title/subtitle
 * boundary differently --- lorain and tuscarawas fold "Proposed Constitutional
 * Amendment" into the title where the other sixty-eight keep it as a subtitle
 * --- so a key that includes the heading disagrees across counties that are
 * printing identical text. Measured over all 70: heading plus body agrees in 68,
 * body alone agrees in 70.
 */
export function issueBodyText(contest) {
  return (contest.issue_text_lines ?? []).join("\n");
}

export function bodyDigest(body) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * Reads one county's first accessible ballot and returns its issue contests.
 *
 * A county that cannot be read is recorded while the rest of the state keeps
 * running, so one timeout does not hide the other findings. The caller still
 * refuses to replace the certified artifact unless every enumerable county was
 * read successfully.
 */
export async function readCountyIssues({ client, countyId, electionKey }) {
  const slug = vendorSlug(countyId);
  const listing = listingUrl(slug, client.base);

  const first = await client.request(listing);
  const response = classifyCountyResponse(first);
  if (response !== "served") throw new Error(`the vendor response is "${response}", not a served county`);

  const parsedListing = parseListing(first.body);
  if (!parsedListing.elections.some((option) => option.value === electionKey)) {
    throw new Error(`election ${electionKey} is not offered`);
  }

  const selected = await client.post(listing, {
    ...hiddenFields(first.body),
    cmbelectionlist: electionKey,
    __EVENTTARGET: "cmbelectionlist",
    __EVENTARGUMENT: "",
  });
  if (selected.status !== 200) throw new Error(`selecting the election returned HTTP ${selected.status}`);
  await client.pause();

  const listed = await client.post(listing, {
    ...hiddenFields(selected.body),
    cmbelectionlist: electionKey,
    cmbDistrictCat: "",
    btnsubmit: "Find Ballots",
  });
  if (listed.status !== 200) throw new Error(`the precinct list returned HTTP ${listed.status}`);
  requireSameStamp(countyId, parsedListing.sourceUpdatedRaw, listed.body, "the precinct list");

  const { precincts } = parsePrecincts(listed.body);
  if (precincts.length === 0) throw new Error("no precincts parsed from the listing");
  const precinct = precincts[0];
  const url = accessibleBallotUrl(
    slug,
    { electionKey, precinctId: precinct.id, style: precinct.vendor_style },
    client.base,
  );

  const contests = await walkBallot({ client, url, countyId, precinct });

  // The body is evidence only if the county did not replace its election data
  // while the ballot was being walked. This is the same boundary the full
  // ingest enforces around a precinct walk.
  const after = await client.request(listing);
  if (after.status !== 200) throw new Error(`the post-walk listing returned HTTP ${after.status}`);
  requireSameStamp(countyId, parsedListing.sourceUpdatedRaw, after.body, "the post-walk listing");

  return {
    precinct: precinct.id,
    contests_read: contests.length,
    issues: contests.filter((contest) => contest.kind === "issue"),
  };
}

/**
 * Turns the per-county reads into one record per published statewide issue.
 *
 * Separated from the network so the refusals below are testable without a
 * vendor. Every one of them has to be loud: an issue this build gets wrong is
 * an amendment published twice to a voter.
 */
export function resolveStatewideIssues({ election, countyIssues }) {
  const published = election.issues ?? [];
  const countiesRead = Object.keys(countyIssues);
  const resolved = {};

  for (const issue of published) {
    const byTitle = new Map(); // body text -> counties whose title named this issue
    for (const [countyId, issues] of Object.entries(countyIssues)) {
      for (const contest of issues) {
        if (possiblePublishedIssueMatch(contest, election) !== issue.id) continue;
        const body = issueBodyText(contest);
        if (!byTitle.has(body)) byTitle.set(body, new Set());
        byTitle.get(body).add(countyId);
      }
    }

    if (byTitle.size === 0) {
      throw new Error(
        `no county's contest title named published issue ${issue.id}; ` +
          "the text cannot be learned, so it must not be guessed",
      );
    }
    if (byTitle.size > 1) {
      const summary = [...byTitle]
        .map(([body, counties]) => `${bodyDigest(body)} in ${[...counties].sort().join(",")}`)
        .join(" / ");
      throw new Error(
        `counties disagree about the ballot text of ${issue.id}: ${summary}. ` +
          "A disagreement is a finding, not something to average away",
      );
    }

    const [[body, titleCounties]] = [...byTitle];
    if (body.trim() === "") {
      throw new Error(`published issue ${issue.id} resolved to empty ballot text`);
    }

    // Counted separately and over every county, including the ones whose title
    // the rule could not read. This is the number that says whether the text is
    // a usable backstop, and it is the reason the artifact exists.
    const bodyCounties = [];
    const duplicateCounties = [];
    for (const countyId of countiesRead) {
      const matching = countyIssues[countyId].filter((contest) => issueBodyText(contest) === body);
      if (matching.length === 1) bodyCounties.push(countyId);
      if (matching.length > 1) duplicateCounties.push(countyId);
    }
    if (duplicateCounties.length > 0) {
      throw new Error(
        `${issue.id} appears more than once with the certified body in ${duplicateCounties.join(",")}; ` +
          "one county cannot count as independent agreement with itself",
      );
    }
    if (bodyCounties.length !== countiesRead.length) {
      const missing = countiesRead.filter((countyId) => !bodyCounties.includes(countyId));
      throw new Error(
        `counties do not unanimously print the ballot text of ${issue.id}; ` +
          `missing or different in ${missing.join(",")}`,
      );
    }

    resolved[issue.id] = {
      label: issue.label,
      body_text: body,
      body_sha256: bodyDigest(body),
      identified_by_title_in: titleCounties.size,
      body_present_in: bodyCounties.length,
      counties_read: countiesRead.length,
      counties: bodyCounties.sort(),
    };
  }

  return resolved;
}

export function summarizeIssues(resolved, { countiesRead, failures }) {
  const entries = Object.values(resolved);
  return {
    counties_read: countiesRead,
    counties_failed: failures,
    issues_published: entries.length,
    identified_by_title_in: entries.length ? Math.min(...entries.map((e) => e.identified_by_title_in)) : 0,
    body_present_in: entries.length ? Math.min(...entries.map((e) => e.body_present_in)) : 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const electionKey = args.election;
  if (!electionKey) throw new Error("--election <vendor key> is required, for example --election 20261103G");
  if (args.limit !== undefined) {
    throw new Error(
      "--limit cannot produce certified statewide issue text; every enumerable county must agree",
    );
  }

  const coverage = JSON.parse(await readFile(new URL("../data/vtrapp-coverage.json", import.meta.url), "utf8"));
  const elections = JSON.parse(await readFile(new URL("../data/elections.json", import.meta.url), "utf8"));
  const electionId = electionIdFromKey(electionKey);
  const election = elections.elections.find((candidate) => candidate.id === electionId);
  if (!election) throw new Error(`data/elections.json has no election ${electionId}`);
  if ((election.issues ?? []).length === 0) throw new Error(`election ${electionId} publishes no statewide issues`);

  const counties = Object.entries(coverage.counties)
    .filter(([, record]) => record.enumerable === true)
    .map(([countyId]) => countyId);
  if (counties.length !== coverage.meta?.summary?.enumerable) {
    throw new Error(
      `coverage summary says ${coverage.meta?.summary?.enumerable} counties are enumerable but lists ${counties.length}`,
    );
  }

  const client = createVendorClient();
  const countyIssues = {};
  const failures = {};
  for (const [index, countyId] of counties.entries()) {
    process.stderr.write(`[${index + 1}/${counties.length}] ${countyId}\n`);
    try {
      const read = await readCountyIssues({ client, countyId, electionKey });
      countyIssues[countyId] = read.issues;
    } catch (error) {
      // Recorded per county so one unreachable board cannot end the run.
      failures[countyId] = error instanceof VendorTransportError ? `transport: ${error.message}` : error.message;
    }
    await client.pause();
  }

  if (Object.keys(failures).length > 0) {
    const detail = Object.entries(failures)
      .map(([countyId, reason]) => `${countyId}: ${reason}`)
      .join(" / ");
    throw new Error(
      `failed to read ${Object.keys(failures).length} of ${counties.length} enumerable counties; ` +
        `refusing to replace certified statewide issue text: ${detail}`,
    );
  }

  const resolved = resolveStatewideIssues({ election, countyIssues });
  const artifact = {
    meta: {
      schema_version: STATEWIDE_ISSUE_SCHEMA_VERSION,
      generated_by: "scripts/build-statewide-issues.mjs",
      generated_on: new Date().toISOString().slice(0, 10),
      note: "Generated file. Do not hand-edit; re-run npm run generate:statewide-issues.",
      vendor_base: client.base,
      election: { id: election.id, vendor_key: electionKey },
      summary: summarizeIssues(resolved, { countiesRead: Object.keys(countyIssues).length, failures: Object.keys(failures).length }),
      failures,
    },
    issues: resolved,
  };

  const out = new URL("../data/statewide-issue-text.json", import.meta.url);
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`);
  for (const [id, record] of Object.entries(resolved)) {
    console.log(
      `${id}: title named it in ${record.identified_by_title_in}/${record.counties_read} counties, ` +
        `its body text is present in ${record.body_present_in}/${record.counties_read}`,
    );
  }
  console.log(`Wrote data/statewide-issue-text.json (${Object.keys(failures).length} county failure(s))`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
