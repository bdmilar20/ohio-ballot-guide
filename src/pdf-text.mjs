/**
 * Text extraction for the ballot PDFs two Ohio county boards publish.
 *
 * Lake and Wayne are served by the shared state vendor application, offer the
 * election, and list their precincts — 170 and 121 splits — with only the PDF
 * link in every row. Requesting `xmlview.aspx` for a real Lake precinct returns
 * the same error page as a bogus precinct id, byte for byte, so the accessible
 * HTML rendering the adapter treats as authoritative does not exist for them.
 * The PDF is the only route to those 291 ballots.
 *
 * There is no dependency here because the project has none and `npm run check`
 * has no install step. `node:zlib` is core, and the ballots are the narrow case
 * that makes a hand-written reader defensible: every one of them is produced by
 * the same generator (`%ABCpdf 11310`), unencrypted, PDF 1.4, with no object
 * streams and no cross-reference streams.
 *
 * Three properties of that generator shape this file, and each one breaks the
 * obvious implementation:
 *
 * - **The text is not bytes of text.** Its three Arial faces are Type0 /
 *   CIDFontType2 with `Identity-H` encoding, so a show operator carries
 *   two-byte glyph ids: `<0004> Tj` is `E` only after its `/ToUnicode` CMap is
 *   read. Reading the show operands as characters yields control bytes, and it
 *   yields them silently.
 * - **There are no strings and no spaces.** The generator emits one glyph per
 *   `Tj`, each preceded by its own absolute `Tm`. A ballot is a cloud of
 *   positioned single characters, so both words and lines have to be
 *   reconstructed from coordinates. Concatenating the show operands in stream
 *   order produces `EastLakeCity1A`.
 * - **Stream order is not reading order.** Glyphs arrive per table cell, so
 *   lines must be grouped by position and sorted, never taken in the order the
 *   content stream happens to lay them down.
 *
 * What this module returns is positioned lines. It makes no attempt to be a
 * general PDF reader: anything it does not recognise throws, because the
 * failure this code exists to avoid is returning plausible-looking garbage.
 */

import { inflateSync, inflateRawSync, unzipSync } from "node:zlib";

/** WinAnsiEncoding agrees with Latin-1 outside 0x80–0x9F. */
const WIN_ANSI_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

export class PdfFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "PdfFormatError";
  }
}

const isWhitespace = (code) =>
  code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
const isDelimiter = (char) => "()<>[]{}/%".includes(char);

/**
 * Lexes one PDF object out of `text` starting at `at`.
 *
 * Returns the value and the offset just past it. Indirect references become
 * `{ ref: n }`, which is the only way a consumer can tell `3 0 R` from the
 * number 3 — and the page tree is made of them.
 */
export function readObject(text, at) {
  let index = at;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isWhitespace(code)) {
      index += 1;
    } else if (text[index] === "%") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end + 1;
    } else {
      break;
    }
  }
  if (index >= text.length) throw new PdfFormatError(`ran out of input looking for an object at ${at}`);

  const char = text[index];
  if (text.startsWith("<<", index)) {
    const dict = {};
    index += 2;
    for (;;) {
      const next = skipSpace(text, index);
      if (text.startsWith(">>", next)) return { value: dict, end: next + 2 };
      const key = readObject(text, next);
      if (typeof key.value !== "object" || key.value === null || !("name" in key.value)) {
        throw new PdfFormatError(`a dictionary key at ${next} is not a name`);
      }
      const entry = readObject(text, key.end);
      dict[key.value.name] = entry.value;
      index = entry.end;
    }
  }
  if (char === "[") {
    const array = [];
    index += 1;
    for (;;) {
      const next = skipSpace(text, index);
      if (text[next] === "]") return { value: array, end: next + 1 };
      const entry = readObject(text, next);
      array.push(entry.value);
      index = entry.end;
    }
  }
  if (char === "/") {
    let end = index + 1;
    while (end < text.length && !isWhitespace(text.charCodeAt(end)) && !isDelimiter(text[end])) end += 1;
    const name = text.slice(index + 1, end).replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return { value: { name }, end };
  }
  if (char === "(") return readLiteralString(text, index);
  if (char === "<") return readHexString(text, index);
  if (char === "+" || char === "-" || char === "." || (char >= "0" && char <= "9")) {
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(index, index + 64));
    if (!match) throw new PdfFormatError(`a number at ${index} could not be read`);
    const end = index + match[0].length;
    // `12 0 R` is a reference and `12 0` is two numbers. Only the full
    // three-token shape may be collapsed, and only for an integer.
    const reference = /^(\s+)(\d+)(\s+)R(?![A-Za-z0-9])/.exec(text.slice(end, end + 32));
    if (reference && /^\d+$/.test(match[0])) {
      return { value: { ref: Number(match[0]), generation: Number(reference[2]) }, end: end + reference[0].length };
    }
    return { value: Number(match[0]), end };
  }
  const word = /^[A-Za-z*'"]+/.exec(text.slice(index, index + 32))?.[0];
  if (word === "true") return { value: true, end: index + 4 };
  if (word === "false") return { value: false, end: index + 5 };
  if (word === "null") return { value: null, end: index + 4 };
  if (word) return { value: { operator: word }, end: index + word.length };
  throw new PdfFormatError(`unrecognised syntax at ${index}: ${JSON.stringify(text.slice(index, index + 24))}`);
}

