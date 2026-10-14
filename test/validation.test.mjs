import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(projectRoot, "scripts", "validate-data.mjs");

async function validateFixture(t, mutate) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohio-ballot-guide-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const data = JSON.parse(
    await readFile(join(projectRoot, "data", "elections.json"), "utf8"),
  );
  mutate(data);

  const fixture = join(temporaryDirectory, "elections.json");
  await writeFile(fixture, JSON.stringify(data));

  return spawnSync(process.execPath, [validator, fixture], {
    encoding: "utf8",
  });
}

test("validator rejects aliases that collide after query normalization", async (t) => {
  const result = await validateFixture(t, (data) => {
    const cleveland = data.locations.find(({ id }) => id === "cleveland");
    cleveland.aliases.push("Cincinnati OH");
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /location alias Cincinnati collides with cleveland/);
});

test("validator rejects a contest without a geographic scope", async (t) => {
  const result = await validateFixture(t, (data) => {
    delete data.elections[0].statewide_races[0].scope;
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /governor needs a scope/);
});
