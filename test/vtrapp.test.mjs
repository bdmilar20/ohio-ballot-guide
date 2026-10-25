import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ballotId,
  classifyCountyResponse,
  createVendorClient,
  electionIdFromKey,
  extractElement,
  ingestCounty,
  listingUrl,
  normalizeContest,
  parseContestPage,
  parseArgs,
  parseListing,
  parsePrecincts,
  parseVendorTimestamp,
  PRECINCT_TABLE_ID,
  SCHEMA_VERSION,
  vendorSlug,
  walkBallot,
} from "../scripts/ingest/vtrapp.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => readFile(join(projectRoot, "test", "fixtures", "vtrapp", `${name}.html`), "utf8");

// ---------------------------------------------------------------- vendor slugs

test("strips hyphens, because the vendor serves van-wert as vanwert", () => {
  assert.equal(vendorSlug("adams"), "adams");
  assert.equal(vendorSlug("van-wert"), "vanwert");
});

test("refuses a county id it cannot turn into a slug", () => {
  for (const bad of ["", "Adams", "van wert", "adams/..", 42, null]) {
    assert.throws(() => vendorSlug(bad), /Invalid county id/);
  }
});

// ------------------------------------------------- telling the three responses

// A county that does not use this application still answers HTTP 200, so a
// status check alone reports success for a county that published nothing.
test("separates a served county from a placeholder and a bad slug", async () => {
  assert.equal(classifyCountyResponse({ status: 200, body: await fixture("adams-listing") }), "served");
  assert.equal(classifyCountyResponse({ status: 200, body: await fixture("not-a-customer") }), "not-a-customer");
  assert.equal(classifyCountyResponse({ status: 500, body: await fixture("bogus-slug-500") }), "unknown-slug");
  assert.equal(classifyCountyResponse({ status: 503, body: "" }), "error");
});

test("the placeholder really is the short body the survey recorded", async () => {
  const body = await fixture("not-a-customer");
  assert.equal(body.length, 861);
  assert.match(body, /Not a Customer/);
});

// --------------------------------------------------------------- the listing

test("reads the election list and drops the prompt option", async () => {
  const listing = parseListing(await fixture("adams-listing"));
  assert.equal(listing.notCustomer, false);
  assert.equal(listing.elections.length, 24);
  assert.deepEqual(listing.elections[0], { value: "20261103G", text: "11/3/2026 General Election" });
  assert.ok(!listing.elections.some((option) => option.value === "NONE"));
});

test("resolves the vendor's wall clock to an exact instant", async () => {
  const listing = parseListing(await fixture("adams-listing"));
  assert.equal(listing.sourceUpdatedRaw, "10/12/26 02:32:40 PM");
  assert.equal(listing.sourceUpdatedAt.iso, "2026-10-12T14:32:40-04:00");
});

// The stamp carries no zone. Reading it as UTC would misreport a ballot's age
// by four or five hours, and by a whole hour on the wrong side of a DST change.
test("applies Ohio's offset, not UTC, on both sides of a DST change", () => {
  assert.equal(parseVendorTimestamp("10/12/26 02:32:40 PM").iso, "2026-10-12T14:32:40-04:00");
  assert.equal(parseVendorTimestamp("01/15/26 09:05:00 AM").iso, "2026-01-15T09:05:00-05:00");
  assert.equal(parseVendorTimestamp("07/04/26 12:00:00 PM").iso, "2026-07-04T12:00:00-04:00");
  assert.equal(parseVendorTimestamp("11/30/26 12:00:00 AM").iso, "2026-11-30T00:00:00-05:00");
});

test("rejects a timestamp it does not understand rather than guessing", () => {
  for (const bad of ["2026-10-12T14:32:40Z", "10/12/26 14:32:40", "", "10/12/2026 02:32:40 PM"]) {
    assert.throws(() => parseVendorTimestamp(bad), /Unrecognized vendor timestamp/);
  }
});

test("maps a vendor election key onto our election ids", () => {
  assert.equal(electionIdFromKey("20261103G"), "2026-11-03-general");
  assert.equal(electionIdFromKey("20260505P"), "2026-05-05-primary");
  assert.equal(electionIdFromKey("20250506S"), "2025-05-06-special");
  assert.throws(() => electionIdFromKey("2026-11-03"), /Unrecognized vendor election key/);
  assert.throws(() => electionIdFromKey("20261103Z"), /Unknown election kind/);
});

// -------------------------------------------------------------- the precincts

// The row links are single-quoted. An href="..." pattern matches nothing here,
// which makes a populated table look like a county with no ballots.
test("finds every precinct split even though the links are single-quoted", async () => {
  const { listed, precincts, skipped } = parsePrecincts(await fixture("adams-precincts"));
  assert.equal(listed, 27);
  assert.equal(precincts.length, 27);
  assert.deepEqual(skipped, []);
  assert.deepEqual(precincts[0], {
    id: "01____1",
    name: "BRATTON TOWNSHIP",
    split: "01 1",
    vendor_style: "X",
    vendor_style_label: "X - NONPARTISAN",
    election_key: "20261103G",
  });
  assert.ok(precincts.every((precinct) => precinct.id && precinct.vendor_style));
});

