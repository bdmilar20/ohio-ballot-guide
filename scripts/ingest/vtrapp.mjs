// Ingests county ballots from the shared Ohio vendor application at
// lookup.boe.ohio.gov/vtrapp, which serves 72 of Ohio's 88 county boards.
//
// This emits a versioned source snapshot. It does NOT write data/elections.json.
// A separate projector owns the product decision about what a county-only
// lookup may publish. See docs/BALLOT_INGESTION.md for the contract this is
// built to and for what the survey of all 88 county boards found.
//
//   node scripts/ingest/vtrapp.mjs --county adams --election 20261103G \
//     --out .cache/vtrapp-adams-20261103G.json
//
// It talks to a live government server, so like check-links it is run by hand,
// never from CI. Every parser here is a pure function over captured HTML and is
// tested against fixtures in test/fixtures/vtrapp.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Bumped to 2 when enumeration gained `unexplained_rows`. A v1 snapshot was
// produced by a parser that took the first <table> on the page and never
// checked that it understood every row, so it carries no evidence that its
// precinct list was the whole county. The version is what lets a consumer
// refuse one; the field alone cannot, since both versions say 1 otherwise.
export const SCHEMA_VERSION = 2;
export const VENDOR_BASE = "https://lookup.boe.ohio.gov/vtrapp";

// The vendor's "Not a Customer" placeholder. A county that does not use this
// application still answers 200, so a status check alone reports success for a
// county that published nothing.
const NOT_A_CUSTOMER = /Not a Customer/i;

// Ohio boards run on Eastern time and the vendor prints a bare wall clock.
const VENDOR_TIME_ZONE = "America/New_York";

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

export function decodeEntities(value) {
  return value
    .replace(/&(nbsp|amp|quot|#39|apos|lt|gt);/g, (match) => ENTITIES[match])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

const collapse = (value) => decodeEntities(value).replace(/\s+/g, " ").trim();

// Splits an HTML fragment on <br> boundaries and on block tags, then strips the
// remaining inline markup. Keeps one source line per line the ballot shows.
function toLines(fragment) {
  return fragment
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h\d|tr|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(collapse)
    .filter(Boolean);
}

/** The vendor slug is not our county id: it has no hyphens (van-wert -> vanwert). */
export function vendorSlug(countyId) {
  if (typeof countyId !== "string" || !/^[a-z][a-z-]*$/.test(countyId)) {
    throw new Error(`Invalid county id: ${JSON.stringify(countyId)}`);
  }
  return countyId.replace(/-/g, "");
}

export function listingUrl(slug, base = VENDOR_BASE) {
  return `${base}/${slug}/ballotlist.aspx`;
}

export function accessibleBallotUrl(slug, { electionKey, precinctId, style }, base = VENDOR_BASE) {
  const query = new URLSearchParams({
    bpty: style.toLowerCase(),
    elec: electionKey.toLowerCase(),
    prsid: precinctId,
    lang: "en",
  });
  return `${base}/${slug}/xmlview.aspx?${query}`;
}

export function ballotPdfUrl(slug, { electionKey, precinctId, style }, base = VENDOR_BASE) {
  const query = new URLSearchParams({ elect: electionKey, prsid: precinctId, bpty: style });
  return `${base}/${slug}/getballot.aspx?${query}`;
}

/**
 * Three responses are distinguishable and they mean different things: a served
 * county, a county that does not use the application, and a slug that does not
 * exist. Only the first may proceed.
 */
export function classifyCountyResponse({ status, body }) {
  if (status === 500) return "unknown-slug";
  if (status !== 200) return "error";
  if (NOT_A_CUSTOMER.test(body)) return "not-a-customer";
  return "served";
}

/** Resolves a wall clock in Ohio's time zone to an exact instant and ISO offset. */
export function parseVendorTimestamp(stamp) {
  const match = stamp.match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) throw new Error(`Unrecognized vendor timestamp: ${stamp}`);
  const [, mm, dd, yy, rawHour, minute, second, meridiem] = match;
  let hour = Number(rawHour) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;
  const parts = [2000 + Number(yy), Number(mm) - 1, Number(dd), hour, Number(minute), Number(second)];

  // Converge on the UTC instant whose Eastern wall clock is the printed one.
  // Two passes settle every case except the ambiguous hour of a DST fall-back,
  // where the earlier (daylight) instant is the conventional reading.
  let instant = Date.UTC(...parts);
  for (let pass = 0; pass < 2; pass += 1) {
    instant = Date.UTC(...parts) - zoneOffsetMinutes(instant) * 60_000;
  }
  const offset = zoneOffsetMinutes(instant);
  const sign = offset >= 0 ? "+" : "-";
  const pad = (value) => String(Math.abs(value)).padStart(2, "0");
  const local = new Date(instant + offset * 60_000);
  return {
    iso: `${local.toISOString().slice(0, 19)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`,
    instant,
  };
}

function zoneOffsetMinutes(instant) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: VENDOR_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - instant) / 60_000;
}