function skipSpace(text, at) {
  let index = at;
  for (;;) {
    while (index < text.length && isWhitespace(text.charCodeAt(index))) index += 1;
    if (text[index] !== "%") return index;
    const end = text.indexOf("\n", index);
    index = end === -1 ? text.length : end + 1;
  }
}

function readLiteralString(text, at) {
  let index = at + 1;
  let depth = 1;
  const bytes = [];
  const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (next in escapes) {
        bytes.push(escapes[next]);
        index += 2;
      } else if (next >= "0" && next <= "7") {
        const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1, index + 4))[0];
        bytes.push(parseInt(octal, 8) & 0xff);
        index += 1 + octal.length;
      } else if (next === "\n" || next === "\r") {
        index += text.startsWith("\r\n", index + 1) ? 3 : 2;
      } else {
        bytes.push(next.charCodeAt(0));
        index += 2;
      }
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { value: { bytes: Uint8Array.from(bytes) }, end: index + 1 };
    }
    bytes.push(char.charCodeAt(0) & 0xff);
    index += 1;
  }
  throw new PdfFormatError(`an unterminated literal string starts at ${at}`);
}

function readHexString(text, at) {
  const close = text.indexOf(">", at);
  if (close === -1) throw new PdfFormatError(`an unterminated hex string starts at ${at}`);
  const digits = text.slice(at + 1, close).replace(/[^0-9A-Fa-f]/g, "");
  const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return { value: { bytes }, end: close + 1 };
}

/**
 * Indexes every `N G obj` in the file and resolves references against it.
 *
 * This reads the body rather than the cross-reference table on purpose. A
 * damaged or rebuilt xref is the single most common way a real-world PDF is
 * malformed, and the information in it is recoverable from the objects
 * themselves. A later definition of the same object number wins, which is what
 * an incremental update means.
 */
export function openPdf(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = buffer.toString("latin1");
  if (!text.startsWith("%PDF-")) throw new PdfFormatError("the file does not begin with %PDF-");
  const offsets = new Map();
  for (const match of text.matchAll(/(?:^|[\r\n\t\f ])(\d+)[\t\f ]+(\d+)[\t\f\r\n ]+obj\b/g)) {
    offsets.set(Number(match[1]), match.index + match[0].indexOf(match[1]) + String(match[1]).length);
  }
  if (offsets.size === 0) throw new PdfFormatError("the file declares no objects");

  const cache = new Map();
  const pdf = {
    buffer,
    text,
    objectNumbers: () => [...offsets.keys()],
    get(number) {
      if (cache.has(number)) return cache.get(number);
      const at = offsets.get(number);
      if (at === undefined) throw new PdfFormatError(`object ${number} is referenced but never defined`);
      // Skip the generation number and the `obj` keyword the index pointed at.
      const header = /^\s*\d+\s+obj\b/.exec(text.slice(at, at + 32));
      if (!header) throw new PdfFormatError(`object ${number} has a malformed header`);
      const { value, end } = readObject(text, at + header[0].length);
      const entry = { value, bodyEnd: end };
      cache.set(number, entry);
      return entry;
    },
    resolve(value) {
      let current = value;
      const seen = new Set();
      while (current !== null && typeof current === "object" && "ref" in current) {
        if (seen.has(current.ref)) throw new PdfFormatError(`reference cycle at object ${current.ref}`);
        seen.add(current.ref);
        current = pdf.get(current.ref).value;
      }
      return current;
    },
    /** Decoded bytes of object `number`'s stream, or null if it has none. */
    stream(number) {
      const { value, bodyEnd } = pdf.get(number);
      const keyword = /^\s*stream(\r\n|\n|\r)/.exec(text.slice(bodyEnd, bodyEnd + 16));
      if (!keyword) return null;
      const start = bodyEnd + keyword[0].length;
      const declared = pdf.resolve(value.Length);
      let end = typeof declared === "number" ? start + declared : -1;
      // A wrong /Length is recoverable and a wrong guess is not, so the
      // declared length is checked against the stream's own terminator before
      // it is trusted.
      const terminator = text.indexOf("endstream", start);
      if (end < 0 || end > terminator + 2 || terminator < 0) {
        if (terminator < 0) throw new PdfFormatError(`object ${number}'s stream has no endstream`);
        end = terminator;
        while (end > start && isWhitespace(text.charCodeAt(end - 1))) end -= 1;
      }
      const raw = buffer.subarray(start, end);
      const filters = [pdf.resolve(value.Filter)].flat().filter(Boolean).map((filter) => pdf.resolve(filter).name);
      let data = raw;
      for (const filter of filters) {
        if (filter === "FlateDecode") data = inflateAny(data, number);
        else throw new PdfFormatError(`object ${number}'s stream uses the unsupported filter /${filter}`);
      }
      return data;
    },
  };
  if (pdf.text.includes("/Encrypt")) {
    // An encrypted ballot is not a parse problem to work around; say so.
    const trailerEncrypted = /trailer[\s\S]{0,2000}?\/Encrypt/.test(text) || /\/Type\s*\/XRef[\s\S]{0,2000}?\/Encrypt/.test(text);
    if (trailerEncrypted) throw new PdfFormatError("the document is encrypted");
  }
  return pdf;
}