test("reports a row whose two ballot links disagree instead of trusting one", () => {
  const html = `<table id="tblvtrlist">
    <tr><th id="Precinct_Split">s</th><th id="Link">l</th></tr>
    <tr><td headers="Precinct_Split">01 1</td><td headers="Link">
      <a href='getballot.aspx?elect=20261103G&prsid=01____1&bpty=X'>View</a>
      <a href='xmlview.aspx?bpty=x&elec=20261103g&prsid=09____9&lang=en'>Accessible</a>
    </td></tr></table>`;
  const { listed, precincts, skipped } = parsePrecincts(html);
  assert.equal(listed, 1);
  assert.equal(precincts.length, 0);
  assert.match(skipped[0].reason, /disagree on prsid/);
});

// The election key and style are read off the PDF link but the accessible link
// is the one fetched, so the two have to be checked as one identity. The vendor
// lowercases its whole accessible query string, so every field folds case.
test("declines a row whose links disagree on election or style", () => {
  const row = (accessible) => `<table id="tblvtrlist">
    <tr><th id="Precinct_Split">s</th><th id="Link">l</th></tr>
    <tr><td headers="Precinct_Split">01 1</td><td headers="Link">
      <a href='getballot.aspx?elect=20261103G&prsid=01____1&bpty=X'>View</a>
      <a href='${accessible}'>Accessible</a>
    </td></tr></table>`;
  const reasonFor = (accessible) => parsePrecincts(row(accessible)).skipped[0].reason;

  assert.match(reasonFor("xmlview.aspx?bpty=x&elec=20260505P&prsid=01____1&lang=en"), /disagree on election/);
  assert.match(reasonFor("xmlview.aspx?bpty=d&elec=20261103g&prsid=01____1&lang=en"), /disagree on style/);
  assert.match(reasonFor("xmlview.aspx?prsid=01____1&lang=en"), /missing election, style/);
  assert.match(reasonFor("xmlview.aspx?bpty=x&elec=20261103g&lang=en"), /missing prsid/);

  // Case is the vendor's own convention on these two links, not a disagreement.
  assert.equal(parsePrecincts(row("xmlview.aspx?bpty=x&elec=20261103g&prsid=01____1&lang=en")).precincts.length, 1);
});

// Requiring prsid to match exactly between the two links looks like the safe
// rule and is not. Adams precinct ids are digits, so folding case is a no-op
// there and the strict rule passes its tests; Lucas ids carry letters, and the
// strict rule declined 267 of that county's 315 rows, which failed the whole
// county closed. The row below is Lucas's own markup, unedited.
test("accepts the vendor's lowercased prsid while storing the cased id", () => {
  const html = `<table id="${PRECINCT_TABLE_ID}">
    <tr><th id="Precinct_Split">s</th><th id="Precinct_Name">n</th><th id="Style">y</th><th id="Link">l</th></tr>
    <tr><td headers="Precinct_Split">001A 1</td><td headers="Precinct_Name">TOLEDO 1A</td>
    <td headers="Style">X - NON</td><td headers="Link">
      <a href='getballot.aspx?elect=20261103G&prsid=001A__1&bpty=X' target=_blank>View Ballot</a>
      <a href='xmlview.aspx?bpty=x&elec=20261103g&prsid=001a__1&lang=en' target='_blank' >View Accessible Ballot</a>
    </td></tr></table>`;
  const { listed, precincts, skipped } = parsePrecincts(html);
  assert.equal(listed, 1);
  assert.deepEqual(skipped, []);
  assert.equal(precincts.length, 1);

  // The id we store and republish is the PDF link's, verbatim. Only agreement
  // between the two links folds case.
  assert.equal(precincts[0].id, "001A__1");
  assert.equal(precincts[0].name, "TOLEDO 1A");

  // Folding case must not fold two genuinely different ids together.
  assert.match(
    parsePrecincts(html.replace("prsid=001a__1", "prsid=001b__1")).skipped[0].reason,
    /disagree on prsid/,
  );
});

// This is the one enumeration failure the listed-vs-parsed count cannot catch:
// a pager row is not a precinct row, so both numbers describe the page the
// vendor served rather than the county, and a projection intersected over
// fewer precincts admits *more* content as common to all of them.
test("refuses a results table carrying rows it does not parse", () => {
  const pager = `<table id="${PRECINCT_TABLE_ID}">
    <tr><th id="Precinct_Split">s</th><th id="Link">l</th></tr>
    <tr><td headers="Precinct_Split">01 1</td><td headers="Link">
      <a href='getballot.aspx?elect=20261103G&prsid=01____1&bpty=X'>View</a>
      <a href='xmlview.aspx?bpty=x&elec=20261103g&prsid=01____1&lang=en'>Accessible</a>
    </td></tr>
    <tr><td colspan="2"><a href="javascript:__doPostBack('gv','Page$2')">2</a></td></tr></table>`;
  const paged = parsePrecincts(pager);

  // The trap: without the gate these two numbers agree and report success.
  assert.equal(paged.listed, 1);
  assert.equal(paged.precincts.length, 1);
  assert.equal(paged.unexplained.length, 1);
  assert.match(paged.unexplained[0].reason, /neither the header row nor a precinct row/);
  // The row text is kept as the vendor's own markup, so a failed run names the
  // pager it tripped over rather than printing a bare "2".
  assert.match(paged.unexplained[0].row[0], /Page\$2/);

  // A second header row is structure we did not parse either.
  const repeated = parsePrecincts(
    pager.replace(/<tr><td colspan[\s\S]*?<\/tr>/, '<tr><th id="Precinct_Split">s</th><th id="Link">l</th></tr>'),
  );
  assert.equal(repeated.unexplained.length, 1);
});