function selectOptions(html, name) {
  const block = html.match(new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`, "i"));
  if (!block) return [];
  return [...block[0].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
    .map(([, value, text]) => ({ value, text: collapse(text) }));
}

export function parseListing(html) {
  const stamp = html.match(/Election data last updated:\s*([^<]+)/i)?.[1]?.trim() ?? null;
  return {
    notCustomer: NOT_A_CUSTOMER.test(html),
    sourceUpdatedAt: stamp ? parseVendorTimestamp(stamp) : null,
    sourceUpdatedRaw: stamp,
    // The leading option is the "Select an Election Date" prompt, not an election.
    elections: selectOptions(html, "cmbelectionlist").filter((option) => option.value !== "NONE"),
  };
}

/** The vendor's own id for the "Find Ballots" results table. */
export const PRECINCT_TABLE_ID = "tblvtrlist";

/**
 * Reads the precinct-split table produced by "Find Ballots".
 *
 * The row links are single-quoted, so an href="..." pattern silently matches
 * nothing here and the table looks empty.
 *
 * The table is taken by the vendor's own id and read with extractElement, not
 * as the first `<table[\s\S]*?</table>` on the page. Both of those shortcuts
 * fail in the direction of over-reporting coverage: the first table on a
 * redesigned page may be a layout table, and a lazy close-tag match on a table
 * containing a nested one stops early, which drops the rows after the nested
 * table from `precincts` *and* from `listed`, so the two still agree and a
 * fraction of the county certifies as the whole county.
 */
export function parsePrecincts(html) {
  const table = extractElement(html, new RegExp(`<table[^>]*id="${PRECINCT_TABLE_ID}"[^>]*>`, "i"));
  if (table === null) return { tableFound: false, listed: 0, precincts: [], skipped: [], unexplained: [] };

  const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((row) =>
    [...row[0].matchAll(/<t([dh])[^>]*>([\s\S]*?)<\/t\1>/gi)].map((cell) => ({
      tag: `t${cell[1].toLowerCase()}`,
      header: cell[0].match(/headers="([^"]+)"/)?.[1] ?? null,
      html: cell[2],
      text: collapse(cell[2]),
    })),
  );

  // Every row of this table is either the one `<th>` header row or a precinct
  // row whose cells carry `headers=`. A third kind of row is structure we did
  // not parse, and the one we expect is an ASP.NET GridView pager: a paged
  // table makes `listed` and `parsed` agree on a *subset* of the county, which
  // is the single failure mode that looks exactly like success, and a
  // projection intersected over fewer precincts admits more content as common,
  // not less. No served county pages today — Summit lists all 479 splits in one
  // 692 KB response, and no county's table carries a `Page$n` postback — so
  // this exists to stop a vendor change rather than to parse one.
  const dataRows = [];
  const unexplained = [];
  let headerSeen = false;
  for (const cells of rows) {
    if (cells.some((cell) => cell.header)) {
      dataRows.push(cells);
    } else if (!headerSeen && cells.length > 0 && cells.every((cell) => cell.tag === "th")) {
      headerSeen = true;
    } else {
      unexplained.push({ row: cells.map((cell) => cell.text), reason: "neither the header row nor a precinct row" });
    }
  }
  if (/<table\b/i.test(table)) {
    unexplained.push({ row: [], reason: "a nested table inside the results table" });
  }

  const precincts = [];
  const skipped = [];
  for (const cells of dataRows) {
    const byHeader = Object.fromEntries(cells.filter((cell) => cell.header).map((cell) => [cell.header, cell]));
    const link = byHeader.Link?.html ?? "";
    const pdf = link.match(/getballot\.aspx\?([^'"]+)/i)?.[1];
    const accessible = link.match(/xmlview\.aspx\?([^'"]+)/i)?.[1];
    if (!pdf || !accessible) {
      skipped.push({ row: cells.map((cell) => cell.text), reason: "no ballot links in the Link cell" });
      continue;
    }
    const pdfParams = new URLSearchParams(decodeEntities(pdf));
    const accessibleParams = new URLSearchParams(decodeEntities(accessible));

    // The two links are one identity and have to be checked as one. We fetch
    // the accessible link but read the election key and style off the PDF link,
    // so a row whose links point at different ballots would be fetched as a
    // ballot it is not. The vendor lowercases its whole accessible query string
    // and leaves the PDF link cased (elect=20261103G vs elec=20261103g), so
    // every field here folds case. Requiring prsid to match exactly instead
    // looks safer and is not: in Adams every precinct id is digits, so the fold
    // is a no-op and the strict rule passes, but Lucas ids carry letters
    // (prsid=001A__1 vs prsid=001a__1) and the strict rule declined 267 of its
    // 315 rows, which failed the whole county closed. Case is not significant
    // to the vendor either — 001A__1 and 001a__1 return the same 27-contest
    // ballot, a different id returns a different one, and a bogus id errors.
    // The *stored* id stays the PDF link's value verbatim; only agreement folds.
    const precinctId = pdfParams.get("prsid");
    const identity = [
      { name: "prsid", pdf: precinctId, accessible: accessibleParams.get("prsid"), foldCase: true },
      { name: "election", pdf: pdfParams.get("elect"), accessible: accessibleParams.get("elec"), foldCase: true },
      { name: "style", pdf: pdfParams.get("bpty"), accessible: accessibleParams.get("bpty"), foldCase: true },
    ];
    const rowText = cells.map((cell) => cell.text);
    const absent = identity.filter((field) => !field.pdf || !field.accessible).map((field) => field.name);
    if (absent.length > 0) {
      skipped.push({ row: rowText, reason: `the ballot links are missing ${absent.join(", ")}` });
      continue;
    }
    const agrees = (field) =>
      field.foldCase ? field.pdf.toLowerCase() === field.accessible.toLowerCase() : field.pdf === field.accessible;
    const disagree = identity.filter((field) => !agrees(field)).map((field) => field.name);
    if (disagree.length > 0) {
      skipped.push({ row: rowText, reason: `the two ballot links disagree on ${disagree.join(", ")}` });
      continue;
    }
    precincts.push({
      id: precinctId,
      name: byHeader.Precinct_Name?.text ?? null,
      split: byHeader.Precinct_Split?.text ?? null,
      // The style code is authoritative; the cell label ("X - NONPARTISAN") is
      // evidence to keep, not a key to deduplicate on.
      vendor_style: pdfParams.get("bpty"),
      vendor_style_label: byHeader.Style?.text ?? null,
      election_key: pdfParams.get("elect"),
    });
  }
  return { tableFound: true, listed: dataRows.length, precincts, skipped, unexplained };
}

const VOTE_FOR = /\(\s*vote for (?:not more than|no more than|up to)?\s*(\d+)\s*\)/i;

/**
 * Extracts an element's inner HTML by counting nesting depth.
 *
 * A lazy `([\s\S]*?)</div>` stops at the first close tag, which for a ballot
 * issue is the end of its own `issuetext` block rather than the end of the
 * panel. Truncating there would hide text from verifyTextCoverage, which can
 * only check the fragment it is given.
 */
export function extractElement(html, openPattern) {
  const open = html.match(openPattern);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tag = open[0].match(/^<\s*([a-z0-9]+)/i)[1];
  const scanner = new RegExp(`<\\s*(/?)${tag}\\b[^>]*>`, "gi");
  scanner.lastIndex = start;
  let depth = 1;
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return null;
}

/** Parses one contest out of an accessible-ballot page. */
export function parseContestPage(html, { sourceUrl = null } = {}) {
  const position = html.match(/viewing contest\s*(\d+)\s*of\s*(\d+)/i);
  if (!position) throw new Error("No contest position found on the accessible ballot page");
  const panel = extractElement(html, /<div[^>]*id="span_data"[^>]*>/i);
  if (panel === null) throw new Error(`Contest ${position[1]} has no span_data panel`);

  return {
    index: Number(position[1]),
    total: Number(position[2]),
    contest: normalizeContest(panel, { order: Number(position[1]), sourceUrl }),
  };
}

/**
 * Turns the contest panel into a record that keeps every piece of source text.
 *
 * Nothing is dropped: the heading lines, the issue body, and the raw choice
 * lines are all retained, and verifyTextCoverage refuses a parse that loses a
 * word. Party is nullable because judicial and many local races are nonpartisan.
 */
export function normalizeContest(panelHtml, { order, sourceUrl = null } = {}) {
  const heading = panelHtml.match(/<h2[^>]*class="balofficename"[^>]*>([\s\S]*?)<\/h2>/i);
  if (!heading) throw new Error(`Contest ${order} has no heading`);
  const headingLines = toLines(heading[1]);
  if (headingLines.length === 0) throw new Error(`Contest ${order} has an empty heading`);

  const issueBlock = extractElement(panelHtml, /<div[^>]*class="issuetext"[^>]*>/i);
  const issueTextLines = issueBlock === null ? null : toLines(issueBlock);

  const choiceList = panelHtml.match(/<ul[^>]*class="candidates"[^>]*>([\s\S]*?)<\/ul>/i);
  const choiceItems = choiceList ? [...choiceList[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]) : [];

  const [title, ...rest] = headingLines;
  const instructions = rest.filter((line) => line.startsWith("("));
  const subtitles = rest.filter((line) => !line.startsWith("("));

  const voteForSource = [...instructions, ...subtitles].find((line) => VOTE_FOR.test(line));
  const voteFor = voteForSource ? Number(voteForSource.match(VOTE_FOR)[1]) : null;

  const uncertain = [];
  const choices = choiceItems.map((item, position) => {
    const lines = toLines(item);
    if (lines.length === 0) {
      uncertain.push({ choice: position, reason: "empty choice line" });
      return { name: null, party: null, write_in: false, raw_lines: lines };
    }
    if (lines.length > 2) {
      uncertain.push({ choice: position, reason: `${lines.length} lines in one choice; kept verbatim in raw_lines` });
    }
    // Erie prints its write-in row with U+2010 HYPHEN rather than an ASCII
    // hyphen, and an ASCII-only pattern leaves write_in false on all four of
    // them. The row then survives productRace's write-in filter and publishes
    // as a candidate literally named "Write-in", while allows_write_in says the
    // contest takes no write-ins --- and the extra member defeats the
    // candidate-set comparison that identifies statewide races. Matched here
    // across the Unicode dashes instead of normalizing the text, because
    // raw_lines feeds the content fingerprint and must stay verbatim.
    const writeIn = /^write[\p{Pd}\u2212\u00ad\s]?in$/iu.test(lines[0]);
    return {
      name: lines[0],
      party: lines.length === 2 ? lines[1] : null,
      write_in: writeIn,
      raw_lines: lines,
    };
  });

  const contest = {
    order,
    kind: issueTextLines ? "issue" : "office",
    title,
    subtitles,
    instructions,
    vote_for: voteFor,
    issue_text_lines: issueTextLines,
    choices,
    allows_write_in: choices.some((choice) => choice.write_in),
    source_url: sourceUrl,
    raw: { heading_lines: headingLines, choice_lines: choiceItems.map((item) => toLines(item)) },
    uncertain,
  };

  verifyTextCoverage(panelHtml, contest);
  return contest;
}

/**
 * Fails closed when normalization would drop source text.
 *
 * The panel contains only the heading, the optional issue body, and the
 * choices, so every word in it must survive into the record. A contest we
 * cannot represent completely is worse than a contest we refuse to ingest.
 */
export function verifyTextCoverage(panelHtml, contest) {
  const words = (value) => collapse(value).split(" ").filter(Boolean);
  const sourceWords = toLines(panelHtml).flatMap(words);
  const keptWords = [
    contest.title,
    ...contest.subtitles,
    ...contest.instructions,
    ...(contest.issue_text_lines ?? []),
    ...contest.choices.flatMap((choice) => choice.raw_lines),
  ].flatMap(words);

  const tally = new Map();
  for (const word of keptWords) tally.set(word, (tally.get(word) ?? 0) + 1);
  const missing = [];
  for (const word of sourceWords) {
    const count = tally.get(word) ?? 0;
    if (count === 0) missing.push(word);
    else tally.set(word, count - 1);
  }
  if (missing.length > 0) {
    throw new Error(
      `Contest ${contest.order} ("${contest.title}") would drop source text: ${missing.slice(0, 8).join(" ")}`,
    );
  }
}

// Per-precinct provenance rather than ballot content: source_url carries the
// precinct in its query string, so hashing it would make every precinct unique
// and defeat deduplication entirely. Everything else in a contest record is
// content and takes part in the ballot's identity.
const NON_CONTENT_CONTEST_FIELDS = new Set(["source_url"]);

/**
 * Stable identity for a complete normalized ballot.
 *
 * Naming the hashed fields by hand let a ballot change without changing its id:
 * a choice's third line is preserved in raw_lines and shown to a reviewer, but
 * was left out of the canonical form, so two different ballots deduplicated
 * into one. The identity is therefore the whole record minus an explicit
 * exclusion list, which hashes a field added later by default instead of
 * silently ignoring it.
 */
export function ballotId(contests) {
  const canonical = contests.map((contest) =>
    canonicalize(
      Object.fromEntries(Object.entries(contest).filter(([key]) => !NON_CONTENT_CONTEST_FIELDS.has(key))),
    ),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** Sorts object keys at every depth so the hash cannot depend on key order. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

const HIDDEN_INPUT = /<input[^>]*type="hidden"[^>]*>/gi;

export function hiddenFields(html) {
  return Object.fromEntries(
    [...html.matchAll(HIDDEN_INPUT)]
      .map((match) => [match[0].match(/name="([^"]+)"/)?.[1], decodeEntities(match[0].match(/value="([^"]*)"/)?.[1] ?? "")])
      .filter(([name]) => name),
  );
}

// The vendor serves a degraded page to a user agent that does not begin with
// "Mozilla/5.0" — the listing comes back 2 KB shorter and "Find Ballots" then
// answers an error page with no precinct table. Verified 2026-10-16: the prefix
// is the whole gate, so the tool can still name itself after it.
const USER_AGENT = "Mozilla/5.0 (compatible; ohio-ballot-guide/0.1; manual ingest)";

/**
 * A request that never produced an answer: a timeout, a refused or dropped
 * connection, a DNS failure, a body that died mid-stream.
 *
 * Typed so a caller can tell it apart from everything else that can throw on
 * the way through a county. The distinction is not cosmetic: a transport
 * failure says nothing about the county and is answered by running again,
 * while a parse failure or a bug here is a fact about this code that re-running
 * will reproduce. A caller that cannot tell them apart has to treat one like
 * the other, and the safe-looking choice -- record it, continue -- turns a
 * parser regression into 88 counties labelled "try again."
 */
export class VendorTransportError extends Error {
  constructor(url, cause) {
    super(`the request to ${url} failed before answering: ${cause.message}`);
    this.name = "VendorTransportError";
    this.cause = cause;
  }
}

/**
 * Minimal WebForms client. The vendor's listing needs an autopostback to select
 * the election and a submit to list precincts, and the accessible ballot pages
 * one contest at a time, so the session's __VIEWSTATE has to be carried along.
 */
export function createVendorClient({ fetchImpl = fetch, base = VENDOR_BASE, delayMs = 350, timeoutMs = 30_000 } = {}) {
  let cookie = "";
  async function request(url, init) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          "user-agent": USER_AGENT,
          ...(cookie ? { cookie } : {}),
          ...(init?.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new VendorTransportError(url, error);
    }
    const jar = response.headers?.getSetCookie?.() ?? [];
    if (jar.length) cookie = jar.map((entry) => entry.split(";")[0]).join("; ");
    // Reading the body is a second chance to lose the connection, and a
    // half-read page is a transport failure rather than a vendor answer.
    let body;
    try {
      body = await response.text();
    } catch (error) {
      throw new VendorTransportError(url, error);
    }
    return { status: response.status, body };
  }
  const post = (url, fields) => request(url, { method: "POST", body: new URLSearchParams(fields).toString() });
  const pause = () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve());
  return { base, request, post, pause };
}

/**
 * Applies every gate that decides whether a parsed precinct listing is the
 * whole county, and throws naming the county when one fails.
 *
 * This is separate from ingestCounty so that anything else asking "is this
 * county's precinct listing complete?" — the coverage survey, in particular —
 * gets the answer from these rules rather than from a second copy of them. A
 * second copy would drift, and it would drift in the direction that reads as
 * coverage: a survey more permissive than the adapter reports counties as
 * enumerable that the adapter then refuses, and one that is stricter hides
 * counties we could publish. Both are silent.
 */
export function assertEnumeration({ countyId, electionKey, tableFound, listed, precincts, skipped, unexplained }) {
  if (!tableFound) {
    throw new Error(
      `${countyId}: the "Find Ballots" response has no table with id="${PRECINCT_TABLE_ID}", so the vendor's results markup changed`,
    );
  }
  // An unparsed row is the only enumeration failure the count check cannot see:
  // a pager row is not a precinct row, so listed and parsed agree over the page
  // the vendor happened to serve.
  if (unexplained.length > 0) {
    throw new Error(
      `${countyId}: the results table has ${unexplained.length} row(s) this adapter does not parse` +
        ` (${unexplained[0].reason}: ${JSON.stringify(unexplained[0].row)}), so ${listed} may not be the whole county`,
    );
  }
  if (precincts.length === 0) {
    throw new Error(`${countyId}: precinct enumeration yielded no ballots`);
  }
  if (precincts.length !== listed) {
    throw new Error(
      `${countyId}: listed ${listed} precinct rows but parsed ${precincts.length}` +
        (skipped.length ? ` (${skipped[0].reason})` : ""),
    );
  }
  // The rows carry their own election key. If the vendor answered with a
  // different election than the one we selected, the snapshot would be labelled
  // with an election it does not contain.
  const wrongElection = precincts.find((precinct) => precinct.election_key !== electionKey);
  if (wrongElection) {
    throw new Error(
      `${countyId}: precinct ${wrongElection.id} is listed under election ${wrongElection.election_key}, not ${electionKey}`,
    );
  }
}

