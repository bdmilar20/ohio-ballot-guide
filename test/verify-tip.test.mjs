import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatVerdict, signatureDetail, verifyTip } from "../scripts/verify-tip.mjs";

const checker = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "verify-tip.mjs");

// This runtime injects its signing configuration through GIT_CONFIG_KEY_*/
// VALUE_*, which outranks a repository's own config. A fixture that needs to
// control how its commits verify has to be run without them.
const ENV_WITHOUT_GIT_CONFIG = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG_")),
);

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
  assert.equal(results.get("commit signature is good").detail, "the commit is not signed");
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

// A verifier standing in for gpgsm, so a fixture can produce a commit whose
// signature is good, good-but-untrusted, or bad. git calls it with
// `--status-fd=2 -bsau <key>` to sign and `--status-fd=1 --verify <file> -` to
// check, and reads the `[GNUPG:]` status lines on the fd it named -- so the
// trust line is the whole lever: TRUST_FULLY gives %G? = G, TRUST_UNDEFINED
// gives U, and BADSIG gives B.
const TRUST_LINES = {
  full: ["[GNUPG:] GOODSIG DEADBEEF Fixture Signer", "[GNUPG:] TRUST_FULLY"],
  undefined: ["[GNUPG:] GOODSIG DEADBEEF Fixture Signer", "[GNUPG:] TRUST_UNDEFINED"],
  bad: ["[GNUPG:] BADSIG DEADBEEF Fixture Signer"],
};

async function signedFixtureRepo(t, trust) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "verify-tip-signed-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = join(root, "verifier.sh");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      'for a in "$@"; do case "$a" in --verify)',
      '  echo "[GNUPG:] NEWSIG"',
      ...TRUST_LINES[trust].map((line) => `  echo ${JSON.stringify(line)}`),
      `  exit ${trust === "bad" ? 1 : 0};; esac; done`,
      'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 DEADBEEF" >&2',
      "printf -- '-----BEGIN SIGNED MESSAGE-----\\nZmFrZQ==\\n-----END SIGNED MESSAGE-----\\n'",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { check: "node scripts/check.mjs", test: "node --test" } }, null, 2)}\n`,
  );
  await writeFile(join(root, "scripts", "check.mjs"), 'console.log("Validated 2 fixtures.");\n');
  await writeFile(
    join(root, "test", "fixture.test.mjs"),
    ['import assert from "node:assert/strict";', 'import test from "node:test";', 'test("a passing fixture test", () => assert.ok(true));', ""].join("\n"),
  );

  // Written to the repository's own config rather than passed with -c, because
  // verify-tip runs plain `git` commands that have to pick these up too.
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: ENV_WITHOUT_GIT_CONFIG });
  git("init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.email", "t@example.invalid"],
    ["user.name", "Fixture"],
    ["user.signingkey", "DEADBEEF"],
    ["gpg.format", "x509"],
    ["gpg.x509.program", shim],
    ["commit.gpgsign", "true"],
  ]) {
    git("config", key, value);
  }
  git("add", "-A");
  const commit = git("commit", "-qm", "signed fixture");
  assert.equal(commit.status, 0, `the fixture could not sign a commit: ${commit.stderr}`);
  const sha = git("rev-parse", "HEAD").stdout.trim();
  // The fixture is only worth anything if it really produced the trust state
  // it claims, so that is asserted rather than assumed.
  const reported = git("log", "-1", "--format=%G?", sha).stdout.trim();
  assert.equal(reported, { full: "G", undefined: "U", bad: "B" }[trust], `fixture produced %G? = ${reported}`);
  return { root, sha };
}

// Runs the CLI in a child process so the fixture's git config is effective:
// stripping GIT_CONFIG_* from an already-running process would not reach the
// `git` calls verify-tip makes.
function runChecker(root, sha) {
  return spawnSync(process.execPath, [checker, "--tip", sha, "--base", sha], {
    cwd: root,
    encoding: "utf8",
    env: ENV_WITHOUT_GIT_CONFIG,
  });
}

// The regression this exists for. A commit from another agent is signed with a
// key the reviewer's machine has never been told to trust, so %G? reads "U" --
// gating on "G" failed every clean cross-agent review, which is the only kind
// of review this command is for. Found by Codex Sol against 67f5ebb.
test("accepts a valid signature whose key this machine does not trust", async (t) => {
  const { root, sha } = await signedFixtureRepo(t, "undefined");
  const run = runChecker(root, sha);

  assert.match(run.stdout, /^ {2}ok {3}commit signature is good {2}signed by Fixture Signer; valid, but that key is not in this machine's trust store/m);
  assert.match(run.stdout, /PASS: all 7 checks hold/);
  assert.equal(run.status, 0);
});

test("says so when the key is one this machine trusts", async (t) => {
  const { root, sha } = await signedFixtureRepo(t, "full");
  const run = runChecker(root, sha);

  assert.match(run.stdout, /^ {2}ok {3}commit signature is good {2}signed by Fixture Signer, a key this machine trusts$/m);
  assert.equal(run.status, 0);
});

// Loosening the step to accept U must not loosen it to accept anything.
test("still rejects a bad signature", async (t) => {
  const { root, sha } = await signedFixtureRepo(t, "bad");
  const run = runChecker(root, sha);

  assert.match(run.stdout, /^ {2}FAIL commit signature is good {2}git verify-commit rejected the signature \(%G\? = B\)$/m);
  assert.match(run.stdout, /FAIL: 1 check\(s\) failed/);
  assert.equal(run.status, 1);
});

test("an unsigned commit is named as unsigned, not as a rejected signature", () => {
  assert.equal(signatureDetail(false, "N", ""), "the commit is not signed");
  assert.equal(signatureDetail(false, "", ""), "the commit is not signed");
  assert.equal(signatureDetail(false, "B", "k"), "git verify-commit rejected the signature (%G? = B)");
});
