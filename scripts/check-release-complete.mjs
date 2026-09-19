#!/usr/bin/env node
/**
 * check-release-complete — every publishable package whose current version has a
 * `v<version>` git tag must exist at that version on the npm registry.
 *
 * Why: release.yml publishes per package via trusted publishing, so a tag can be
 * PARTIALLY released (v2.1.0 shipped 2 of 9 packages — the 7 others were 404 and
 * `@codai/axiom-axm-lsp@2.1.0` was uninstallable for a day). Repair with
 * `scripts/release-bootstrap.ps1 -Publish -Missing`.
 *
 * Versions without a tag are in-progress bumps and are reported, not failed.
 * Network is required: unreachable registry → skipped (note) locally, FAIL under
 * `--strict` (CI has network; a silent skip there would defeat the guard).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, readJson, report, STRICT, workspacePackages } from "./_guard-lib.mjs";

const REGISTRY = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";
const TIMEOUT_MS = 8_000;

const tags = spawnSync("git", ["tag", "-l", "v*"], { cwd: REPO_ROOT, encoding: "utf8" });
const tagSet = new Set(tags.status === 0 ? tags.stdout.split(/\r?\n/).filter(Boolean) : []);

const packages = workspacePackages()
  .map((dir) => readJson(join(REPO_ROOT, "packages", dir, "package.json")))
  .filter((pkg) => !pkg.private && typeof pkg.name === "string");

async function registryVersions(name) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace("%40", "@")}`, {
      signal: ctrl.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (res.status === 404) return new Set();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return new Set(Object.keys(body.versions ?? {}));
  } finally {
    clearTimeout(timer);
  }
}

const problems = [];
const notes = [];
let released = 0;
let unreleased = 0;

let results;
try {
  results = await Promise.all(packages.map((pkg) => registryVersions(pkg.name)));
} catch (err) {
  const msg = `registry ${REGISTRY} unreachable: ${err instanceof Error ? err.message : String(err)}`;
  if (STRICT) report("release-complete", [msg]);
  report("release-complete", [], { notes: [`skipped: ${msg}`], skipped: true });
}

packages.forEach((pkg, i) => {
  const tag = `v${pkg.version}`;
  if (!tagSet.has(tag)) {
    unreleased++;
    return;
  }
  released++;
  if (!results[i].has(pkg.version)) {
    problems.push(
      `${pkg.name}@${pkg.version} is tagged ${tag} but absent from the registry — run scripts/release-bootstrap.ps1 -Publish -Missing`,
    );
  }
});

notes.push(`${released} tagged package version(s) present on ${REGISTRY}`);
if (unreleased > 0) notes.push(`${unreleased} version(s) not yet tagged (in progress)`);
report("release-complete", problems, { notes });
