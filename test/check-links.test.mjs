import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { classify, collectCitations, controlFor, findChrome, isRetryableStatus } from "../scripts/check-links.mjs";

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
    await readData("locations.json"),
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

// The audit claims to cover every cited URL. locations.json is generated, but
// the files it is generated from are cited in its meta, and omitting them left
// the build inputs unaudited while this test still passed.
test("collects the generated locations file's own sources", async () => {
  const locations = await readData("locations.json");
  const citations = collectCitations(
    await readData("elections.json"),
    await readData("offices.json"),
    await readData("county-boards.json"),
    locations,
  );

  const cited = new Set(citations.keys());
  assert.ok(locations.meta.sources.length > 0, "locations.json must declare its sources");
  for (const source of locations.meta.sources) {
    assert.ok(cited.has(source.url), `${source.id} (${source.url}) must be audited`);
  }

  const labels = [...citations.values()].flat();
  assert.ok(
    labels.some((label) => label.startsWith("locations — ")),
    "labels the location sources so a failure says where it came from",
  );
});

test("a missing locations argument cannot silently drop the source audit", async () => {
  // Calling it the old way must not throw, but it must also not be mistaken
  // for a complete audit: the three build inputs are simply absent.
  const citations = collectCitations(
    await readData("elections.json"),
    await readData("offices.json"),
    await readData("county-boards.json"),
  );
  const locations = await readData("locations.json");
  for (const source of locations.meta.sources) {
    assert.ok(!citations.has(source.url), "no phantom citations without the file");
  }
});

// 429 and 5xx mean the origin never served the document. An honest 404 on the
// control proves the origin discriminates — it does not make the unread URL
// dead. This is the verdict table, pinned so no live sweep is needed to trust it.
test("never calls a retryable status broken, whatever the control says", () => {
  const base = { failure: null, hasResponse: true, challenged: false, byStatus: true, byMime: false, byPage: false };

  for (const status of [429, 500, 502, 503, 504, 599]) {
    assert.equal(
      classify({ ...base, status }),
      "unverified",
      `${status} with a discriminating control must not be broken`,
    );
  }

  // A real 404 against a control that proves the origin answers honestly is
  // the one case that earns "broken".
  assert.equal(classify({ ...base, status: 404 }), "broken");
  assert.equal(classify({ ...base, status: 410 }), "broken");
  assert.equal(classify({ ...base, status: 200 }), "ok");
});

test("classifies the rest of the verdict table", () => {
  const ok = { failure: null, hasResponse: true, challenged: false, byStatus: true, byMime: false, byPage: false };

  // No response at all is an error, not a judgement about the URL.
  assert.equal(classify({ ...ok, status: null, failure: "timed out", hasResponse: false }), "error");
  // A challenge or maintenance page tells us nothing either way.
  assert.equal(classify({ ...ok, status: 404, challenged: true }), "unverified");
  // No discriminator at all: the control answered exactly like the target.
  assert.equal(
    classify({ ...ok, status: 404, byStatus: false, byMime: false, byPage: false }),
    "unverified",
  );
  // Content type and rendered page are the discriminators left for a PDF and
  // for a single-page app that serves one shell for every path.
  assert.equal(classify({ ...ok, status: 200, byStatus: false, byMime: true }), "ok");
  assert.equal(classify({ ...ok, status: 200, byStatus: false, byPage: true }), "ok");
  // A 3xx that stopped at the redirect is not a 2xx and not retryable.
  assert.equal(classify({ ...ok, status: 302 }), "broken");
});

test("isRetryableStatus covers 429 and the 5xx range only", () => {
  assert.ok(isRetryableStatus(429));
  assert.ok(isRetryableStatus(500));
  assert.ok(isRetryableStatus(599));
  assert.ok(!isRetryableStatus(499));
  assert.ok(!isRetryableStatus(600));
  assert.ok(!isRetryableStatus(404));
  assert.ok(!isRetryableStatus(200));
  assert.ok(!isRetryableStatus(null));
  assert.ok(!isRetryableStatus(undefined));
});

// The candidate list is paths, not installed binaries. Picking the first
// truthy string picked the macOS Chrome path on every Linux box.
test("finds Chrome by executable access, not by list order", async () => {
  assert.equal(await findChrome(["/nonexistent/chrome", "/bin/sh"]), "/bin/sh");
  assert.equal(await findChrome(["/nonexistent/chrome", "/also/not/here"]), null);
  assert.equal(await findChrome([]), null);
  // A directory is not an executable file, even though it exists.
  assert.equal(await findChrome(["/tmp", "/bin/sh"]), "/bin/sh");
});