// A lazy `<table[\s\S]*?</table>` match stops at a nested table's close tag,
// dropping every row after it from `precincts` and from `listed` alike, so the
// counts still agree over a fraction of the county. extractElement counts
// depth, so the rows survive; the nested table itself is still unexplained
// structure and stops the run.
test("reads past a nested table instead of truncating at it", () => {
  const nested = `<table id="${PRECINCT_TABLE_ID}">
    <tr><th id="Precinct_Split">s</th><th id="Link">l</th></tr>
    <tr><td colspan="2"><table><tr><td>pager</td></tr></table></td></tr>
    <tr><td headers="Precinct_Split">01 1</td><td headers="Link">
      <a href='getballot.aspx?elect=20261103G&prsid=01____1&bpty=X'>View</a>
      <a href='xmlview.aspx?bpty=x&elec=20261103g&prsid=01____1&lang=en'>Accessible</a>
    </td></tr></table>`;
  const parsed = parsePrecincts(nested);
  assert.equal(parsed.precincts.length, 1, "the row after the nested table must not be dropped");
  assert.ok(parsed.unexplained.some((entry) => entry.reason.includes("nested table")));
});

// --------------------------------------------------------------- the contests

test("keeps candidates in ballot order with their party and write-in status", async () => {
  const { index, total, contest } = parseContestPage(await fixture("adams-contest-01"), { sourceUrl: "https://x" });
  assert.equal(index, 1);
  assert.equal(total, 20);
  assert.equal(contest.kind, "office");
  assert.equal(contest.title, "For Governor and Lieutenant Governor");
  assert.equal(contest.instructions.length, 1);
  assert.match(contest.instructions[0], /^\(To vote for Governor and Lieutenant Governor/);
  assert.deepEqual(
    contest.choices.map((choice) => [choice.name, choice.party, choice.write_in]),
    [
      ["Amy Acton and David Pepper", "Democratic", false],
      ["Don Kissick and James L. Mills", "Libertarian", false],
      ["Vivek Ramaswamy and Robert A. McColley", "Republican", false],
      ["Write-in", null, true],
    ],
  );
  assert.equal(contest.allows_write_in, true);
  assert.equal(contest.source_url, "https://x");
  assert.deepEqual(contest.uncertain, []);
});

// Judicial and most local races are nonpartisan. Inventing a party here would
// put a party label on a ballot that does not print one.
test("leaves party null for a nonpartisan race and reads its vote-for count", async () => {
  const { contest } = parseContestPage(await fixture("adams-contest-12"));
  assert.equal(contest.title, "For Judge of the Court of Common Pleas");
  assert.equal(contest.vote_for, 1);
  assert.deepEqual(contest.instructions, ["(Full term commencing 2-9-2027)", "(Vote for not more than 1)"]);
  assert.deepEqual(
    contest.choices.map((choice) => [choice.name, choice.party]),
    [
      ["Barbara Moore Holt", null],
      ["Lisa Ann Rothwell", null],
    ],
  );
  assert.equal(contest.allows_write_in, false);
  assert.deepEqual(contest.uncertain, []);
});

test("keeps a ballot issue's full text and its yes/no choices", async () => {
  const { contest } = parseContestPage(await fixture("adams-contest-16"));
  assert.equal(contest.kind, "issue");
  assert.equal(contest.title, "Issue 3");
  assert.deepEqual(contest.subtitles, [
    "Proposed Constitutional Amendment",
    "TO REQUIRE VOTERS TO PRESENT PHOTO IDENTIFICATION IN ORDER TO VOTE",
    "Proposed by Joint Resolution of the General Assembly",
    "To enact Section 5 of Article V of the Constitution of the State of Ohio",
    "A majority yes vote is required for the adoption of Section 5.",
  ]);
  assert.equal(contest.issue_text_lines.length, 9);
  assert.equal(contest.issue_text_lines[0], "This proposed amendment would:");
  assert.match(contest.issue_text_lines.at(-1), /SHALL THE AMENDMENT BE APPROVED\?/);
  assert.deepEqual(
    contest.choices.map((choice) => choice.name),
    ["YES", "NO"],
  );
});

test("refuses a page with no contest position or no panel", async () => {
  assert.throws(() => parseContestPage("<html></html>"), /No contest position/);
  assert.throws(
    () => parseContestPage("<p>You are viewing contest 1 of 3</p>"),
    /has no span_data panel/,
  );
});

// A contest we cannot represent completely is worse than one we refuse to
// ingest, so losing a line is a failure rather than a silently shorter record.
test("fails closed when normalization would drop source text", () => {
  const panel = `<h2 class="balofficename">For Mayor</h2>
    <ul class="candidates"><li>Ada Lovelace<br/>&nbsp;Democratic</li></ul>
    <p>A STRAY LINE THE PARSER DOES NOT CAPTURE</p>`;
  assert.throws(() => normalizeContest(panel, { order: 1 }), /would drop source text: A STRAY LINE/);
});

// Erie prints its write-in row with U+2010 HYPHEN rather than an ASCII hyphen.
// An ASCII-only pattern leaves write_in false, and that row then survives the
// projector's write-in filter and publishes as a candidate named "Write-in"
// while allows_write_in claims the contest takes none.
test("recognizes a write-in row whatever dash the county printed", () => {
  const panel = (dash) => `<h2 class="balofficename">For Mayor</h2>
    <ul class="candidates"><li>Ada Lovelace<br/>Democratic</li><li>Write${dash}in</li></ul>`;
  for (const [label, dash] of [
    ["ascii hyphen", "-"],
    ["U+2010 hyphen, as Erie prints it", "\u2010"],
    ["en dash", "\u2013"],
    ["a plain space", " "],
  ]) {
    const contest = normalizeContest(panel(dash), { order: 1 });
    assert.equal(contest.choices[1].write_in, true, `${label} must read as a write-in row`);
    assert.equal(contest.allows_write_in, true, label);
    // The text itself stays verbatim: raw_lines feeds the content fingerprint.
    assert.deepEqual(contest.choices[1].raw_lines, [`Write${dash}in`]);
  }

  // Still a name, not a write-in row. Widening the dash class must not widen
  // what counts as the placeholder.
  const named = normalizeContest(panel("-").replace("Write-in", "Wright-in"), { order: 1 });
  assert.equal(named.choices[1].write_in, false);
  assert.equal(named.allows_write_in, false);
});

test("flags a choice with unexpected extra lines instead of discarding them", () => {
  const panel = `<h2 class="balofficename">For Mayor</h2>
    <ul class="candidates"><li>Ada Lovelace<br/>Democratic<br/>Incumbent note</li></ul>`;
  const contest = normalizeContest(panel, { order: 1 });
  assert.equal(contest.uncertain.length, 1);
  assert.match(contest.uncertain[0].reason, /3 lines in one choice/);
  assert.deepEqual(contest.choices[0].raw_lines, ["Ada Lovelace", "Democratic", "Incumbent note"]);
});

// --------------------------------------------------------------- ballot identity

test("hashes the ballot content, not the vendor's style label", async () => {
  const one = parseContestPage(await fixture("adams-contest-01")).contest;
  const twelve = parseContestPage(await fixture("adams-contest-12")).contest;
  assert.equal(ballotId([one, twelve]), ballotId([one, twelve]));
  assert.notEqual(ballotId([one, twelve]), ballotId([twelve, one]));
  assert.notEqual(ballotId([one]), ballotId([one, twelve]));

  const changed = structuredClone(one);
  changed.choices[0].party = "Republican";
  assert.notEqual(ballotId([one]), ballotId([changed]));
});

// Hashing a hand-written field list let the adapter preserve text in raw_lines,
// show it to a reviewer, and still collapse two different ballots into one id.
// A third choice line lands only in raw_lines: name is the first line and party
// stays null, so [name, party, write_in] is identical for both of these.
test("distinguishes two ballots that differ only in a preserved raw line", () => {
  const withThirdLine = (last) =>
    normalizeContest(
      `<h2 class="balofficename">For Mayor</h2>
       <ul class="candidates"><li>Ada Lovelace<br>Democratic<br>${last}</li></ul>`,
      { order: 1 },
    );
  const incumbent = withThirdLine("Incumbent");
  const endorsed = withThirdLine("Endorsed");

  assert.deepEqual(incumbent.choices[0].raw_lines, ["Ada Lovelace", "Democratic", "Incumbent"]);
  assert.deepEqual(endorsed.choices[0].raw_lines, ["Ada Lovelace", "Democratic", "Endorsed"]);
  assert.equal(incumbent.choices[0].name, endorsed.choices[0].name);
  assert.equal(incumbent.choices[0].party, endorsed.choices[0].party);
  assert.equal(incumbent.uncertain.length, 1);

  assert.notEqual(ballotId([incumbent]), ballotId([endorsed]));
});

// source_url carries the precinct, so hashing it would give every precinct a
// unique id and deduplication would never fire.
test("ignores the per-precinct source url when hashing a ballot", async () => {
  const html = await fixture("adams-contest-01");
  const first = parseContestPage(html, { sourceUrl: "https://x/?prsid=01____1" }).contest;
  const second = parseContestPage(html, { sourceUrl: "https://x/?prsid=02____3" }).contest;
  assert.notEqual(first.source_url, second.source_url);
  assert.equal(ballotId([first]), ballotId([second]));
});

// ------------------------------------------------------------ the whole county

// A tiny stand-in for the vendor so the gates can be driven without the
// network. It carries the contest position in __VIEWSTATE the way the real
// WebForms app carries it, so the client's postback handling is exercised.
function fakeVendor({
  listingBody,
  precinctBody,
  ballots,
  precinctStatus = 200,
  finalStatus = 200,
  // The real vendor prints its update stamp on every page of the flow, so by
  // default both the precinct list and the post-walk re-read carry the one the
  // listing showed. A test passing "" takes the stamp away.
  stampAfterSubmit,
  stampAfterSelect,
  stampAfterReselect,
} = {}) {
  const listingStamp = listingBody?.match(/Election data last updated:\s*([^<]+)/)?.[1]?.trim() ?? null;
  const orDefault = (value) => (value === undefined ? listingStamp : value);
  const stamped = (stamp, html) => (stamp ? `Election data last updated: ${stamp}<${html}` : html);
  const listingAt = (stamp) =>
    listingBody.replace(
      /Election data last updated:\s*[^<]+</,
      stamp ? `Election data last updated: ${stamp}<` : "<",
    );

  const page = (inner, viewstate) =>
    `<html><form><input type="hidden" name="__VIEWSTATE" value="${viewstate}" />${inner}</form></html>`;
  const calls = [];
  let enumerated = false;
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? new URLSearchParams(init.body) : null;
    calls.push({ url, method: init.method ?? "GET" });
    const respond = (status, text) => ({ status, headers: {}, text: async () => text });

    if (url.includes("ballotlist.aspx")) {
      // A bare GET after enumeration is the adapter re-reading the listing to
      // prove the source did not move during the ballot walk.
      if (!body) {
        if (!enumerated) return respond(200, listingBody);
        return respond(finalStatus, listingBody);
      }
      if (body.has("btnsubmit")) {
        enumerated = true;
        return respond(precinctStatus, stamped(orDefault(stampAfterSubmit), precinctBody));
      }
      const selectedStamp = enumerated ? stampAfterReselect : stampAfterSelect;
      return respond(200, listingAt(orDefault(selectedStamp)));
    }

    const precinctId = new URL(url).searchParams.get("prsid");
    const contests = ballots[precinctId];
    if (!contests) return respond(404, "no such precinct");
    const position = body ? Number(body.get("__VIEWSTATE").split(":")[1]) + 1 : 1;
    if (position > contests.length) return respond(200, "walked past the end");
    return respond(
      200,
      page(
        `<p>You are viewing contest ${position} of ${contests.length}</p><div id="span_data">${contests[position - 1]}</div><p></p>`,
        `pos:${position}`,
      ),
    );
  };
  return { fetchImpl, calls };
}