/**
 * Fetches one county's complete precinct ballots for one election.
 *
 * Every gate in docs/BALLOT_INGESTION.md throws rather than returning a partial
 * snapshot, because a snapshot that silently covers fewer precincts than the
 * county listed looks like coverage and is not.
 */
/**
 * Walks the vendor's four opening requests and returns the county's precinct
 * list: the opening GET, the election autopostback, the "Find Ballots" POST,
 * and the version gate over the page it answers with.
 *
 * Extracted because three callers need exactly this sequence --- the ingest
 * below, the coverage survey, and the contest survey --- and a second copy of
 * it is how the statewide-issue generator ended up walking the vendor without
 * the stamp gate or the enumeration check. Every refusal here is the adapter's
 * own, including the ones a lighter caller might be tempted to skip: a county
 * whose precinct table cannot be fully accounted for is not a county anything
 * should report a number about.
 */
async function selectElection({ client, listing, countyId, electionKey, body, action = "selecting" }) {
  const fields = {
    ...hiddenFields(body),
    cmbelectionlist: electionKey,
    __EVENTTARGET: "cmbelectionlist",
    __EVENTARGUMENT: "",
  };
  const selected = await client.post(listing, fields);
  if (selected.status !== 200) {
    throw new Error(`${countyId}: ${action} election ${electionKey} returned HTTP ${selected.status}`);
  }
  const parsed = parseListing(selected.body);
  if (!parsed.sourceUpdatedAt) {
    throw new Error(`${countyId}: the selected election has no "Election data last updated" stamp`);
  }
  return { response: selected, parsed };
}

