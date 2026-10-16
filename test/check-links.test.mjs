import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectCitations, controlFor } from "../scripts/check-links.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readData = async (name) => JSON.parse(await readFile(join(projectRoot, "data", name), "utf8"));

test("builds a control that cannot be the real document", () => {
  assert.equal(
    controlFor("https://www.ohiosos.gov/assets/election-calendar-2027.pdf"),
    "https://www.ohiosos.gov/assets/election-calendar-2027-ohio-ballot-guide-control-404.pdf",
  );
  assert.equal(
    controlFor("https://www.boe.ohio.gov/adams/"),
    "https://www.boe.ohio.gov/adams/ohio-ballot-guide-control-404/",
  );
  assert.equal(
    controlFor("https://www.ohiosos.gov/elections/voting-schedule-text-only"),
    "https://www.ohiosos.gov/elections/voting-schedule-text-only-ohio-ballot-guide-control-404",
  );
});

// A statute path ends in a dot segment that belongs to the section number, not
// to a file extension.
test("leaves a statute number intact", () => {
  assert.equal(
    controlFor("https://codes.ohio.gov/ohio-revised-code/section-3501.04"),
    "https://codes.ohio.gov/ohio-revised-code/section-3501.04-ohio-ballot-guide-control-404",
  );
});

// Franklin County serves its candidate list from /getmedia/<guid>/<filename>
// and keys on the GUID alone, so a changed filename returns the identical PDF.
test("changes the GUID when a path has one", () => {
  const control = controlFor(
    "https://vote.franklincountyohio.gov/getmedia/e0a4ca45-6893-45c1-8190-87696f8804b4/2026-General-Candidate-List-5",
  );

  assert.equal(
    control,
    "https://vote.franklincountyohio.gov/getmedia/e0a4ca45-6893-45c1-8190-87696f8804b0/2026-General-Candidate-List-5",
  );
  assert.ok(control.endsWith("2026-General-Candidate-List-5"), "keeps the filename it ignores");
});

test("collects every cited URL in the published data", async () => {
  const citations = collectCitations(
    await readData("elections.json"),
    await readData("offices.json"),
    await readData("county-boards.json"),
  );

  for (const url of citations.keys()) {
    assert.equal(new URL(url).protocol, "https:", `${url} must be HTTPS`);
  }

  const labels = [...citations.values()].flat();
  assert.ok(labels.includes("county-boards.summit"), "includes county board homepages");
  assert.ok(
    labels.some((label) => label.endsWith(".coverage.source_url")),
    "includes county coverage sources",
  );
  assert.ok(
    labels.some((label) => label.includes(" — ")),
    "includes labelled supplemental and office-description sources",
  );

  // Every county board is cited, so the audit cannot silently skip counties.
  const boards = await readData("county-boards.json");
  assert.equal(
    labels.filter((label) => label.startsWith("county-boards.")).length,
    Object.keys(boards.counties).length + 1,
    "cites all 88 boards and the Secretary of State's directory",
  );
});