const panel = (title, ...names) =>
  `<h2 class="balofficename">${title}</h2><ul class="candidates">${names.map((n) => `<li>${n}</li>`).join("")}</ul>`;

const twoRowTable = `<table id="tblvtrlist">
  <tr><th id="Precinct_Split">s</th><th id="Precinct_Name">n</th><th id="Style">y</th><th id="Link">l</th></tr>
  ${["01____1", "01____2"]
    .map(
      (id) => `<tr><td headers="Precinct_Split">${id}</td><td headers="Precinct_Name">P ${id}</td>
      <td headers="Style">X - NONPARTISAN</td><td headers="Link">
        <a href='getballot.aspx?elect=20261103G&prsid=${id}&bpty=X'>View Ballot</a>
        <a href='xmlview.aspx?bpty=x&elec=20261103g&prsid=${id}&lang=en'>View Accessible Ballot</a>
      </td></tr>`,
    )
    .join("")}</table>`;

async function runCounty(overrides = {}, ingestOverrides = {}) {
  const listingBody = `<html>
    Election data last updated: 10/12/26 02:32:40 PM<br/>
    <select name="cmbelectionlist"><option value="NONE">Select an Election Date</option>
    <option value="20261103G">11/3/2026 General Election</option></select>
    <input type="hidden" name="__VIEWSTATE" value="pos:0" /></html>`;
  const vendor = fakeVendor({
    listingBody,
    precinctBody: twoRowTable,
    ballots: {
      "01____1": [panel("For Mayor", "Ada Lovelace"), panel("For Dogcatcher", "Grace Hopper")],
      "01____2": [panel("For Mayor", "Ada Lovelace"), panel("For Dogcatcher", "Grace Hopper")],
    },
    ...overrides,
  });
  const snapshot = await ingestCounty({
    countyId: "adams",
    electionKey: "20261103G",
    client: createVendorClient({ fetchImpl: vendor.fetchImpl, delayMs: 0 }),
    now: () => new Date("2026-10-16T18:32:40Z"),
    ...ingestOverrides,
  });
  return { snapshot, vendor };
}