async function recheckSelectedStamp({ client, listing, countyId, electionKey, expected, where }) {
  const fresh = await client.request(listing);
  if (fresh.status !== 200) {
    throw new Error(`${countyId}: re-reading the listing after the ballot walk returned HTTP ${fresh.status}`);
  }
  const selected = await selectElection({
    client,
    listing,
    countyId,
    electionKey,
    body: fresh.body,
    action: "re-selecting",
  });
  requireSameStamp(countyId, expected, selected.response.body, where);
}

export async function openCountyListing({ client, countyId, electionKey }) {
  const slug = vendorSlug(countyId);
  const listing = listingUrl(slug, client.base);
  const first = await client.request(listing);

  const classification = classifyCountyResponse(first);
  if (classification !== "served") {
    throw new Error(`${countyId}: vendor response is "${classification}", not a served county`);
  }
  const initialListing = parseListing(first.body);
  if (!initialListing.elections.some((option) => option.value === electionKey)) {
    throw new Error(
      `${countyId}: election ${electionKey} is absent; offered ${initialListing.elections.map((o) => o.value).join(", ") || "nothing"}`,
    );
  }

  // Select the election (autopostback), then ask for the precinct list. A
  // failed postback returns a page with no __VIEWSTATE, which would otherwise
  // surface three steps later as an empty precinct table.
  const selected = await selectElection({ client, listing, countyId, electionKey, body: first.body });
  // The stamp is election-scoped. Miami's opening GET defaults to its special
  // election, whose stamp differs from the requested general election. The
  // selected response is the first page that identifies the version we are
  // about to walk, so all later comparisons must anchor here.
  const parsedListing = selected.parsed;
  await client.pause();
  const submitFields = {
    ...hiddenFields(selected.response.body),
    cmbelectionlist: electionKey,
    cmbDistrictCat: "",
    btnsubmit: "Find Ballots",
  };
  const listed = await client.post(listing, submitFields);
  if (listed.status !== 200) {
    throw new Error(`${countyId}: listing precincts returned HTTP ${listed.status}`);
  }

  requireSameStamp(countyId, parsedListing.sourceUpdatedRaw, listed.body, "the precinct list");

  const enumeration = parsePrecincts(listed.body);
  assertEnumeration({ countyId, electionKey, ...enumeration });
  return { slug, listing, parsedListing, enumeration, precincts: enumeration.precincts };
}

