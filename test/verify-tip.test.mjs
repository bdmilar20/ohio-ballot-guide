import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatVerdict, verifyTip } from "../scripts/verify-tip.mjs";

// A step with no recorded result is the failure this command exists to prevent,
// so it has to be visible in the verdict rather than absent from it. Printing
// only failures would make a check that never ran read exactly like a pass.
test("a step that did not run prints as unknown, not as a pass", () => {
  const results = new Map([["npm test", { ok: true, detail: "199 tests pass" }]]);
  const verdict = formatVerdict(results, { tip: "abc1234", base: "origin/main" });
  assert.match(verdict, /^ {2}\? {4}resolve the named tip to one commit {2}\(not run\)$/m);
  assert.match(verdict, /^ {2}ok {3}npm test {2}199 tests pass$/m);
  assert.match(verdict, /FAIL: 0 check\(s\) failed, 6 did not run\./);
});

test("the verdict passes only when every step is recorded and ok", () => {
  const steps = [
    "resolve the named tip to one commit",
    "worktree HEAD is that exact commit",
    "worktree is clean",
    "commit signature is good",
    "tip descends from the base",
    "npm run check",
    "npm test",
  ];
  const results = new Map(steps.map((step) => [step, { ok: true }]));
  assert.match(formatVerdict(results, { tip: "abc1234" }), /PASS: all 7 checks hold at abc1234\./);

  results.set("npm test", { ok: false, detail: "1 of 3 failed" });
  assert.match(formatVerdict(results, { tip: "abc1234" }), /FAIL: 1 check\(s\) failed, 0 did not run\./);
});

// A git repository with a working `npm run check` and `npm test`, so verifyTip
// exercises the real sequence rather than stubs. Identity and signing are set
// per-command because this throwaway repo has no configuration of its own.
async function fixtureRepo(t, { checkExits = 0, testExits = 0 } = {}) {
  // realpath because macOS resolves the temp directory through /private, and
  // `git worktree list` prints the resolved path while mkdtemp returns the
  // symlinked one.
  const root = await realpath(await mkdtemp(join(tmpdir(), "verify-tip-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        private: true,
        type: "module",
        scripts: { check: "node scripts/check.mjs", test: "node --test" },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, "scripts", "check.mjs"),
    [`console.log("Validated 2 fixtures.");`, `process.exit(${checkExits});`, ""].join("\n"),
  );
  await writeFile(
    join(root, "test", "fixture.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("a passing fixture test", () => assert.ok(true));',
      testExits === 0 ? "" : 'test("a failing fixture test", () => assert.equal(1, 2));',
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const git = (...args) =>
    spawnSync(
      "git",
      ["-c", "user.email=t@example.invalid", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  return { root, base, git };
}

test("verifies a commit and reports the tip it actually checked out", async (t) => {
  const { root, base, git } = await fixtureRepo(t);
  await writeFile(join(root, "NOTES.md"), "a change under review\n");
  git("add", "-A");
  git("commit", "-qm", "tip");
  const tip = git("rev-parse", "HEAD").stdout.trim();

  const { results, sha } = await verifyTip({ tip, base, repoRoot: root });

  assert.equal(sha, tip);
  assert.equal(results.get("worktree HEAD is that exact commit").detail, tip);
  assert.equal(results.get("worktree HEAD is that exact commit").ok, true);
  assert.equal(results.get("worktree is clean").ok, true);
  assert.equal(results.get("tip descends from the base").ok, true);
  assert.equal(results.get("npm run check").ok, true);
  assert.equal(results.get("npm run check").detail, "Validated 2 fixtures.");
  assert.equal(results.get("npm test").ok, true);
  assert.equal(results.get("npm test").detail, "1 tests pass");

  // The fixture's commits are unsigned, so this has to read as a failure. If
  // it passed here the signature step would be vacuous on the real repository
  // too, where it is the only thing tying a tip to its author.
  assert.equal(results.get("commit signature is good").ok, false);
  assert.match(results.get("commit signature is good").detail, /%G\? = N/);
});

test("names the failing tests instead of only counting them", async (t) => {
  const { root, base } = await fixtureRepo(t, { testExits: 1 });
  const { results } = await verifyTip({ tip: base, base, repoRoot: root });

  assert.equal(results.get("npm test").ok, false);
  assert.match(results.get("npm test").detail, /1 of 2 failed: a failing fixture test/);
  // The check gate still ran, so a review can say whether the data is also
  // broken rather than stopping at the first red step.
  assert.equal(results.get("npm run check").ok, true);
});

test("reports a failing check with the reason, not just a nonzero exit", async (t) => {
  const { root, base } = await fixtureRepo(t, { checkExits: 1 });
  const { results } = await verifyTip({ tip: base, base, repoRoot: root });

  assert.equal(results.get("npm run check").ok, false);
  assert.equal(results.get("npm run check").detail, "Validated 2 fixtures.");
});

// A tip that does not contain the base is the common review-stalling case:
// the suite is green, but it is green against a main that has moved.
test("fails a tip that does not contain the base, and says where they diverged", async (t) => {
  const { root, base, git } = await fixtureRepo(t);
  git("checkout", "-q", "-b", "feature");
  await writeFile(join(root, "FEATURE.md"), "feature work\n");
  git("add", "-A");
  git("commit", "-qm", "feature");
  const tip = git("rev-parse", "HEAD").stdout.trim();

  git("checkout", "-q", "main");
  await writeFile(join(root, "MAIN.md"), "main moved on\n");
  git("add", "-A");
  git("commit", "-qm", "main moves");
  const movedMain = git("rev-parse", "HEAD").stdout.trim();

  const { results } = await verifyTip({ tip, base: movedMain, repoRoot: root });

  const step = results.get("tip descends from the base");
  assert.equal(step.ok, false);
  assert.match(step.detail, new RegExp(`merge-base is ${base.slice(0, 7)}`));
  // The gates still ran: a stale branch whose suite also fails is a different
  // review from one that only needs a rebase.
  assert.equal(results.get("npm test").ok, true);
  assert.notEqual(base, movedMain);
});

test("refuses a tip that is not a commit and runs nothing else", async (t) => {
  const { root, base } = await fixtureRepo(t);
  const { results, sha } = await verifyTip({ tip: "0".repeat(40), base, repoRoot: root });

  assert.equal(sha, null);
  assert.equal(results.size, 1);
  assert.equal(results.get("resolve the named tip to one commit").ok, false);
  assert.match(formatVerdict(results, { tip: "0".repeat(40) }), /FAIL: 1 check\(s\) failed, 6 did not run\./);
});

test("leaves no worktree behind, even when the tip fails", async (t) => {
  const { root, base } = await fixtureRepo(t, { testExits: 1 });
  await verifyTip({ tip: base, base, repoRoot: root });

  const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
  const paths = [...list.matchAll(/^worktree (.*)$/gm)].map((match) => match[1]);
  assert.deepEqual(paths, [root], "the only worktree left should be the repository itself");
});