test("builds a snapshot that keeps precincts and deduplicates identical ballots", async () => {
  const { snapshot } = await runCounty();
  assert.equal(snapshot.schema_version, SCHEMA_VERSION);
  assert.deepEqual(snapshot.election, { id: "2026-11-03-general", vendor_key: "20261103G" });
  assert.deepEqual(snapshot.county, { id: "adams", vendor_slug: "adams" });
  assert.equal(snapshot.source.listing_url, listingUrl("adams"));
  assert.equal(snapshot.source.source_updated_at, "2026-10-12T14:32:40-04:00");
  assert.equal(snapshot.source.source_age_hours, 96);
  assert.deepEqual(snapshot.enumeration, {
    listed_precincts: 2,
    parsed_precincts: 2,
    skipped: [],
    unexplained_rows: [],
  });

  // Both precincts carry the same two contests, so one ballot is stored twice
  // by reference and never duplicated in the snapshot.
  assert.equal(snapshot.precincts.length, 2);
  assert.equal(Object.keys(snapshot.ballots).length, 1);
  assert.equal(snapshot.precincts[0].ballot_id, snapshot.precincts[1].ballot_id);
  assert.ok(snapshot.ballots[snapshot.precincts[0].ballot_id].contests.length === 2);
  assert.match(snapshot.precincts[0].html_url, /xmlview\.aspx\?bpty=x&elec=20261103g&prsid=01____1/);
  assert.match(snapshot.precincts[0].pdf_url, /getballot\.aspx\?elect=20261103G&prsid=01____1&bpty=X/);
});