/**
 * Reads one county's first enumerated ballot and nothing else.
 *
 * For callers that measure the ballot's shape rather than publish it: one walk
 * instead of the whole county, at the cost of saying nothing about precincts
 * other than the one it read. The stamp is re-checked after the walk for the
 * same reason the ingest does it --- a board editing mid-walk otherwise yields
 * contests from two versions of the ballot and reports success.
 */
export async function readFirstBallot({ client, countyId, electionKey }) {
  const opened = await openCountyListing({ client, countyId, electionKey });
  const precinct = opened.precincts[0];
  if (!precinct) throw new Error(`${countyId}: the precinct list parsed no precincts`);
  const target = { electionKey, precinctId: precinct.id, style: precinct.vendor_style };
  const url = accessibleBallotUrl(opened.slug, target, client.base);
  const contests = await walkBallot({ client, url, countyId, precinct });

  await recheckSelectedStamp({
    client,
    listing: opened.listing,
    countyId,
    electionKey,
    expected: opened.parsedListing.sourceUpdatedRaw,
    where: "the selected listing re-read after the ballot walk",
  });

  return {
    precinct,
    contests,
    listing_url: opened.listing,
    ballot_url: url,
    precincts_listed: opened.precincts.length,
    source_updated_at: opened.parsedListing.sourceUpdatedAt.iso,
  };
}

