// Verifies a branch tip the way a reviewer has to, and in the one place it is
// safe to: a throwaway worktree checked out at the exact commit named.
//
//   npm run verify -- --tip <sha>
//   npm run verify -- --tip <sha> --base origin/main
//
// The point is attribution. A reviewer who runs the suite in a shared checkout
// is reporting on whatever that checkout happened to contain, which is not
// necessarily the commit the author named -- a fetch, another worktree, or an
// uncommitted edit moves it underneath them, and the green result still looks
// like evidence about the tip. This resolves the SHA once, checks out that
// object alone, and re-reads `git rev-parse HEAD` inside the worktree before
// believing any result from it.
//
// Every step is reported, passed or failed, because a step that silently did
// not run is indistinguishable from one that passed when only failures print.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "./ingest/vtrapp.mjs";

// The checks that have to hold before a tip is worth reviewing, in the order a
// reviewer needs them: identity first, because every later result is a claim
// about the commit, and the claim is void if the commit is not the one named.
const STEPS = [
  "resolve the named tip to one commit",
  "worktree HEAD is that exact commit",
  "worktree is clean",
  "commit signature is good",
  "tip descends from the base",
  "npm run check",
  "npm test",
];

// node --test reports to its parent instead of running when it inherits
// NODE_TEST_*, and exits 0 having run nothing. Verifying a tip from inside the
// suite -- which is how this command's own tests exercise it -- would then
// report every tip as green. Stripping those is what makes the gate real.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST_")));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: CLEAN_ENV,
    ...options,
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: `${result.stdout ?? ""}`,
    stderr: `${result.stderr ?? ""}`,
  };
}

function git(args, cwd) {
  return run("git", args, { cwd });
}

function gitOrThrow(args, cwd) {
  const result = git(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

/**
 * Formats the verdict block, one line per step, in the order they were defined
 * rather than the order they finished.
 *
 * A step with no recorded result prints as `?`, so a check this command forgot
 * to run cannot be read as one that passed. That is the failure mode of a
 * reviewer's by-hand sequence, and reproducing it here would defeat the point.
 */
export function formatVerdict(results, { tip, base } = {}) {
  const lines = [];
  let unknown = 0;
  let failed = 0;
  for (const step of STEPS) {
    const result = results.get(step);
    if (!result) {
      unknown += 1;
      lines.push(`  ?    ${step}  (not run)`);
      continue;
    }
    if (!result.ok) failed += 1;
    const marker = result.ok ? "ok  " : "FAIL";
    lines.push(`  ${marker} ${step}${result.detail ? `  ${result.detail}` : ""}`);
  }
  const header = `Verified tip ${tip ?? "(unresolved)"}${base ? ` against ${base}` : ""}`;
  const verdict =
    failed === 0 && unknown === 0
      ? `PASS: all ${STEPS.length} checks hold at ${tip}.`
      : `FAIL: ${failed} check(s) failed, ${unknown} did not run.`;
  return [header, ...lines, "", verdict].join("\n");
}

/**
 * Runs the whole sequence in a fresh worktree and returns the results.
 *
 * `onStep` is called as each one is decided: the suite takes seconds and the
 * checkout can take longer, and a reviewer watching a silent command cannot
 * tell it apart from a hung one.
 */
export async function verifyTip({ tip, base = "origin/main", repoRoot = process.cwd(), onStep = () => {} } = {}) {
  const results = new Map();
  const record = (step, ok, detail) => {
    const result = { ok, detail };
    results.set(step, result);
    onStep(step, result);
    return ok;
  };

  // Resolved in the caller's repository, which is the only place the ref is
  // known. `^{commit}` so an annotated tag or a ref resolves to the commit it
  // points at rather than to a tag object the checkout would then reject.
  const resolved = git(["rev-parse", "--verify", "--end-of-options", `${tip}^{commit}`], repoRoot);
  if (!resolved.ok) {
    record(STEPS[0], false, `${tip} is not a commit in this repository`);
    return { results, sha: null };
  }
  const sha = resolved.stdout.trim();
  record(STEPS[0], true, sha === tip ? sha : `${tip} -> ${sha}`);

  const parent = await mkdtemp(join(tmpdir(), "obg-verify-"));
  const worktree = join(parent, "tip");
  try {
    // --detach: this worktree exists to hold one commit still, and a branch
    // here would be a second writable checkout of a branch under review.
    const added = git(["worktree", "add", "--detach", "--quiet", worktree, sha], repoRoot);
    if (!added.ok) throw new Error(`could not create a worktree at ${sha}: ${added.stderr.trim()}`);

    // Asked of the worktree, not assumed from the argument. This is the check
    // the by-hand sequence skips.
    const head = gitOrThrow(["rev-parse", "HEAD"], worktree);
    if (!record(STEPS[1], head === sha, head === sha ? head : `worktree is at ${head}, not ${sha}`)) {
      return { results, sha };
    }

    const changes = gitOrThrow(["status", "--porcelain"], worktree);
    record(STEPS[2], changes === "", changes === "" ? "no uncommitted changes" : changes.split("\n").join("; "));

    // %G? is "G" only for a good signature. A commit signed by an unknown key
    // reports "U" or "E", which is not the same as unsigned, so the status
    // character is reported either way rather than collapsed to a boolean.
    const signature = gitOrThrow(["log", "-1", "--format=%G?%n%GS", sha], worktree).split("\n");
    const status = signature[0]?.trim();
    record(STEPS[3], status === "G", status === "G" ? `signed by ${signature[1]?.trim() || "(no signer reported)"}` : `git reports %G? = ${status || "(empty)"}`);

    // Asked in the caller's repository: the worktree has the objects but the
    // base ref may be one the detached checkout cannot name.
    const baseSha = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], repoRoot);
    if (!baseSha.ok) {
      record(STEPS[4], false, `${base} is not a commit in this repository`);
    } else {
      const baseCommit = baseSha.stdout.trim();
      const ancestor = git(["merge-base", "--is-ancestor", baseCommit, sha], repoRoot);
      // --is-ancestor exits 1 for "no" and something else for a real error;
      // conflating the two would report a broken repository as a stale branch.
      if (!ancestor.ok && ancestor.status !== 1) {
        throw new Error(`could not compare ${sha} with ${base}: ${ancestor.stderr.trim()}`);
      }
      const mergeBase = gitOrThrow(["merge-base", baseCommit, sha], repoRoot);
      record(
        STEPS[4],
        ancestor.ok,
        ancestor.ok
          ? `${base} is ${baseCommit.slice(0, 7)}, already contained`
          : `${base} is ${baseCommit.slice(0, 7)}; merge-base is ${mergeBase.slice(0, 7)}, so the tip needs a rebase or a merge`,
      );
    }

    // Both gates run in the worktree even if an earlier check failed, because
    // "the tree was dirty" and "the tree was dirty and the suite also fails"
    // are different reviews to write.
    const check = run("npm", ["run", "check"], { cwd: worktree });
    record(STEPS[5], check.ok, check.ok ? lastLine(check.stdout) : firstProblem(check));

    const test = run("npm", ["test"], { cwd: worktree });
    record(STEPS[6], test.ok, testDetail(test));

    return { results, sha, output: { check, test } };
  } finally {
    // Remove the worktree through git so its administrative entry goes too; a
    // plain delete leaves the parent repository listing a path that is gone.
    git(["worktree", "remove", "--force", worktree], repoRoot);
    await rm(parent, { recursive: true, force: true });
  }
}

