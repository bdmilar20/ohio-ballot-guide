import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import test from "node:test";

import {
  PdfFormatError,
  assembleLines,
  columnsRuledAt,
  detectRuledColumns,
  extractPdfText,
  openPdf,
  parseCidWidths,
  parseToUnicode,
  readObject,
  runContentStream,
  sliceLineByColumns,
} from "../src/pdf-text.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url));

/**
 * Builds the smallest PDF that reaches a given refusal.
 *
 * Synthetic input is the right shape here and the wrong shape for the reading
 * tests below: no real county serves an encrypted ballot or one whose font has
 * no /ToUnicode, so the only way to prove the refusals fire is to construct the
 * document. Everything asserted about *reading* a ballot is asserted against a
 * PDF the vendor actually served.
 */
function buildPdf(objects, { trailer = "" } = {}) {
  let body = "%PDF-1.4\n";
  for (const [number, source] of Object.entries(objects)) body += `${number} 0 obj\n${source}\nendobj\n`;
  return Buffer.from(`${body}trailer\n<< /Root 1 0 R ${trailer} >>\n%%EOF\n`, "latin1");
}

const streamObject = (dict, data) => {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  return `<< ${dict} /Length ${payload.length} >>\nstream\n${payload.toString("latin1")}\nendstream`;
};

test("readObject distinguishes an indirect reference from two numbers", () => {
  assert.deepEqual(readObject("12 0 R", 0).value, { ref: 12, generation: 0 });
  // `[12 0]` is a two-element array. Collapsing it to a reference is the bug
  // that makes a MediaBox resolve to a page.
  assert.deepEqual(readObject("[12 0]", 0).value, [12, 0]);
  assert.deepEqual(readObject("12 0", 0).value, 12);
  assert.deepEqual(readObject("12.5 0 R", 0).value, 12.5);
  assert.deepEqual(readObject("12 0 Rotate", 0).value, 12);
});

test("readObject reads nested dictionaries, names, and both string forms", () => {
  const { value } = readObject("<< /A << /B [/One 2 (three) <414243>] >> /C#41 true >>", 0);
  assert.deepEqual(value.A.B[0], { name: "One" });
  assert.equal(value.A.B[1], 2);
  assert.equal(Buffer.from(value.A.B[2].bytes).toString("latin1"), "three");
  assert.equal(Buffer.from(value.A.B[3].bytes).toString("latin1"), "ABC");
  assert.equal(value.CA, true);
});

test("readObject decodes literal-string escapes and nested parentheses", () => {
  const { value } = readObject("(a\\(b\\)c \\101 \\n)", 0);
  assert.equal(Buffer.from(value.bytes).toString("latin1"), "a(b)c A \n");
  assert.equal(Buffer.from(readObject("((inner) outer)", 0).value.bytes).toString("latin1"), "(inner) outer");
});

test("parseToUnicode reads bfchar and both bfrange forms", () => {
  const map = parseToUnicode(`
    2 beginbfchar
    <0004> <0045>
    <0003> <0020>
    endbfchar
    2 beginbfrange
    <0010> <0012> <0041>
    <0020> <0021> [<0061> <0062>]
    endbfrange
  `);
  assert.equal(map.get(0x0004), "E");
  assert.equal(map.get(0x0003), " ");
  assert.equal(map.get(0x0010), "A");
  assert.equal(map.get(0x0012), "C");
  assert.equal(map.get(0x0020), "a");
  assert.equal(map.get(0x0021), "b");
  assert.equal(map.get(0x0013), undefined);
});

test("parseCidWidths reads the range form and the array form", () => {
  assert.deepEqual([...parseCidWidths([3, 5, 250]).entries()], [
    [3, 250],
    [4, 250],
    [5, 250],
  ]);
  assert.deepEqual([...parseCidWidths([7, [100, 200]]).entries()], [
    [7, 100],
    [8, 200],
  ]);
});