export async function ingestCounty({
  countyId,
  electionKey,
  electionId = null,
  client = createVendorClient(),
  now = () => new Date(),
}) {
  const opened = await openCountyListing({ client, countyId, electionKey });
  const { slug, listing, parsedListing, enumeration, precincts } = opened;

  const ballots = {};
  const seen = new Map();
  const precinctRecords = [];
  for (const precinct of precincts) {
    const target = { electionKey, precinctId: precinct.id, style: precinct.vendor_style };
    const htmlUrl = accessibleBallotUrl(slug, target, client.base);
    const contests = await walkBallot({ client, url: htmlUrl, countyId, precinct });
    const id = ballotId(contests);

    const previous = seen.get(precinct.id);
    if (previous && previous !== id) {
      throw new Error(`${countyId}: precinct ${precinct.id} returned two different ballots in one run`);
    }
    seen.set(precinct.id, id);
    ballots[id] ??= { contests };

    precinctRecords.push({
      id: precinct.id,
      name: precinct.name,
      split: precinct.split,
      vendor_style: precinct.vendor_style,
      vendor_style_label: precinct.vendor_style_label,
      ballot_id: id,
      html_url: htmlUrl,
      pdf_url: ballotPdfUrl(slug, target, client.base),
    });
    await client.pause();
  }

  // Checking the stamp at enumeration only covers the cheap end of the run. The
  // ballot walk is the long part — roughly one request per contest per precinct,
  // about 550 for Adams — so re-read the listing afterwards and require the same
  // stamp. Without this, a source update partway through yields a snapshot that
  // mixes two versions of the ballot and reports success.
  await recheckSelectedStamp({
    client,
    listing,
    countyId,
    electionKey,
    expected: parsedListing.sourceUpdatedRaw,
    where: "the selected listing re-read after the ballot walk",
  });

  const fetchedAt = now();
  return {
    schema_version: SCHEMA_VERSION,
    election: { id: electionId ?? electionIdFromKey(electionKey), vendor_key: electionKey },
    county: { id: countyId, vendor_slug: slug },
    source: {
      listing_url: listing,
      fetched_at: fetchedAt.toISOString(),
      source_updated_at: parsedListing.sourceUpdatedAt.iso,
      source_age_hours: Number(((fetchedAt.getTime() - parsedListing.sourceUpdatedAt.instant) / 3_600_000).toFixed(1)),
    },
    enumeration: {
      listed_precincts: enumeration.listed,
      parsed_precincts: precinctRecords.length,
      skipped: enumeration.skipped,
      unexplained_rows: enumeration.unexplained,
    },
    precincts: precinctRecords,
    ballots,
  };
}

