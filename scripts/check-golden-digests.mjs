#!/usr/bin/env node
/**
 * check-golden-digests — every `packages/testkit/golden/<name>.plan.json` has
 * a committed `<name>.expected.json` whose `manifestDigest` is a well-formed
 * `sha256:<64 hex>` and whose `artifacts[]` entries carry 64-hex sha256s.
 * Orphan expected files (no plan) are also flagged.
 *
 * Whether the digest is *correct* is the testkit golden test's job (and the
 * cross-OS CI job); this guard only ensures the fixture set is complete and
 * well-formed on a fresh checkout.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, REPO_ROOT, readJson, report } from "./_guard-lib.mjs";

const DIR = join(REPO_ROOT, "packages", "testkit", "golden");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const problems = [];
if (!exists(DIR)) {
  report("golden-digests", ["packages/testkit/golden/ does not exist"]);
}

const files = readdirSync(DIR);
const plans = files.filter((f) => f.endsWith(".plan.json"));
const expecteds = files.filter((f) => f.endsWith(".expected.json"));

if (plans.length === 0) problems.push("no *.plan.json fixtures — golden suite would be vacuous");

for (const plan of plans) {
  const name = plan.slice(0, -".plan.json".length);
  const expectedFile = `${name}.expected.json`;
  if (!expecteds.includes(expectedFile)) {
    problems.push(
      `${name}: missing ${expectedFile} (run pnpm --filter @codai/axiom-testkit update-golden)`,
    );
    continue;
  }
  let expected;
  try {
    expected = readJson(join(DIR, expectedFile));
  } catch (e) {
    problems.push(`${expectedFile}: invalid JSON — ${e.message}`);
    continue;
  }
  if (typeof expected.manifestDigest !== "string" || !DIGEST.test(expected.manifestDigest)) {
    problems.push(
      `${expectedFile}: manifestDigest must match sha256:<64 hex>, got ${JSON.stringify(expected.manifestDigest)}`,
    );
  }
  if (expected.planDigest !== undefined && !DIGEST.test(expected.planDigest)) {
    problems.push(`${expectedFile}: planDigest malformed`);
  }
  if (!Array.isArray(expected.artifacts)) {
    problems.push(`${expectedFile}: artifacts[] missing`);
  } else {
    expected.artifacts.forEach((a, i) => {
      if (typeof a?.path !== "string" || !HEX64.test(a?.sha256 ?? "")) {
        problems.push(`${expectedFile}: artifacts[${i}] needs {path, sha256:<64 hex>}`);
      }
    });
  }
}

for (const e of expecteds) {
  const name = e.slice(0, -".expected.json".length);
  if (!plans.includes(`${name}.plan.json`)) problems.push(`${e}: orphan — no ${name}.plan.json`);
}

report("golden-digests", problems, {
  notes: [`${plans.length} fixture(s)`],
  stats: { fixtures: plans.map((p) => p.replace(/\.plan\.json$/, "")) },
});