test("keeps two precincts apart when their ballots differ", async () => {
  const { snapshot } = await runCounty({
    ballots: {
      "01____1": [panel("For Mayor", "Ada Lovelace")],
      "01____2": [panel("For Mayor", "Ada Lovelace"), panel("For Village Council", "Grace Hopper")],
    },
  });
  assert.equal(Object.keys(snapshot.ballots).length, 2);
  assert.notEqual(snapshot.precincts[0].ballot_id, snapshot.precincts[1].ballot_id);
});

test("refuses a county that does not use the application", async () => {
  const body = await fixture("not-a-customer");
  await assert.rejects(
    runCounty({ listingBody: body }),
    /vendor response is "not-a-customer"/,
  );
});

test("refuses an election the county does not offer", async () => {
  await assert.rejects(
    runCounty({}, { electionKey: "20281107G" }),
    /election 20281107G is absent; offered 20261103G/,
  );
});

test("refuses a listing with no update stamp, because age cannot be reported", async () => {
  await assert.rejects(
    runCounty({
      listingBody: `<html><select name="cmbelectionlist"><option value="20261103G">x</option></select>
        <input type="hidden" name="__VIEWSTATE" value="pos:0" /></html>`,
    }),
    /has no "Election data last updated" stamp/,
  );
});

test("anchors the source stamp after selecting the requested election", async () => {
  // Miami's opening GET defaults to a special election updated October 19.
  // Selecting the requested general election changes the page to that
  // election's September 30 stamp. Comparing the precinct list with the
  // opening default falsely reads this stable source as a mid-run edit.
  const selectedStamp = "09/30/26 08:14:14 AM";
  const { snapshot } = await runCounty({
    listingBody: `<html>
      Election data last updated: 10/19/26 09:49:23 AM<br/>
      <select name="cmbelectionlist"><option value="NONE">Select an Election Date</option>
      <option selected value="20261103S">11/3/2026 Special Election</option>
      <option value="20261103G">11/3/2026 General Election</option></select>
      <input type="hidden" name="__VIEWSTATE" value="pos:0" /></html>`,
    stampAfterSelect: selectedStamp,
    stampAfterSubmit: selectedStamp,
    stampAfterReselect: selectedStamp,
  });

  assert.equal(snapshot.source.source_updated_at, "2026-09-30T08:14:14-04:00");
});

test("refuses an enumeration that produced no ballots", async () => {
  await assert.rejects(
    runCounty({ precinctBody: `<table id="${PRECINCT_TABLE_ID}"></table>` }),
    /yielded no ballots/,
  );
});

// The results table used to be "the first <table> on the page", which reads a
// layout table on a redesigned page as an empty county. Taking it by the
// vendor's own id instead means a markup change stops the run and says so.
test("refuses a Find Ballots response with no results table", async () => {
  await assert.rejects(
    runCounty({ precinctBody: "<table id='somethingelse'><tr><td headers='Link'>x</td></tr></table>" }),
    /has no table with id="tblvtrlist"/,
  );
  assert.deepEqual(parsePrecincts("<table><tr><td headers='Link'>x</td></tr></table>"), {
    tableFound: false,
    listed: 0,
    precincts: [],
    skipped: [],
    unexplained: [],
  });
});

// A paged results table is the one case where the listed and parsed counts
// agree and still describe less than the county, so the run has to stop on the
// unparsed row itself.
test("refuses a snapshot whose results table had a row it did not parse", async () => {
  const paged = twoRowTable.replace(
    "</table>",
    `<tr><td colspan="4"><a href="javascript:__doPostBack('gv','Page$2')">2</a></td></tr></table>`,
  );
  await assert.rejects(
    runCounty({ precinctBody: paged }),
    /1 row\(s\) this adapter does not parse.*Page\$2.*may not be the whole county/s,
  );

  // Without the gate this is what the snapshot would have claimed.
  const parsed = parsePrecincts(paged);
  assert.equal(parsed.listed, parsed.precincts.length);
});

// A snapshot covering fewer precincts than the county listed looks like
// coverage and is not.
test("refuses a snapshot that parsed fewer precincts than were listed", async () => {
  const brokenRow = twoRowTable.replace(
    /<a href='getballot\.aspx\?elect=20261103G&prsid=01____2&bpty=X'>View Ballot<\/a>/,
    "",
  );
  await assert.rejects(runCounty({ precinctBody: brokenRow }), /listed 2 precinct rows but parsed 1/);
});

test("refuses a run in which the source's own timestamp moved", async () => {
  await assert.rejects(
    runCounty({ stampAfterSubmit: "10/14/26 09:00:00 AM" }),
    /source changed during the run .* at the precinct list/,
  );
});