/**
 * The vendor prints its own update stamp on every page of the flow, which makes
 * it the source's version marker for the run. A missing stamp is missing
 * identity evidence, not agreement, so absence fails here rather than passing.
 *
 * Exported for the same reason assertEnumeration is: the coverage survey walks
 * the same first two requests and has to apply the same version gate, or it
 * reports a county the adapter would then reject when the board edits between
 * the opening GET and the precinct-list POST.
 */
export function requireSameStamp(countyId, expected, body, where) {
  const actual = parseListing(body).sourceUpdatedRaw;
  if (!actual) {
    throw new Error(`${countyId}: ${where} carries no "Election data last updated" stamp`);
  }
  if (actual !== expected) {
    throw new Error(`${countyId}: source changed during the run ("${expected}" -> "${actual}") at ${where}`);
  }
}

export async function walkBallot({ client, url, countyId, precinct }) {
  const first = await client.request(url);
  if (first.status !== 200) {
    throw new Error(`${countyId}: precinct ${precinct.id} accessible ballot returned HTTP ${first.status}`);
  }
  const start = parseContestPage(first.body, { sourceUrl: url });
  if (start.index !== 1) {
    throw new Error(
      `${countyId}: precinct ${precinct.id} ballot walk started at contest ${start.index} of ${start.total}, not contest 1`,
    );
  }
  if (start.total < 1) {
    throw new Error(`${countyId}: precinct ${precinct.id} ballot reported an invalid total of ${start.total} contests`);
  }
  const contests = [start.contest];
  let page = first.body;
  for (let expected = 2; expected <= start.total; expected += 1) {
    const next = await client.post(url, { ...hiddenFields(page), btn_next: "Next Contest" });
    if (next.status !== 200) {
      throw new Error(
        `${countyId}: precinct ${precinct.id} ballot walk stopped at contest ${expected} of ${start.total} with HTTP ${next.status}`,
      );
    }
    // A walk that stops early returns a page the contest parser cannot read.
    // Report that as the truncation it is rather than as a parse failure.
    let parsed;
    try {
      parsed = parseContestPage(next.body, { sourceUrl: url });
    } catch (cause) {
      throw new Error(
        `${countyId}: precinct ${precinct.id} ballot walk ended at ${contests.length} of ${start.total} contests (${cause.message})`,
        { cause },
      );
    }
    if (parsed.index !== expected) {
      throw new Error(
        `${countyId}: precinct ${precinct.id} ballot walk reached contest ${parsed.index} when ${expected} was next`,
      );
    }
    if (parsed.total !== start.total) {
      throw new Error(
        `${countyId}: precinct ${precinct.id} ballot contest total changed from ${start.total} to ${parsed.total} at contest ${expected}`,
      );
    }
    contests.push(parsed.contest);
    page = next.body;
    await client.pause();
  }
  return contests;
}

/** 20261103G -> 2026-11-03-general, matching data/elections.json ids. */
export function electionIdFromKey(electionKey) {
  const match = electionKey.match(/^(\d{4})(\d{2})(\d{2})([A-Z])$/i);
  if (!match) throw new Error(`Unrecognized vendor election key: ${electionKey}`);
  const kinds = { G: "general", P: "primary", S: "special" };
  const kind = kinds[match[4].toUpperCase()];
  if (!kind) throw new Error(`Unknown election kind in vendor key: ${electionKey}`);
  return `${match[1]}-${match[2]}-${match[3]}-${kind}`;
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    // Split on the first "=" only: a value may legitimately contain one.
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
  }
  return args;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.county) throw new Error("--county is required (a data/county-boards.json id, e.g. adams)");
    if (!args.election) throw new Error("--election is required (a vendor key, e.g. 20261103G)");
    const snapshot = await ingestCounty({ countyId: args.county, electionKey: args.election });
    const output = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (args.out) {
      await writeFile(args.out, output);
      console.log(
        `Wrote ${args.out}: ${snapshot.precincts.length} precincts, ${Object.keys(snapshot.ballots).length} distinct ballots, source ${snapshot.source.source_age_hours}h old`,
      );
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
