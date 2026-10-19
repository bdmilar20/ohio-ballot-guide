import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyDigest,
  issueBodyText,
  resolveStatewideIssues,
  summarizeIssues,
} from "../scripts/build-statewide-issues.mjs";

// These fixtures exercise the resolver's refusals and its counting, not the
// cross-county claim. Whether seventy counties actually agree is a question
// about the population, answered by the generated artifact's own
// body_present_in field, and no hand-written fixture could stand in for it.
const issue = (title, { subtitles = [], body = [] } = {}) => ({
  order: 1,
  kind: "issue",
  title,
  subtitles,
  instructions: [],
  vote_for: null,
  issue_text_lines: body,
  choices: [
    { name: "YES", party: null, write_in: false, raw_lines: ["YES"] },
    { name: "NO", party: null, write_in: false, raw_lines: ["NO"] },
  ],
  allows_write_in: false,
  source_url: "https://example.gov/ballot",
  raw: { heading_lines: [title, ...subtitles], choice_lines: [["YES"], ["NO"]] },
  uncertain: [],
});

const election = { id: "2026-11-03-general", statewide_races: [], issues: [{ id: "state-issue-3", label: "State Issue 3" }] };
const CERTIFIED = ["This proposed amendment would:", "Require photo identification."];

test("keys a statewide issue on its body, not on the heading the county chose", () => {
  // lorain and tuscarawas fold "Proposed Constitutional Amendment" into the
  // title where other counties keep it as a subtitle. Measured over all 70
  // enumerable counties, heading-plus-body agrees in 68 and the body alone
  // agrees in 70, so the heading cannot be part of the key.
  const asSubtitle = issue("Issue 3", { subtitles: ["Proposed Constitutional Amendment"], body: CERTIFIED });
  const inTitle = issue("3 Proposed Constitutional Amendment", { body: CERTIFIED });
  assert.equal(issueBodyText(asSubtitle), issueBodyText(inTitle));
  assert.notDeepEqual(asSubtitle.raw.heading_lines, inTitle.raw.heading_lines);
});

test("learns the text from counties whose title it reads, then counts every county carrying it", () => {
  // The whole purpose of the artifact: the title rule reaches 68 counties and
  // the text it learns reaches 70. A resolver that only counted the counties it
  // recognized would report the gap as zero and the backstop as pointless.
  const resolved = resolveStatewideIssues({
    election,
    countyIssues: {
      adams: [issue("Issue 3", { subtitles: ["Proposed Constitutional Amendment"], body: CERTIFIED })],
      highland: [issue("State Issue 3", { body: CERTIFIED })],
      lorain: [
        issue("3 Proposed Constitutional Amendment", { body: CERTIFIED }),
        issue("1 PROPOSED TAX LEVY (ADDITIONAL)", { body: ["A levy for the county."] }),
      ],
    },
  });

  const record = resolved["state-issue-3"];
  assert.equal(record.identified_by_title_in, 2, "lorain's title names no published issue");
  assert.equal(record.body_present_in, 3, "lorain carries the certified text even so");
  assert.deepEqual(record.counties, ["adams", "highland", "lorain"]);
  assert.equal(record.body_text, CERTIFIED.join("\n"));
  assert.equal(record.body_sha256, bodyDigest(CERTIFIED.join("\n")));
});

test("refuses to emit an issue whose counties disagree about its text", () => {
  // Averaging a disagreement away would publish one county's wording as the
  // certified text for the state.
  assert.throws(
    () => resolveStatewideIssues({
      election,
      countyIssues: {
        adams: [issue("Issue 3", { body: CERTIFIED })],
        allen: [issue("Issue 3", { body: ["This proposed amendment would:", "Require something else."] })],
      },
    }),
    /counties disagree about the ballot text of state-issue-3/,
  );
});

test("refuses to guess the text when no county's title names the issue", () => {
  // Nothing anchors the body to the published issue, so there is nothing to
  // learn. Picking the most widespread issue text would be a guess.
  assert.throws(
    () => resolveStatewideIssues({
      election,
      countyIssues: { lorain: [issue("3 Proposed Constitutional Amendment", { body: CERTIFIED })] },
    }),
    /no county's contest title named published issue state-issue-3/,
  );
});

test("refuses an issue that resolved to empty ballot text", () => {
  // A contest the parser read as an issue with no body would otherwise become
  // an artifact entry that matches every other empty-bodied contest.
  assert.throws(
    () => resolveStatewideIssues({
      election,
      countyIssues: { adams: [issue("Issue 3", { subtitles: ["Proposed Constitutional Amendment"], body: [] })] },
    }),
    /resolved to empty ballot text/,
  );
});

test("summarizes the weakest issue, not the average", () => {
  // Two issues where one is well covered and one is not must report the one
  // that is not: an average would hide it.
  const resolved = {
    a: { identified_by_title_in: 70, body_present_in: 70 },
    b: { identified_by_title_in: 12, body_present_in: 40 },
  };
  assert.deepEqual(summarizeIssues(resolved, { countiesRead: 70, failures: 2 }), {
    counties_read: 70,
    counties_failed: 2,
    issues_published: 2,
    identified_by_title_in: 12,
    body_present_in: 40,
  });
});