// Enumeration is the cheap end of the run; the ballot walk is ~550 requests for
// Adams. A gate that stops before it leaves the whole expensive window unwatched
// and produces a snapshot mixing two versions of the ballot.
test("refuses a source change that happens during the ballot walk", async () => {
  await assert.rejects(
    runCounty({ stampAfterReselect: "10/14/26 09:00:00 AM" }),
    /source changed during the run .* at the selected listing re-read after the ballot walk/,
  );
});

// A missing stamp is missing identity evidence, not evidence of agreement.
test("refuses a run whose stamp is absent rather than unchanged", async () => {
  await assert.rejects(
    runCounty({ stampAfterSubmit: "" }),
    /the precinct list carries no "Election data last updated" stamp/,
  );
  await assert.rejects(
    runCounty({ stampAfterReselect: "" }),
    /the selected election has no "Election data last updated" stamp/,
  );
});

test("reports a failed post-walk re-read as that boundary", async () => {
  await assert.rejects(
    runCounty({ finalStatus: 503 }),
    /re-reading the listing after the ballot walk returned HTTP 503/,
  );
});

test("refuses a ballot walk that ends before the reported contest total", async () => {
  // The page claims three contests but the vendor stops answering after two.
  const vendor = fakeVendor({
    listingBody: `<html>Election data last updated: 10/12/26 02:32:40 PM<
      <select name="cmbelectionlist"><option value="20261103G">x</option></select>
      <input type="hidden" name="__VIEWSTATE" value="pos:0" /></html>`,
    precinctBody: twoRowTable,
    ballots: { "01____1": [], "01____2": [] },
  });
  const truncating = async (url, init) => {
    const response = await vendor.fetchImpl(url, init);
    if (!url.includes("xmlview")) return response;
    const position = init?.body ? Number(new URLSearchParams(init.body).get("__VIEWSTATE").split(":")[1]) + 1 : 1;
    if (position > 2) return { status: 200, headers: {}, text: async () => "walked past the end" };
    return {
      status: 200,
      headers: {},
      text: async () => `<html><form><input type="hidden" name="__VIEWSTATE" value="pos:${position}" />
        <p>You are viewing contest ${position} of 3</p>
        <div id="span_data">${panel("For Mayor", "Ada Lovelace")}</div><p></p></form></html>`,
    };
  };
  await assert.rejects(
    ingestCounty({
      countyId: "adams",
      electionKey: "20261103G",
      client: createVendorClient({ fetchImpl: truncating, delayMs: 0 }),
    }),
    /precinct 01____1 ballot walk ended at 2 of 3 contests/,
  );
});

test("refuses an invalid starting position or contest total", async () => {
  const page = (index, total) => `<html><form><input type="hidden" name="__VIEWSTATE" value="pos:${index}" />
    <p>You are viewing contest ${index} of ${total}</p>
    <div id="span_data">${panel("For Mayor", "Ada Lovelace")}</div></form></html>`;
  const client = (body) => ({
    request: async () => ({ status: 200, body }),
    post: async () => ({ status: 200, body }),
    pause: async () => {},
  });

  await assert.rejects(
    walkBallot({
      client: client(page(2, 2)),
      url: "https://example.test/ballot",
      countyId: "adams",
      precinct: { id: "01____1" },
    }),
    /precinct 01____1 ballot walk started at contest 2 of 2, not contest 1/,
  );
  await assert.rejects(
    walkBallot({
      client: client(page(1, 0)),
      url: "https://example.test/ballot",
      countyId: "adams",
      precinct: { id: "01____1" },
    }),
    /precinct 01____1 ballot reported an invalid total of 0 contests/,
  );
});

test("refuses a ballot walk whose reported contest total changes", async () => {
  const page = (index, total, title) => `<html><form><input type="hidden" name="__VIEWSTATE" value="pos:${index}" />
    <p>You are viewing contest ${index} of ${total}</p>
    <div id="span_data">${panel(title, "Ada Lovelace")}</div></form></html>`;
  const client = {
    request: async () => ({ status: 200, body: page(1, 2, "For Mayor") }),
    post: async () => ({ status: 200, body: page(2, 3, "For County Auditor") }),
    pause: async () => {},
  };

  await assert.rejects(
    walkBallot({ client, url: "https://example.test/ballot", countyId: "adams", precinct: { id: "01____1" } }),
    /precinct 01____1 ballot contest total changed from 2 to 3 at contest 2/,
  );
});

