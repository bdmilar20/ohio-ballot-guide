import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const markup = await readFile(new URL("../index.html", import.meta.url), "utf8");

// Hosts that resolve only inside the project's own workspace. The published
// page shipped a Buzz relay clone URL for days: it worked in review, where the
// relay is reachable, and would have been a dead link for every voter. These
// are the review-surface shapes, not an attempt to enumerate every private
// host — a public-looking domain that happens to be unreachable still gets
// caught by `npm run check:links`, which probes the URLs data/ cites.
const NON_PUBLIC_HOST = [
  /(^|\.)communities\.buzz\.xyz$/,
  /(^|\.)localhost$/,
  /(^|\.)local$/,
  /^\d{1,3}(\.\d{1,3}){3}$/,
  /^\[/,
];

function absoluteHrefs(html) {
  const hrefs = [];
  for (const [, value] of html.matchAll(/href="([^"]*)"/g)) {
    // Fragments and `./`-relative paths are resolved against whatever origin
    // serves the page, so they are correct on Pages and in review alike.
    if (value.startsWith("#") || value.startsWith("./") || value.startsWith("../")) continue;
    hrefs.push(value);
  }
  return hrefs;
}

test("index.html cites no absolute href that only works in review", () => {
  const hrefs = absoluteHrefs(markup);
  assert.ok(hrefs.length > 0, "found no absolute hrefs at all — the extractor is broken");

  for (const href of hrefs) {
    const url = new URL(href);
    assert.equal(
      url.protocol,
      "https:",
      `${href} is not https, so a voter on the published site may be downgraded`,
    );
    for (const pattern of NON_PUBLIC_HOST) {
      assert.ok(
        !pattern.test(url.hostname),
        `${href} points at ${url.hostname}, which is not reachable from the public site`,
      );
    }
  }
});

// The canonical public mirror. Pinned rather than matched as "some GitHub
// repository": a shape-only pattern accepts `github.com/example/other-project`
// just as happily, so it would pass while the About section pointed voters at
// somebody else's code.
const SOURCE_URL = "https://github.com/bdmilar20/ohio-ballot-guide";

test("the published page links its own source", () => {
  assert.ok(
    absoluteHrefs(markup).includes(SOURCE_URL),
    `index.html does not link ${SOURCE_URL}, so the published page does not point at its own source`,
  );
});
