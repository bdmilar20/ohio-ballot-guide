import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

// docs/DESIGN.md: nothing renders below 12px. The National Design Studio's
// smallest routine step is --text-micro: .75rem, and this guide is read mostly
// on phones by voters who should not have to squint at a verification date.
const MINIMUM_PX = 12;
const ROOT_PX = 16;

const LENGTH = /^(\d+(?:\.\d+)?)(rem|px)$/;

// Absolute lengths only. `em` is relative to the inherited size and `%`, `vw`
// and `var()` cannot be resolved without a browser, so none of them get a
// number here — they get rejected by the caller instead.
function resolveLength(token) {
  const match = LENGTH.exec(token);
  if (!match) return null;
  const [, value, unit] = match;
  return unit === "px" ? Number(value) : Number(value) * ROOT_PX;
}

// The smallest size a declaration can render at, or the reason it cannot be
// evaluated here. An unsupported value is reported rather than skipped: the
// earlier version of this test matched only the two shapes the stylesheet
// happened to use, so `font-size: clamp(8px, 2vw, 1rem)` passed both checks
// by matching neither.
function smallestRenderedPx(value) {
  const clamp = /^clamp\(([^)]*)\)$/.exec(value);
  if (clamp) {
    const args = clamp[1].split(",").map((arg) => arg.trim());
    if (args.length !== 3) {
      return { reason: "clamp() needs exactly three arguments" };
    }
    // clamp(MIN, VAL, MAX) resolves to max(MIN, min(VAL, MAX)), which is never
    // below MIN whatever the viewport does. So MIN alone sets the floor — but
    // it has to be a length we can actually read.
    const min = resolveLength(args[0]);
    if (min === null) {
      return { reason: `clamp() floor "${args[0]}" is not a rem or px length` };
    }
    return { px: min };
  }

  if (/^\d+(?:\.\d+)?em$/.test(value)) {
    return {
      reason: "em is relative to the inherited size, not the root — use rem so the floor is checkable",
    };
  }

  const simple = resolveLength(value);
  if (simple === null) {
    return {
      reason: "not a rem/px length or a clamp() with a rem/px floor, so no floor can be proven without a browser",
    };
  }
  return { px: simple };
}

// Every `font-size:` in the file, by construction: the value runs to the next
// `;` or `}`. Nothing is filtered out before evaluation.
const declarations = [...css.matchAll(/font-size\s*:\s*([^;}]*)/g)].map((match) => ({
  value: match[1].trim().replace(/\s*!important$/, ""),
}));

test("every font-size declaration in the stylesheet is scanned", () => {
  const occurrences = [...css.matchAll(/font-size\s*:/g)].length;
  assert.ok(occurrences > 0, "expected font-size declarations to scan");
  assert.equal(
    declarations.length,
    occurrences,
    "the scan dropped a font-size declaration instead of evaluating it",
  );
});

test("the font shorthand does not set a size behind the scan's back", () => {
  // `font:` can carry a size this parser does not read. `inherit` cannot.
  const shorthands = [...css.matchAll(/(?<![-\w])font\s*:\s*([^;}]*)/g)]
    .map((match) => match[1].trim())
    .filter((value) => value !== "inherit");

  assert.deepEqual(
    shorthands,
    [],
    "declare font-size on its own so the 12px floor is checked",
  );
});

test("every font-size value is in a form this test can evaluate", () => {
  const unsupported = declarations
    .map((declaration) => ({ ...declaration, ...smallestRenderedPx(declaration.value) }))
    .filter((declaration) => declaration.reason !== undefined)
    .map((declaration) => `font-size: ${declaration.value} — ${declaration.reason}`);

  assert.deepEqual(unsupported, [], "use a form the floor can be checked in, or teach this test to read it");
});

test("no font-size renders below the 12px floor", () => {
  const tooSmall = declarations
    .map((declaration) => ({ ...declaration, ...smallestRenderedPx(declaration.value) }))
    .filter((declaration) => declaration.px !== undefined && declaration.px < MINIMUM_PX)
    .map((declaration) => `font-size: ${declaration.value} renders at ${declaration.px}px`);

  assert.deepEqual(
    tooSmall,
    [],
    "raise the size to 0.75rem, or recede with weight or color instead",
  );
});
