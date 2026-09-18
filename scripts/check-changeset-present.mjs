#!/usr/bin/env node
/**
 * check-changeset-present — a change under packages/(star)/src (not _v1, not
 * the private testkit/conformance) must ship with a `.changeset/*.md` entry, or the
 * release has no changelog and no version bump.
 *
 * Diff base: `origin/main...HEAD`; falls back to `HEAD~1` (shallow clones,
 * local branches). On a clean tree with no src changes the guard is a no-op.
 * Outside CI it WARNS (exit 0 with a note) so local pre-commit stays usable;
 * in CI (`CI=true`) it fails.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, REPO_ROOT, report } from "./_guard-lib.mjs";

const IN_CI = process.env.CI === "true" || process.env.CI === "1";

function git(...a) {
  const r = spawnSync("git", a, { cwd: REPO_ROOT, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

let base = "origin/main...HEAD";
let diff = git("diff", "--name-only", base);
if (diff === null) {
  base = "HEAD~1";
  diff = git("diff", "--name-only", base);
}
if (diff === null) {
  report("changeset-present", [], {
    notes: ["skipped: git diff unavailable (no history?)"],
    skipped: true,
  });
}
// Also count staged + unstaged work so pre-commit sees what is about to land.
const working = git("diff", "--name-only", "HEAD") ?? "";
const changed = new Set([...diff.split("\n"), ...working.split("\n")].filter(Boolean));

const srcTouched = [...changed].filter(
  (f) =>
    /^packages\/(?!_v1\/|testkit\/|conformance\/)[^/]+\/src\//.test(f) && !/\.test\.ts$/.test(f),
);

if (srcTouched.length === 0) {
  report("changeset-present", [], { notes: [`no publishable src changes vs ${base}`] });
}

const csDir = join(REPO_ROOT, ".changeset");
const changesets = exists(csDir)
  ? readdirSync(csDir).filter((f) => f.endsWith(".md") && f !== "README.md")
  : [];
const changesetInDiff = [...changed].some(
  (f) => /^\.changeset\/.+\.md$/.test(f) && !f.endsWith("README.md"),
);

if (changesets.length > 0 || changesetInDiff) {
  report("changeset-present", [], {
    notes: [`${srcTouched.length} src file(s) changed, ${changesets.length} changeset(s) present`],
  });
}

const msg = `${srcTouched.length} src file(s) changed vs ${base} but no .changeset/*.md — run: pnpm changeset`;
if (IN_CI) report("changeset-present", [msg]);
report("changeset-present", [], { notes: [`WARN ${msg}`] });
