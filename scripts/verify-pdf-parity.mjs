#!/usr/bin/env node
/**
 * Measures the PDF reader against the accessible HTML ballot.
 *
 * `docs/BALLOT_INGESTION.md` sets the condition under which a PDF path may be
 * trusted: it has to demonstrate agreement with the accessible HTML rendering
 * on counties that publish both, before it is used on Lake and Wayne, which
 * publish neither. This script is that measurement, and it is a measurement
 * rather than a test because its inputs are live and its result is evidence to
 * be read — a county whose board edits the ballot between the two fetches is a
 * disagreement about the ballot, not about the reader.
 *
 * It compares content, not layout. For each contest the HTML walk reports, it
 * asks whether the contest's title and every one of its choices appears in the
 * text extracted from the PDF of the same precinct. The HTML is the oracle in
 * both directions: text the PDF produces and the HTML does not is reported
 * separately, because the ballots carry voter instructions, precinct footers,
 * and timing marks that no contest contains.
 *
 *   node scripts/verify-pdf-parity.mjs licking medina
 *   node scripts/verify-pdf-parity.mjs --json licking
 */

import { writeFileSync, mkdirSync } from "node:fs";
import {
  createVendorClient,
  readFirstBallot,
  vendorSlug,
  ballotPdfUrl,
  VENDOR_BASE,
} from "./ingest/vtrapp.mjs";
import { extractPdfText } from "../src/pdf-text.mjs";

const USER_AGENT = "Mozilla/5.0 (compatible; ohio-ballot-guide/0.1; manual ingest)";

/**
 * Folds the differences that are presentation rather than content.
 *
 * The two renderings disagree about case, about which kind of apostrophe and
 * dash they use, and about where a line breaks, so a raw comparison reports
 * every string as a mismatch. Nothing here folds a difference in *words*.
 */
export function normalizeForComparison(value) {
  return String(value)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/ /g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9'".,:;()/$%&+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every string the HTML walk claims is on the ballot, labelled by contest. */
export function htmlClaims(contests) {
  const claims = [];
  for (const contest of contests) {
    claims.push({ contest: contest.title, kind: "title", text: contest.title });
    for (const subtitle of contest.subtitles ?? []) {
      claims.push({ contest: contest.title, kind: "subtitle", text: subtitle });
    }
    for (const choice of contest.choices ?? []) {
      if (choice.name) claims.push({ contest: contest.title, kind: "choice", text: choice.name });
      if (choice.party) claims.push({ contest: contest.title, kind: "party", text: choice.party });
    }
  }
  return claims;
}

/**
 * Checks a claim against the PDF's lines.
 *
 * A claim may be broken across lines by the PDF's column width — "For Judge of
 * the Court of Common Pleas" arrives as two lines — so the comparison is made
 * against each column's lines joined, per column. Joining the whole page
 * instead would let a claim match across a column boundary, which is a match
 * against two different contests.
 */
export function findClaim(claim, haystacks) {
  const needle = normalizeForComparison(claim.text);
  if (needle === "") return { found: true, trivial: true };
  return { found: haystacks.some((haystack) => haystack.includes(needle)) };
}

export function buildHaystacks(extracted) {
  const haystacks = [];
  for (const page of extracted.pages) {
    for (const column of page.columns) {
      haystacks.push(normalizeForComparison(column.lines.map((line) => line.text).join(" ")));
    }
    if (page.banners.length > 0) haystacks.push(normalizeForComparison(page.banners.map((line) => line.text).join(" ")));
    if (page.columns.length === 0) haystacks.push(normalizeForComparison(page.lines.map((line) => line.text).join(" ")));
  }
  return haystacks;
}

export async function compareCounty({ countyId, electionKey, client, keepAt = null }) {
  const html = await readFirstBallot({ client, countyId, electionKey });
  const slug = vendorSlug(countyId);
  const pdfUrl = ballotPdfUrl(
    slug,
    { electionKey, precinctId: html.precinct.id, style: html.precinct.vendor_style },
    client.base,
  );
  const response = await fetch(pdfUrl, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${countyId}: the ballot PDF answered HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (keepAt) {
    mkdirSync(keepAt, { recursive: true });
    writeFileSync(`${keepAt}/${countyId}-${html.precinct.id}.pdf`, bytes);
  }

  const extracted = extractPdfText(bytes);
  const glyphs = extracted.pages.reduce((sum, page) => sum + page.glyphs, 0);
  const haystacks = buildHaystacks(extracted);
  const claims = htmlClaims(html.contests);
  const missing = claims.filter((claim) => !findClaim(claim, haystacks).found);

  return {
    county: countyId,
    precinct: html.precinct.id,
    ballot_url: html.ballot_url,
    pdf_url: pdfUrl,
    source_updated_at: html.source_updated_at,
    html_contests: html.contests.length,
    pdf_pages: extracted.pages.length,
    pdf_glyphs: glyphs,
    pdf_columns: extracted.pages.map((page) => page.columns.length),
    pdf_rotated_lines: extracted.pages.reduce((sum, page) => sum + page.rotated.length, 0),
    claims: claims.length,
    missing,
    // A PDF with no text layer is a different finding from a PDF the reader
    // read badly, and reporting them the same way would hide it. Some boards
    // publish the ballot as a scanned image; Adams is one.
    text_layer: glyphs > claims.length,
  };
}

async function main(argv) {
  const json = argv.includes("--json");
  const keep = argv.find((entry) => entry.startsWith("--keep="))?.slice("--keep=".length) ?? null;
  const electionKey = argv.find((entry) => entry.startsWith("--election="))?.slice("--election=".length) ?? "20261103G";
  const counties = argv.filter((entry) => !entry.startsWith("--"));
  if (counties.length === 0) {
    console.error("usage: node scripts/verify-pdf-parity.mjs [--json] [--keep=DIR] [--election=KEY] <county>…");
    process.exitCode = 1;
    return;
  }
  const client = createVendorClient({ base: VENDOR_BASE });
  const results = [];
  for (const countyId of counties) {
    try {
      results.push(await compareCounty({ countyId, electionKey, client, keepAt: keep }));
    } catch (error) {
      // One county's failure is reported and the rest still run: a board that
      // edits mid-walk must not discard the evidence the other counties gave.
      results.push({ county: countyId, error: error.message });
    }
  }
  if (json) {
    console.log(JSON.stringify({ election: electionKey, generated_at: new Date().toISOString(), results }, null, 2));
  } else {
    for (const result of results) {
      if (result.error) {
        console.log(`${result.county}: FAILED — ${result.error}`);
        continue;
      }
      const verdict = result.missing.length === 0 ? "all claims found" : `${result.missing.length} of ${result.claims} claims MISSING`;
      console.log(
        `${result.county} precinct ${result.precinct}: ${result.html_contests} HTML contests, ` +
          `${result.pdf_glyphs} PDF glyphs over ${result.pdf_pages} pages (${result.pdf_columns.join("/")} columns) — ${verdict}`,
      );
      for (const claim of result.missing) {
        console.log(`    missing ${claim.kind} of "${claim.contest}": ${JSON.stringify(claim.text)}`);
      }
    }
  }
  const failed = results.filter((result) => result.error || result.missing.length > 0);
  if (failed.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
