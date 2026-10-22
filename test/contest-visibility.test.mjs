import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The statewide list collapsed after three cards. On the 2026 general ballot
// that put Secretary of State, Auditor, Treasurer and BOTH Ohio Supreme Court
// seats behind a "Show all contests" button — the judicial races, which voters
// know least about and which sit last on the printed ballot too. A voter who
// searched their ZIP saw three contests and reasonably concluded the guide had
// nothing else. These tests keep any of the three mechanisms from coming back.

const here = (file) => new URL(`../${file}`, import.meta.url);
const markup = await readFile(here("index.html"), "utf8");
const app = await readFile(here("app.js"), "utf8");
const css = (await readFile(here("styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBlocks(source) {
  const blocks = [];
  for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    blocks.push({ selector: selector.trim().replace(/\s+/g, " "), body });
  }
  return blocks;
}

test("no stylesheet rule hides a contest card", () => {
  const hiding = ruleBlocks(css).filter(
    ({ selector, body }) =>
      /\.race-card|\.race-list/.test(selector) &&
      /(display\s*:\s*none|visibility\s*:\s*hidden)/.test(body),
  );
  assert.deepEqual(
    hiding.map(({ selector }) => selector),
    [],
    "a contest card must never be display:none — that is how the Supreme Court seats disappeared",
  );
});

// Scoped to the statewide section on purpose: a disclosure elsewhere on the
// page is nobody's business here, but one wrapping the contest list means a
// contest starts hidden again.
function statewideSectionMarkup(html) {
  const open = html.indexOf('<section id="statewide-section">');
  assert.notEqual(open, -1, "index.html still has the statewide contests section");
  const close = html.indexOf("</section>", open);
  assert.notEqual(close, -1, "the statewide section is closed");
  return html.slice(open, close);
}

test("the contest list ships no control that collapses it", () => {
  const section = statewideSectionMarkup(markup);
  assert.equal(
    /aria-expanded|toggle-races/.test(section),
    false,
    "an expand/collapse control over the contest list means some contest starts hidden",
  );
});

test("rendering a contest never marks it secondary", () => {
  assert.equal(
    /dataset\.secondary|data-secondary/.test(app),
    false,
    "app.js tagged cards past a cutoff as secondary for the stylesheet to hide",
  );
});

test("the statewide list renders every published contest, with no cutoff argument", () => {
  const call = /renderRaces\(statewideContainer,\s*([^)]*)\)/.exec(app);
  assert.ok(call, "app.js renders the statewide contests through renderRaces");
  assert.equal(
    call[1].trim(),
    "activeElection.statewide_races",
    "a second argument here is a collapse cutoff",
  );
});