function inflateAny(data, number) {
  for (const attempt of [inflateSync, unzipSync, inflateRawSync]) {
    try {
      return attempt(data);
    } catch {
      /* try the next framing */
    }
  }
  throw new PdfFormatError(`object ${number}'s FlateDecode stream could not be inflated`);
}

/** Parses the `bfchar` and `bfrange` sections of a /ToUnicode CMap. */
export function parseToUnicode(source) {
  const text = Buffer.isBuffer(source) ? source.toString("latin1") : String(source);
  const map = new Map();
  const hex = (value) => {
    const points = [];
    for (let i = 0; i + 3 < value.length + 1 && i + 4 <= value.length; i += 4) {
      points.push(parseInt(value.slice(i, i + 4), 16));
    }
    return points;
  };
  const toText = (value) => {
    const digits = value.replace(/\s+/g, "");
    if (digits.length <= 4) return String.fromCodePoint(parseInt(digits.padStart(4, "0"), 16));
    return String.fromCharCode(...hex(digits));
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      map.set(parseInt(pair[1].replace(/\s+/g, ""), 16), pair[2].trim() === "" ? "" : toText(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    // `<lo> <hi> [<a> <b> …]` enumerates one destination per code; the array
    // form and the scalar form mean different things and both occur.
    for (const entry of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(\[([\s\S]*?)\]|<([0-9A-Fa-f\s]*)>)/g)) {
      const low = parseInt(entry[1].replace(/\s+/g, ""), 16);
      const high = parseInt(entry[2].replace(/\s+/g, ""), 16);
      if (entry[4] !== undefined) {
        const destinations = [...entry[4].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((m) => m[1]);
        for (let code = low; code <= high && code - low < destinations.length; code += 1) {
          const destination = destinations[code - low];
          map.set(code, destination.trim() === "" ? "" : toText(destination));
        }
        continue;
      }
      const start = entry[5].replace(/\s+/g, "");
      const base = parseInt(start, 16);
      for (let code = low; code <= high; code += 1) {
        // Only the last 16-bit unit increments, per the CMap specification.
        if (start.length > 4) {
          const units = hex(start.padStart(Math.ceil(start.length / 4) * 4, "0"));
          units[units.length - 1] += code - low;
          map.set(code, String.fromCharCode(...units));
        } else {
          map.set(code, String.fromCodePoint(base + (code - low)));
        }
      }
    }
  }
  return map;
}

/** Parses a CIDFont `/W` array into a code→width map (glyph units / 1000). */
export function parseCidWidths(array) {
  const widths = new Map();
  for (let i = 0; i < array.length; ) {
    const first = array[i];
    const second = array[i + 1];
    if (Array.isArray(second)) {
      second.forEach((width, offset) => widths.set(first + offset, width));
      i += 2;
      continue;
    }
    const width = array[i + 2];
    if (typeof second !== "number" || typeof width !== "number") break;
    for (let code = first; code <= second; code += 1) widths.set(code, width);
    i += 3;
  }
  return widths;
}

function loadFont(pdf, reference) {
  const dict = pdf.resolve(reference);
  if (!dict || typeof dict !== "object") throw new PdfFormatError("a font resource does not resolve to a dictionary");
  const subtype = pdf.resolve(dict.Subtype)?.name ?? null;
  const toUnicodeRef = dict.ToUnicode;
  const toUnicode = toUnicodeRef ? parseToUnicode(pdf.stream(toUnicodeRef.ref) ?? Buffer.alloc(0)) : null;
  const baseFont = pdf.resolve(dict.BaseFont)?.name ?? null;

  if (subtype === "Type0") {
    const encoding = pdf.resolve(dict.Encoding)?.name ?? null;
    if (encoding !== "Identity-H") {
      throw new PdfFormatError(`font ${baseFont} uses the unsupported CMap /${encoding ?? "(stream)"}`);
    }
    if (!toUnicode) throw new PdfFormatError(`font ${baseFont} is Identity-H with no /ToUnicode, so its glyph ids are unreadable`);
    const descendant = pdf.resolve(pdf.resolve(dict.DescendantFonts)?.[0]) ?? {};
    const widthArray = pdf.resolve(descendant.W);
    return {
      baseFont,
      bytesPerCode: 2,
      toUnicode,
      widths: Array.isArray(widthArray) ? parseCidWidths(widthArray.map((entry) => pdf.resolve(entry))) : new Map(),
      defaultWidth: pdf.resolve(descendant.DW) ?? 1000,
    };
  }
  if (subtype === "Type1" || subtype === "TrueType" || subtype === "MMType1") {
    const encodingValue = pdf.resolve(dict.Encoding);
    const differences = new Map();
    if (encodingValue && typeof encodingValue === "object" && !("name" in encodingValue)) {
      const list = pdf.resolve(encodingValue.Differences) ?? [];
      let code = 0;
      for (const entry of list.map((item) => pdf.resolve(item))) {
        if (typeof entry === "number") code = entry;
        else if (entry && entry.name) differences.set(code++, entry.name);
      }
    }
    const firstChar = pdf.resolve(dict.FirstChar) ?? 0;
    const widthList = pdf.resolve(dict.Widths) ?? [];
    const widths = new Map();
    widthList.forEach((width, offset) => widths.set(firstChar + offset, pdf.resolve(width)));
    return {
      baseFont,
      bytesPerCode: 1,
      toUnicode,
      simpleDifferences: differences,
      widths,
      // A standard-14 font may carry no /Widths at all. Guessing one glyph's
      // width wrong only misplaces a space, while refusing the font loses the
      // page, so this falls back to a mid-range advance and says so here.
      defaultWidth: widths.size > 0 ? 500 : 500,
    };
  }
  throw new PdfFormatError(`font ${baseFont} has the unsupported subtype /${subtype ?? "(none)"}`);
}

const GLYPH_NAMES = { space: " ", hyphen: "-", period: ".", comma: ",", colon: ":", semicolon: ";", bullet: "•", quotesingle: "'", quotedblleft: "“", quotedblright: "”", endash: "–", emdash: "—" };

function decodeShow(font, bytes) {
  const glyphs = [];
  if (font.bytesPerCode === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      glyphs.push({ code, text: font.toUnicode.get(code) ?? "" });
    }
    return glyphs;
  }
  for (const code of bytes) {
    let text = font.toUnicode?.get(code);
    if (text === undefined) {
      const glyphName = font.simpleDifferences?.get(code);
      if (glyphName) text = GLYPH_NAMES[glyphName] ?? (/^uni([0-9A-Fa-f]{4})$/.test(glyphName) ? String.fromCharCode(parseInt(glyphName.slice(3), 16)) : "");
      else text = String.fromCodePoint(WIN_ANSI_HIGH[code] ?? code);
    }
    glyphs.push({ code, text });
  }
  return glyphs;
}

const multiply = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/**
 * Runs a page's content stream and returns every glyph with its device
 * position and advance.
 */
export function runContentStream(source, { fonts, initialMatrix = [1, 0, 0, 1, 0, 0] }) {
  const text = Buffer.isBuffer(source) ? source.toString("latin1") : String(source);
  const glyphs = [];
  const segments = [];
  const operands = [];
  const graphicsStack = [];
  // Path construction is tracked because the ballot's columns are *drawn*: the
  // generator strokes a vertical rule at each column edge and boxes every
  // contest. That is the producer's own statement of the layout, and it is
  // sturdier than inferring columns from where text happens to fall — a line
  // with content in the first and third columns looks full-width to any
  // whitespace heuristic. Only painted paths count; the clipping rectangles
  // this generator emits before every stroke (`… re W n`) are not layout.
  let pathStart = null;
  let pathPoint = null;
  let pending = [];
  const apply = (point) => ({
    x: point.x * ctm[0] + point.y * ctm[2] + ctm[4],
    y: point.x * ctm[1] + point.y * ctm[3] + ctm[5],
  });
  let ctm = initialMatrix;
  let textMatrix = null;
  let lineMatrix = null;
  let font = null;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let leading = 0;
  let rise = 0;

  const show = (bytes) => {
    if (!font || textMatrix === null) return;
    for (const glyph of decodeShow(font, bytes)) {
      const width = (font.widths.get(glyph.code) ?? font.defaultWidth) / 1000;
      const placement = multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], multiply(textMatrix, ctm));
      const advance = (width * fontSize + charSpacing + (font.bytesPerCode === 1 && glyph.code === 32 ? wordSpacing : 0)) * horizontalScale;
      if (glyph.text !== "") {
        // The baseline direction is kept because this generator stamps a
        // diagonal "Sample" watermark through the ballot with a rotated `cm`.
        // Those glyphs have real device positions, so grouping purely by y
        // threads each one into whichever horizontal line it passes near and
        // yields "Geeneral", "Republicpan", "Ceommon" — plausible words with a
        // letter inserted, which is the worst available failure. Direction is
        // what distinguishes them from body text.
        // Both of these are device units, which is not the same as scaling the
        // glyph's width by the font size: the two generators in use put the
        // scale in different places. Lake's `Tf` names a 10pt font under a unit
        // text matrix; Licking's names a 1pt font and carries the 10× in `Tm`.
        // A width computed as width×fontSize is 0.5 device units on the second
        // one while its glyphs sit 5 units apart, so every gap looks like a
        // word break and the ballot extracts as "f o r a t t o r n e y".
        const scale = Math.hypot(placement[0], placement[1]) || 1;
        glyphs.push({
          text: glyph.text,
          x: placement[4],
          y: placement[5],
          width: width * scale,
          size: Math.hypot(placement[2], placement[3]) || fontSize,
          angle: Math.round((Math.atan2(placement[1] / scale, placement[0] / scale) * 180) / Math.PI),
        });
      }
      textMatrix = multiply([1, 0, 0, 1, advance, 0], textMatrix);
    }
  };

  const paintPath = () => {
    for (const segment of pending) segments.push(segment);
    pending = [];
    pathStart = null;
    pathPoint = null;
  };
  const discardPath = () => {
    pending = [];
    pathStart = null;
    pathPoint = null;
  };

  let at = 0;
  while (at < text.length) {
    const next = skipSpace(text, at);
    if (next >= text.length) break;
    let parsed;
    try {
      parsed = readObject(text, next);
    } catch {
      at = next + 1;
      continue;
    }
    at = parsed.end;
    const value = parsed.value;
    if (value === null || typeof value !== "object" || !("operator" in value)) {
      operands.push(value);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const operator = value.operator;
    const numbers = operands.filter((operand) => typeof operand === "number");
    switch (operator) {
      case "q":
        graphicsStack.push({ ctm, font, fontSize, charSpacing, wordSpacing, horizontalScale, leading, rise });
        break;
      case "Q": {
        const saved = graphicsStack.pop();
        if (saved) ({ ctm, font, fontSize, charSpacing, wordSpacing, horizontalScale, leading, rise } = saved);
        break;
      }
      case "cm":
        if (numbers.length >= 6) ctm = multiply(numbers.slice(-6), ctm);
        break;
      case "BT":
        textMatrix = [1, 0, 0, 1, 0, 0];
        lineMatrix = textMatrix;
        break;
      case "ET":
        textMatrix = null;
        lineMatrix = null;
        break;
      case "Tf": {
        const name = operands.filter((operand) => operand && operand.name).at(-1)?.name;
        fontSize = numbers.at(-1) ?? fontSize;
        if (name !== undefined) {
          if (!(name in fonts)) throw new PdfFormatError(`the content stream selects /${name}, which the page's resources do not define`);
          font = fonts[name];
        }
        break;
      }
      case "Td":
        if (numbers.length >= 2) {
          lineMatrix = multiply([1, 0, 0, 1, numbers.at(-2), numbers.at(-1)], lineMatrix ?? [1, 0, 0, 1, 0, 0]);
          textMatrix = lineMatrix;
        }
        break;
      case "TD":
        if (numbers.length >= 2) {
          leading = -numbers.at(-1);
          lineMatrix = multiply([1, 0, 0, 1, numbers.at(-2), numbers.at(-1)], lineMatrix ?? [1, 0, 0, 1, 0, 0]);
          textMatrix = lineMatrix;
        }
        break;
      case "Tm":
        if (numbers.length >= 6) {
          lineMatrix = numbers.slice(-6);
          textMatrix = lineMatrix;
        }
        break;
      case "T*":
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix ?? [1, 0, 0, 1, 0, 0]);
        textMatrix = lineMatrix;
        break;
      case "TL":
        leading = numbers.at(-1) ?? leading;
        break;
      case "Tc":
        charSpacing = numbers.at(-1) ?? charSpacing;
        break;
      case "Tw":
        wordSpacing = numbers.at(-1) ?? wordSpacing;
        break;
      case "Tz":
        horizontalScale = (numbers.at(-1) ?? 100) / 100;
        break;
      case "Ts":
        rise = numbers.at(-1) ?? rise;
        break;
      case "m":
        if (numbers.length >= 2) {
          pathPoint = { x: numbers.at(-2), y: numbers.at(-1) };
          pathStart = pathPoint;
        }
        break;
      case "l":
        if (numbers.length >= 2 && pathPoint) {
          const to = { x: numbers.at(-2), y: numbers.at(-1) };
          pending.push({ from: apply(pathPoint), to: apply(to) });
          pathPoint = to;
        }
        break;
      case "h":
        if (pathPoint && pathStart) {
          pending.push({ from: apply(pathPoint), to: apply(pathStart) });
          pathPoint = pathStart;
        }
        break;
      case "re":
        if (numbers.length >= 4) {
          const [x, y, w, h] = numbers.slice(-4);
          const corners = [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ].map(apply);
          for (let corner = 0; corner < 4; corner += 1) {
            pending.push({ from: corners[corner], to: corners[(corner + 1) % 4] });
          }
          pathPoint = { x, y };
          pathStart = pathPoint;
        }
        break;
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
        paintPath();
        break;
      case "n":
        discardPath();
        break;
      case "Tj":
        show(operands.at(-1)?.bytes ?? new Uint8Array());
        break;
      case "'":
      case '"':
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix ?? [1, 0, 0, 1, 0, 0]);
        textMatrix = lineMatrix;
        show(operands.at(-1)?.bytes ?? new Uint8Array());
        break;
      case "TJ": {
        const array = operands.at(-1);
        if (Array.isArray(array)) {
          for (const entry of array) {
            if (typeof entry === "number") {
              textMatrix = multiply([1, 0, 0, 1, (-entry / 1000) * fontSize * horizontalScale, 0], textMatrix ?? [1, 0, 0, 1, 0, 0]);
            } else if (entry && entry.bytes) {
              show(entry.bytes);
            }
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return { glyphs, segments };
}

/**
 * Groups positioned glyphs into lines of text.
 *
 * Both thresholds are ratios of the glyph's own font size rather than absolute
 * points, so a ballot's 6pt fine print and its 14pt contest headings are
 * grouped on the same rule. `spaceRatio` is the gap, beyond the previous
 * glyph's own advance, that separates two words. The generator writes no space
 * glyphs between words inside a cell, so without this every line would be one
 * run-together token; set it too low and every kerned pair becomes two words.
 */
export function assembleLines(glyphs, { lineRatio = 0.5, spaceRatio = 0.2 } = {}) {
  if (glyphs.length === 0) return [];
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;
  for (const glyph of sorted) {
    const tolerance = Math.max(glyph.size, 1) * lineRatio;
    if (current === null || Math.abs(current.y - glyph.y) > tolerance) {
      current = { y: glyph.y, glyphs: [] };
      lines.push(current);
    }
    current.glyphs.push(glyph);
  }
  return lines.map((line) => {
    const ordered = line.glyphs.sort((a, b) => a.x - b.x);
    let text = "";
    let previous = null;
    for (const glyph of ordered) {
      if (previous !== null) {
        const gap = glyph.x - (previous.x + previous.width);
        if (gap > Math.max(previous.size, 1) * spaceRatio && !text.endsWith(" ") && glyph.text !== " ") text += " ";
      }
      text += glyph.text;
      previous = glyph;
    }
    return {
      y: line.y,
      x: ordered[0].x,
      text: text.replace(/\s+/g, " ").trim(),
      items: ordered,
      glyphs: ordered.length,
    };
  }).filter((line) => line.text !== "");
}

/** Walks the page tree, inheriting the attributes a page may omit. */
export function pdfPages(pdf) {
  const catalog = pdf.objectNumbers()
    .map((number) => ({ number, value: pdf.get(number).value }))
    .find((entry) => entry.value && typeof entry.value === "object" && pdf.resolve(entry.value.Type)?.name === "Catalog");
  if (!catalog) throw new PdfFormatError("the document has no /Catalog");
  const pages = [];
  const seen = new Set();
  const walk = (reference, inherited) => {
    const node = pdf.resolve(reference);
    if (!node || typeof node !== "object") return;
    const key = typeof reference === "object" && "ref" in reference ? reference.ref : null;
    if (key !== null) {
      if (seen.has(key)) throw new PdfFormatError(`the page tree revisits object ${key}`);
      seen.add(key);
    }
    const attributes = {
      Resources: node.Resources ?? inherited.Resources,
      MediaBox: node.MediaBox ?? inherited.MediaBox,
      Rotate: node.Rotate ?? inherited.Rotate,
    };
    const type = pdf.resolve(node.Type)?.name;
    if (type === "Page") {
      pages.push({ node, ...attributes });
      return;
    }
    for (const kid of pdf.resolve(node.Kids) ?? []) walk(kid, attributes);
  };
  walk(pdf.resolve(catalog.value.Pages) === undefined ? catalog.value.Pages : catalog.value.Pages, {});
  if (pages.length === 0) throw new PdfFormatError("the page tree contains no pages");
  return pages;
}

/**
 * Reads a page's column boundaries off the vertical rules it draws.
 *
 * On these ballots the three columns are strokes, not inference: the generator
 * draws a long vertical rule at each column edge — x = 33.8, 215.3, 396.7 and
 * 578.2 on a Lake ballot — and boxes every contest between two of them. Using
 * that is not a shortcut around layout analysis, it is the layout, and it is
 * the one signal a whitespace heuristic cannot match: a line carrying text in
 * the first and third columns occupies 90% of the page width, so no rule about
 * spans or corridors can tell it from the election title above it.
 *
 * Returns null when the page draws no such rules, so a caller can decide
 * rather than be handed a single column that silently merged three.
 */
export function detectRuledColumns(segments, { minRuleLength = 20, minRuleShare = 0.25, tolerance = 1 } = {}) {
  const vertical = segments.filter(
    (segment) => Math.abs(segment.to.x - segment.from.x) <= 0.5 && Math.abs(segment.to.y - segment.from.y) >= minRuleLength,
  );
  if (vertical.length === 0) return null;
  const clusters = [];
  for (const segment of [...vertical].sort((a, b) => a.from.x - b.from.x)) {
    const length = Math.abs(segment.to.y - segment.from.y);
    const last = clusters.at(-1);
    if (last && Math.abs(last.x - segment.from.x) <= tolerance) {
      last.length += length;
      last.count += 1;
      last.intervals.push([Math.min(segment.from.y, segment.to.y), Math.max(segment.from.y, segment.to.y)]);
    } else {
      clusters.push({
        x: segment.from.x,
        length,
        count: 1,
        intervals: [[Math.min(segment.from.y, segment.to.y), Math.max(segment.from.y, segment.to.y)]],
      });
    }
  }
  // A rule that appears once is a box edge inside a column; a column boundary
  // is ruled the whole way down the page, so the total ruled length is what
  // separates them.
  const longest = Math.max(...clusters.map((cluster) => cluster.length));
  const edges = clusters.filter((cluster) => cluster.length >= longest * minRuleShare);
  // Two edges is one column, and that is a real answer rather than a missing
  // one. Lucas prints its issues one column wide on pages 2 and 3 while its
  // candidate contests are three columns on page 1. Treating one ruled column
  // as "no columns found" dropped the left-margin sequence numerals the ballot
  // prints outside the frame onto the start of every line, which is how
  // "Issue 9 / Proposed Tax Levy (Additional)" became "42 Issue 9 / 43 Proposed
  // Tax Levy (Additional)" and stopped matching the HTML.
  if (edges.length < 2) return null;
  const columns = [];
  for (let i = 0; i < edges.length - 1; i += 1) columns.push({ x0: edges[i].x, x1: edges[i + 1].x });
  // Each interior boundary carries the vertical spans over which it is
  // actually ruled. A column boundary that is not ruled at a given height is
  // not a boundary at that height, and that is the fact that separates the
  // columns from the band above them: the ballot's title and voter
  // instructions run the full page width above the first rule, and their word
  // gaps fall near the column edges often enough that any "cut at a gap" rule
  // shreds every instruction line into three pieces.
  const asEdge = (edge) => ({ x: edge.x, intervals: edge.intervals });
  return Object.assign(columns, {
    interior: edges.slice(1, -1).map(asEdge),
    frame: [asEdge(edges[0]), asEdge(edges.at(-1))],
  });
}

/**
 * True when the boundaries that define these columns are ruled at height `y`.
 *
 * A single ruled column has no interior boundary, so its frame is what has to
 * be ruled; otherwise the interior boundaries are, and the frame is allowed to
 * run the whole page as a border.
 */
export function columnsRuledAt(columns, y, { padding = 2 } = {}) {
  const interior = columns.interior ?? [];
  const deciding = interior.length > 0 ? interior : (columns.frame ?? []);
  if (deciding.length === 0) return false;
  return deciding.every((edge) =>
    edge.intervals.some(([low, high]) => y >= low - padding && y <= high + padding),
  );
}

/**
 * Cuts one baseline's glyphs into the columns they belong to.
 *
 * A crossing into the next column is only a cut when there is a gap at the
 * boundary. Text that runs continuously across a column edge is one line that
 * spans the page — the ballot's title and its voter instructions do — and
 * cutting it there yields "…return your ballot to an elec" in one column and
 * "tion official" in another. A run that ends up spanning more than one column
 * is reported with `column: null`.
 */
export function sliceLineByColumns(line, columns, { spaceRatio = 0.2 } = {}) {
  const columnOf = (glyph) => {
    const centre = glyph.x + glyph.width / 2;
    const index = columns.findIndex((column) => centre >= column.x0 && centre < column.x1);
    return index === -1 ? null : index;
  };
  const runs = [];
  let current = null;
  let previous = null;
  for (const glyph of line.items) {
    const column = columnOf(glyph);
    const gap = previous === null ? Infinity : glyph.x - (previous.x + previous.width);
    const separated = gap > Math.max(previous?.size ?? 1, 1) * spaceRatio;
    if (current === null || (column !== current.column && separated)) {
      current = { column, items: [] };
      runs.push(current);
    } else if (column !== current.column) {
      current.column = null;
    }
    current.items.push(glyph);
    previous = glyph;
  }
  return runs.map((run) => ({ column: run.column, ...assembleLines(run.items, { spaceRatio })[0] }));
}

/**
 * Extracts a document's text as positioned lines, separated into columns.
 *
 * Three fields of each page answer three different questions and they are not
 * interchangeable:
 *
 * - `lines` is every upright glyph grouped by baseline. On a multi-column page
 *   one entry holds one line from each column, so this is the raw view and
 *   **not** what a parser should read.
 * - `columns` is the same lines split at the page's whitespace corridors, which
 *   is the ballot's own reading order: down one column, then the next.
 * - `rotated` is every glyph whose baseline runs at a different angle from the
 *   page's dominant one — on these ballots, the diagonal "Sample" watermark.
 *   It is reported rather than dropped so a caller can tell an unread
 *   watermark from an unread contest.
 */
export function extractPdfText(bytes, options = {}) {
  const pdf = openPdf(bytes);
  const pages = pdfPages(pdf).map((page, index) => {
    const resources = pdf.resolve(page.Resources) ?? {};
    const fontDict = pdf.resolve(resources.Font) ?? {};
    const fonts = {};
    for (const [name, reference] of Object.entries(fontDict)) fonts[name] = loadFont(pdf, reference);
    const contents = pdf.resolve(page.node.Contents);
    const streams = (Array.isArray(contents) ? contents : [page.node.Contents])
      .filter((entry) => entry && typeof entry === "object" && "ref" in entry)
      .map((entry) => pdf.stream(entry.ref))
      .filter((data) => data !== null);
    if (streams.length === 0) throw new PdfFormatError(`page ${index + 1} has no content stream`);
    // The pieces of a /Contents array are one stream split at an arbitrary
    // point, so they are joined with a separator: a token cut in half across
    // two pieces must not fuse with the next piece's first token.
    const { glyphs: all, segments } = runContentStream(
      Buffer.concat(streams.flatMap((data) => [data, Buffer.from("\n")])),
      { fonts },
    );

    const byAngle = new Map();
    for (const glyph of all) byAngle.set(glyph.angle, (byAngle.get(glyph.angle) ?? 0) + 1);
    const dominant = [...byAngle.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const upright = all.filter((glyph) => glyph.angle === dominant);
    const rotated = all.filter((glyph) => glyph.angle !== dominant);

    const baselines = assembleLines(upright, options);
    const ruled = detectRuledColumns(segments, options);
    const columns = (ruled ?? []).map((column) => ({ ...column, lines: [] }));
    const banners = [];
    for (const baseline of baselines) {
      if (ruled === null || !columnsRuledAt(ruled, baseline.y, options)) {
        banners.push(baseline);
        continue;
      }
      for (const run of sliceLineByColumns(baseline, ruled, options)) {
        if (run.column === null || columns[run.column] === undefined) banners.push(run);
        else columns[run.column].lines.push(run);
      }
    }
    for (const column of columns) column.lines.sort((a, b) => b.y - a.y || a.x - b.x);
    banners.sort((a, b) => b.y - a.y || a.x - b.x);
    const mediaBox = (pdf.resolve(page.MediaBox) ?? [0, 0, 612, 792]).map((entry) => pdf.resolve(entry));
    return {
      page: index + 1,
      width: mediaBox[2] - mediaBox[0],
      height: mediaBox[3] - mediaBox[1],
      fonts: Object.fromEntries(Object.entries(fonts).map(([name, loaded]) => [name, loaded.baseFont])),
      baselineAngle: dominant,
      lines: baselines.map((line) => ({ y: line.y, x: line.x, text: line.text })),
      ruledColumns: ruled !== null,
      banners: banners.map((line) => ({ y: line.y, x: line.x, text: line.text })),
      columns: columns.map((column) => ({
        x0: column.x0,
        x1: column.x1,
        lines: column.lines.map((line) => ({ y: line.y, x: line.x, text: line.text })),
      })),
      rotated: assembleLines(rotated, options).map((line) => line.text),
      glyphs: upright.length,
    };
  });
  // Reading order: a page's full-width lines in vertical order, then each
  // column top to bottom. On these ballots the full-width band is the header
  // and the voter instructions, which do precede the columns.
  const text = pages
    .map((page) =>
      [
        ...page.banners.map((line) => line.text),
        ...page.columns.flatMap((column) => column.lines.map((line) => line.text)),
      ].join("\n"),
    )
    .join("\n");
  return { pages, text };
}