function lastLine(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function firstProblem({ stdout, stderr }) {
  return lastLine(stderr) || lastLine(stdout) || "failed with no output";
}

// Reports the counts node --test prints, and names the failing tests when
// there are any: a reviewer needs to know which assertion broke, and "7 of 199
// failed" sends them back to re-run it by hand.
function testDetail({ ok, stdout, stderr }) {
  const text = `${stdout}\n${stderr}`;
  const pass = /^#? ?(?:pass|ℹ pass) (\d+)$/m.exec(text)?.[1];
  const fail = /^#? ?(?:fail|ℹ fail) (\d+)$/m.exec(text)?.[1];
  if (ok) return pass ? `${pass} tests pass` : lastLine(stdout);
  const names = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:✖|not ok \d+ -) (.*)$/.exec(line);
    if (match) names.push(match[1].replace(/ \([\d.]+ms\)$/, "").trim());
  }
  const unique = [...new Set(names)];
  const counts = `${fail ?? "?"} of ${Number(pass ?? 0) + Number(fail ?? 0) || "?"} failed`;
  return unique.length > 0 ? `${counts}: ${unique.slice(0, 5).join(" | ")}` : counts;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const tip = args.tip;
    if (!tip) throw new Error("--tip is required (the commit a review is about, e.g. --tip 3115500)");
    const base = args.base ?? "origin/main";

    const repoRoot = gitOrThrow(["rev-parse", "--show-toplevel"], process.cwd());
    const { results, sha } = await verifyTip({
      tip,
      base,
      repoRoot,
      onStep: (step, result) => process.stderr.write(`${result.ok ? "ok  " : "FAIL"} ${step}\n`),
    });

    process.stderr.write("\n");
    console.log(formatVerdict(results, { tip: sha ?? tip, base }));
    const clean = [...results.values()].every((result) => result.ok) && results.size === STEPS.length;
    if (!clean) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