test("assembleLines groups baselines and inserts a space only at a real gap", () => {
  // Four glyphs at a 5pt advance with one 4pt gap, plus one glyph on a lower
  // baseline. This is the generator's actual shape: one glyph per show, no
  // space glyphs, absolute positions.
  const glyphs = [
    { text: "A", x: 0, y: 100, width: 5, size: 10, angle: 0 },
    { text: "B", x: 5, y: 100, width: 5, size: 10, angle: 0 },
    { text: "C", x: 14, y: 100, width: 5, size: 10, angle: 0 },
    { text: "D", x: 0, y: 80, width: 5, size: 10, angle: 0 },
  ];
  const lines = assembleLines(glyphs);
  assert.deepEqual(lines.map((line) => line.text), ["AB C", "D"]);
  // Raising the threshold above the gap must remove the space, which is what
  // proves the space came from the gap rule and not from the input.
  assert.deepEqual(assembleLines(glyphs, { spaceRatio: 1 }).map((line) => line.text), ["ABC", "D"]);
});

test("assembleLines orders a line by position, not by the order glyphs arrive", () => {
  const lines = assembleLines([
    { text: "B", x: 50, y: 10, width: 5, size: 10, angle: 0 },
    { text: "A", x: 0, y: 10, width: 5, size: 10, angle: 0 },
  ]);
  assert.deepEqual(lines.map((line) => line.text), ["A B"]);
});

test("detectRuledColumns reads boundaries off vertical rules and refuses one edge", () => {
  const rule = (x, from, to) => ({ from: { x, y: from }, to: { x, y: to } });
  const three = detectRuledColumns([
    rule(33.8, 100, 700),
    rule(215.3, 100, 700),
    rule(396.7, 100, 700),
    rule(578.2, 100, 700),
  ]);
  assert.deepEqual(three.map((column) => [column.x0, column.x1]), [
    [33.8, 215.3],
    [215.3, 396.7],
    [396.7, 578.2],
  ]);
  const one = detectRuledColumns([rule(33.8, 100, 700), rule(578.2, 100, 700)]);
  assert.deepEqual(one.map((column) => [column.x0, column.x1]), [[33.8, 578.2]]);
  assert.equal(detectRuledColumns([rule(33.8, 100, 700)]), null);
  assert.equal(detectRuledColumns([]), null);
  // A short rule is a box edge inside a column, not a column boundary.
  assert.equal(detectRuledColumns([rule(33.8, 100, 700), rule(100, 300, 305), rule(578.2, 100, 700)]).length, 1);
});

test("columnsRuledAt is false above and below the ruled region", () => {
  const rule = (x, from, to) => ({ from: { x, y: from }, to: { x, y: to } });
  const columns = detectRuledColumns([
    rule(33.8, 100, 700),
    rule(215.3, 100, 700),
    rule(396.7, 100, 700),
    rule(578.2, 100, 700),
  ]);
  assert.equal(columnsRuledAt(columns, 400), true);
  assert.equal(columnsRuledAt(columns, 900), false);
  assert.equal(columnsRuledAt(columns, 50), false);
});

test("sliceLineByColumns cuts at a gap and keeps text that runs across a boundary", () => {
  const columns = [
    { x0: 0, x1: 100 },
    { x0: 100, x1: 200 },
  ];
  const glyph = (text, x) => ({ text, x, y: 10, width: 5, size: 10, angle: 0 });
  const gapped = assembleLines([glyph("A", 10), glyph("B", 120)])[0];
  assert.deepEqual(sliceLineByColumns(gapped, columns).map((run) => [run.column, run.text]), [
    [0, "A"],
    [1, "B"],
  ]);
  // Continuous text across the boundary is one line spanning the page. Cutting
  // it yields two half-words in two different columns.
  const continuous = assembleLines([glyph("A", 92), glyph("B", 97), glyph("C", 102)])[0];
  assert.deepEqual(sliceLineByColumns(continuous, columns).map((run) => [run.column, run.text]), [[null, "ABC"]]);
});

