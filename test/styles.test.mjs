import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

// docs/DESIGN.md: nothing renders below 12px. The National Design Studio's
// smallest routine step is --text-micro: .75rem, and this guide is read mostly
// on phones by voters who should not have to squint at a verification date.
const MINIMUM_REM = 0.75;

test("no declared font-size falls below the 12px floor", () => {
  const declarations = [...css.matchAll(/font-size:\s*([\d.]+)(rem|em|px)\s*;/g)];
  assert.ok(declarations.length > 0, "expected font-size declarations to scan");

  const tooSmall = declarations
    .map(([text, value, unit]) => ({ text, px: unit === "px" ? Number(value) : Number(value) * 16 }))
    .filter((d) => d.px < MINIMUM_REM * 16);

  assert.deepEqual(
    tooSmall.map((d) => d.text),
    [],
    "raise the size to 0.75rem, or recede with weight or color instead",
  );
});

test("fluid font sizes clamp to a readable floor", () => {
  const clamps = [...css.matchAll(/font-size:\s*clamp\(\s*([\d.]+)rem/g)];
  assert.ok(clamps.length > 0, "expected clamp() font sizes to scan");

  for (const [text, floor] of clamps) {
    assert.ok(
      Number(floor) >= MINIMUM_REM,
      `${text} clamps below the 12px floor at narrow widths`,
    );
  }
});