test("reports an HTTP failure at each postback boundary as that boundary", async () => {
  const listingBody = `<html>Election data last updated: 10/12/26 02:32:40 PM<
    <select name="cmbelectionlist"><option value="20261103G">x</option></select>
    <input type="hidden" name="__VIEWSTATE" value="pos:0" /></html>`;
  const failAt = (predicate, status) => async (url, init = {}) => {
    if (predicate(url, init)) return { status, headers: {}, text: async () => "upstream error" };
    // Two contests per precinct, so the walk actually issues a postback.
    const twoContests = [panel("For Mayor", "Ada Lovelace"), panel("For Dogcatcher", "Grace Hopper")];
    const vendor = fakeVendor({
      listingBody,
      precinctBody: twoRowTable,
      ballots: { "01____1": twoContests, "01____2": twoContests },
    });
    return vendor.fetchImpl(url, init);
  };
  const run = (fetchImpl) =>
    ingestCounty({
      countyId: "adams",
      electionKey: "20261103G",
      client: createVendorClient({ fetchImpl, delayMs: 0 }),
    });

  await assert.rejects(
    run(failAt((url, init) => url.includes("ballotlist") && init.body?.includes("__EVENTTARGET=cmbelectionlist"), 500)),
    /selecting election 20261103G returned HTTP 500/,
  );
  await assert.rejects(
    run(failAt((url, init) => url.includes("ballotlist") && init.body?.includes("btnsubmit"), 502)),
    /listing precincts returned HTTP 502/,
  );
  await assert.rejects(
    run(failAt((url, init) => url.includes("xmlview") && !init.body, 503)),
    /accessible ballot returned HTTP 503/,
  );
  await assert.rejects(
    run(failAt((url, init) => url.includes("xmlview") && Boolean(init.body), 504)),
    /ballot walk stopped at contest 2 of 2 with HTTP 504/,
  );
});

test("retries unanswered requests with pacing and returns the first real answer", async () => {
  let calls = 0;
  const client = createVendorClient({
    delayMs: 0,
    transportRetries: 2,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient timeout");
      return { status: 200, headers: {}, text: async () => "served" };
    },
  });
  const response = await client.request("https://example.test/ballot");

  assert.equal(response.status, 200);
  assert.equal(response.body, "served");
  assert.equal(calls, 3);
});

test("stops after the bounded transport retry count and never retries an HTTP answer", async () => {
  let unanswered = 0;
  const exhausted = createVendorClient({
    delayMs: 0,
    transportRetries: 2,
    fetchImpl: async () => {
      unanswered += 1;
      throw new Error("connection reset");
    },
  });
  await assert.rejects(
    () => exhausted.request("https://example.test/ballot"),
    (error) => {
      assert.equal(error.name, "VendorTransportError");
      assert.equal(error.attempts, 3);
      assert.match(error.message, /after 3 attempts/);
      return true;
    },
  );
  assert.equal(unanswered, 3);

  let answered = 0;
  const httpFailure = createVendorClient({
    delayMs: 0,
    transportRetries: 2,
    fetchImpl: async () => {
      answered += 1;
      return { status: 503, headers: {}, text: async () => "maintenance" };
    },
  });
  assert.equal((await httpFailure.request("https://example.test/ballot")).status, 503);
  assert.equal(answered, 1);
});

test("rejects an invalid transport retry count before any request", () => {
  assert.throws(() => createVendorClient({ transportRetries: -1 }), /nonnegative integer/);
  assert.throws(() => createVendorClient({ transportRetries: 1.5 }), /nonnegative integer/);
});

test("parses CLI flags without truncating a value that contains an equals sign", () => {
  assert.deepEqual(parseArgs(["--county", "adams", "--election=20261103G"]), {
    county: "adams",
    election: "20261103G",
  });
  assert.deepEqual(parseArgs(["--out=a=b.json"]), { out: "a=b.json" });
  assert.throws(() => parseArgs(["county"]), /Unexpected argument: county/);
  assert.throws(() => parseArgs(["--county"]), /--county needs a value/);
});

test("reports the ballot's age in hours so staleness is a visible decision", async () => {
  const { snapshot } = await runCounty({}, { now: () => new Date("2026-10-12T18:32:40Z") });
  assert.equal(snapshot.source.source_age_hours, 0);
  const later = await runCounty({}, { now: () => new Date("2026-11-01T18:32:40Z") });
  assert.equal(later.snapshot.source.source_age_hours, 480);
});

// A lazy close-tag match stops inside a ballot issue's own nested block, which
// would hide text from verifyTextCoverage — it can only check what it is given.
test("extracts a panel by nesting depth, not the first close tag", () => {
  const html = `<div id="span_data"><h2 class="balofficename">Issue 1</h2>
    <div class="issuetext">outer <div>inner</div> tail</div>
    <ul class="candidates"><li>YES</li><li>NO</li></ul></div><p>after</p>`;
  const panel = extractElement(html, /<div[^>]*id="span_data"[^>]*>/i);
  assert.match(panel, /class="candidates"/);
  assert.ok(!panel.includes("after"));
  assert.equal(extractElement("<div>unclosed", /<div>/), null);
  assert.equal(extractElement("<p>no match</p>", /<div>/), null);

  const contest = normalizeContest(panel, { order: 1 });
  assert.equal(contest.kind, "issue");
  assert.deepEqual(contest.issue_text_lines, ["outer", "inner", "tail"]);
  assert.deepEqual(
    contest.choices.map((choice) => choice.name),
    ["YES", "NO"],
  );
});

// Both links have to move together here: a row where only one of them changes
// is now declined earlier, by the link-identity check, so mutating one would
// no longer reach the gate this test is about.
test("refuses rows listed under a different election than the one selected", async () => {
  const mismatched = twoRowTable
    .replace(/elect=20261103G/g, "elect=20260505P")
    .replace(/elec=20261103g/g, "elec=20260505p");
  await assert.rejects(
    runCounty({ precinctBody: mismatched }),
    /is listed under election 20260505P, not 20261103G/,
  );
});