test("runContentStream separates rotated text and reports painted rules only", () => {
  const fonts = {
    F1: {
      baseFont: "Test",
      bytesPerCode: 1,
      toUnicode: null,
      simpleDifferences: new Map(),
      widths: new Map(),
      defaultWidth: 500,
    },
  };
  const { glyphs, segments } = runContentStream(
    [
      "BT /F1 10 Tf 1 0 0 1 10 100 Tm (Up) Tj ET",
      // A rotated `cm` is how the generator stamps its "Sample" watermark.
      "q 0.9063 0.4226 -0.4226 0.9063 0 0 cm BT /F1 10 Tf 1 0 0 1 10 100 Tm (S) Tj ET Q",
      // Painted, then clipped: only the first is layout.
      "0 0 m 0 500 l S",
      "100 0 100 500 re W n",
    ].join("\n"),
    { fonts },
  );
  assert.deepEqual(glyphs.map((glyph) => glyph.angle), [0, 0, 25]);
  assert.equal(segments.length, 1);
  assert.deepEqual([segments[0].from, segments[0].to], [
    { x: 0, y: 0 },
    { x: 0, y: 500 },
  ]);
});

test("runContentStream refuses a font the page's resources do not define", () => {
  assert.throws(() => runContentStream("BT /Nope 10 Tf (x) Tj ET", { fonts: {} }), PdfFormatError);
});

test("openPdf refuses a file that is not a PDF, and one with no objects", () => {
  assert.throws(() => openPdf(Buffer.from("not a pdf")), /does not begin with %PDF-/);
  assert.throws(() => openPdf(Buffer.from("%PDF-1.4\ntrailer\n")), /declares no objects/);
});

test("extractPdfText refuses an encrypted document rather than reading nothing", () => {
  const bytes = buildPdf(
    {
      1: "<< /Type /Catalog /Pages 2 0 R >>",
      2: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      3: "<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>",
      4: streamObject("", "BT ET"),
      5: "<< /Filter /Standard >>",
    },
    { trailer: "/Encrypt 5 0 R" },
  );
  assert.throws(() => extractPdfText(bytes), /encrypted/);
});

test("extractPdfText refuses an unsupported stream filter", () => {
  const bytes = buildPdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    3: "<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>",
    4: streamObject("/Filter /LZWDecode", "junk"),
  });
  assert.throws(() => extractPdfText(bytes), /unsupported filter \/LZWDecode/);
});

test("extractPdfText refuses an Identity-H font with no /ToUnicode", () => {
  // Without the CMap the show operands are glyph ids with no stated meaning.
  // Reading them as characters is the failure this refusal exists to prevent,
  // because it returns text rather than an error.
  const bytes = buildPdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    4: streamObject("", "BT /F1 10 Tf <0004> Tj ET"),
    5: "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] >>",
    6: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /DW 500 >>",
  });
  assert.throws(() => extractPdfText(bytes), /no \/ToUnicode/);
});

test("extractPdfText inflates a FlateDecode content stream and reads a WinAnsi font", () => {
  const bytes = buildPdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    4: streamObject(
      "/Filter /FlateDecode",
      deflateSync(Buffer.from("BT /F1 10 Tf 1 0 0 1 20 700 Tm (Levy) Tj ET", "latin1")),
    ),
    5: "<< /Type /Font /Subtype /TrueType /BaseFont /ArialMT /Encoding /WinAnsiEncoding /FirstChar 76 /Widths [556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556 556] >>",
  });
  const extracted = extractPdfText(bytes);
  assert.equal(extracted.pages.length, 1);
  assert.equal(extracted.pages[0].width, 612);
  assert.match(extracted.text, /Levy/);
});

test("the Lake ballot reads as three ruled columns of real contests", () => {
  const extracted = extractPdfText(fixture("lake-121A__1.pdf"));
  assert.equal(extracted.pages.length, 2);
  const page = extracted.pages[0];
  assert.equal(page.ruledColumns, true);
  assert.equal(page.columns.length, 3);
  assert.deepEqual(
    page.columns.map((column) => [Number(column.x0.toFixed(1)), Number(column.x1.toFixed(1))]),
    [
      [33.8, 215.3],
      [215.3, 396.7],
      [396.7, 578.2],
    ],
  );

  const columnText = (index) => page.columns[index].lines.map((line) => line.text);
  // Lake is the county this reader exists for: it publishes no accessible
  // ballot at all, so these assertions are the only check on its content.
  assert.deepEqual(columnText(0).filter((line) => line.startsWith("For ")), [
    "For Governor and",
    "For Attorney General",
    "For Auditor of State",
    "For Secretary of State",
    "For Treasurer of State",
  ]);
  assert.ok(columnText(0).includes("Amy Acton and"), "the Governor contest's first candidate");
  assert.ok(columnText(0).includes("David Pepper"));
  assert.ok(columnText(0).includes("Write-in"));

  // Both Supreme Court seats, in the column that carries them, with the term
  // language that tells them apart.
  const second = columnText(1);
  assert.equal(second.filter((line) => line === "For Justice of the Supreme Court").length, 2);
  assert.ok(second.includes("(Full term commencing 1-1-2027)"));
  assert.ok(second.includes("(Full term commencing 1-2-2027)"));
  for (const candidate of ["Daniel R. Hawkins", "Marilyn Zayas", "Jennifer Brunner", "Colleen O'Donnell"]) {
    assert.ok(second.includes(candidate), `${candidate} is on the ballot`);
  }
  assert.ok(columnText(2).includes("Jeffrey H. Black"));
});

test("the Lake ballot's diagonal watermark stays out of its contests", () => {
  const page = extractPdfText(fixture("lake-121A__1.pdf")).pages[0];
  // Nine rotated runs spell "Sample" across the page. Grouping them by
  // baseline alone threads each letter into a nearby line, which produced
  // "Geeneral", "Republicpan" and "Ceommon" - words with one letter inserted.
  assert.ok(page.rotated.length > 0, "the watermark is reported, not dropped");
  assert.ok(page.rotated.join(" ").replace(/\s+/g, "").includes("Sa"), "and it is the watermark");
  const everything = [...page.banners, ...page.columns.flatMap((column) => column.lines)]
    .map((line) => line.text)
    .join("\n");
  for (const corruption of ["Geeneral", "Republicpan", "Ceommon", "lelft", "vomtes", "mMarilyn"]) {
    assert.ok(!everything.includes(corruption), `${corruption} is the watermark leaking into body text`);
  }
  assert.match(everything, /Lake County/);
  assert.match(everything, /Republican/);
});

test("the Lake ballot's full-width instructions survive the column cut", () => {
  const page = extractPdfText(fixture("lake-121A__1.pdf")).pages[0];
  const banners = page.banners.map((line) => line.text);
  // This line crosses both column boundaries with ordinary word gaps near
  // them, so a rule that cuts at any gap splits it into "...return your ballot
  // to an elec" and "tion official".
  assert.ok(
    banners.some(
      (line) =>
        line.includes("If you make a mistake or want to change your vote") &&
        line.includes("return your ballot to an election official and get a new ballot."),
    ),
    "the full instruction line is one line",
  );
  assert.ok(banners.some((line) => line.includes("OFFICIAL") && line.includes("GENERAL ELECTION BALLOT")));
});

test("the Licking ballot reads under the other generator's scaling", () => {
  // Licking's PDF puts the type scale in `Tm` and names a 1pt font, where
  // Lake's names a 10pt font under a unit matrix. A glyph width scaled by the
  // font size alone is 20x too small here, every gap then clears the
  // word-break threshold, and the ballot extracts as "F o r A t t o r n e y".
  const extracted = extractPdfText(fixture("licking-0101__1.pdf"));
  assert.match(extracted.text, /For Attorney General/);
  assert.match(extracted.text, /Keith Faber/);
  assert.match(extracted.text, /John J\. Kulewicz/);
  assert.ok(!/\bF o r\b/.test(extracted.text), "no per-character spacing");
});

test("a ballot with no text layer yields no text instead of failing", () => {
  // Some boards publish the ballot as a scanned image. Adams is one: its PDF
  // carries a Times-Roman font for the footer and nothing else. A reader that
  // threw here would be indistinguishable from one that could not parse the
  // file, and the two call for different work.
  const bytes = buildPdf({
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    4: streamObject("", "q 612 0 0 792 0 0 cm /Im1 Do Q"),
    5: streamObject("/Type /XObject /Subtype /Image /Width 1 /Height 1", " "),
  });
  const extracted = extractPdfText(bytes);
  assert.equal(extracted.text.trim(), "");
  assert.equal(extracted.pages[0].glyphs, 0);
});
