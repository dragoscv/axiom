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
 *
 * S-1322: under `--strict` (release.yml runs it right after `changeset publish`) it also asserts
 * that every non-npm surface naming the release carries the @codai/axiom-mcp version —
 * CITATION.cff, packages/mcp/server.json (both fields), crates/axiom-hook/Cargo.toml,
 * packages/vscode-axm/package.json — and that SECURITY.md lists the `<major>.x` line. Outside
 * `--strict` a mismatch is a note (a version bump is legitimately in progress).
 * `node scripts/sync-release-versions.mjs` fixes all of them.
 *
 * Usage: node scripts/check-release-complete.mjs [--strict] [--json] [--help]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, REPO_ROOT, readJson, report, STRICT, workspacePackages } from "./_guard-lib.mjs";

if (args.has("--help") || args.has("-h")) {
  console.log(
    "usage: node scripts/check-release-complete.mjs [--strict] [--json]\n" +
      "  every tagged packages/* version must be on the npm registry;\n" +
      "  --strict: unreachable registry fails, and CITATION.cff / server.json / Cargo.toml /\n" +
      "  vscode-axm / SECURITY.md must name the @codai/axiom-mcp version (fix: sync-release-versions.mjs)",
  );
  process.exit(0);
}

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
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace(/%40/g, "@")}`, {
      signal: ctrl.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    // null = the package was never published (a new package, e.g. the @codai/axiom-hook-*
    // platform packages of S-1318 whose first version is the next release).
    if (res.status === 404) return null;
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

/** Release-surface versions that must equal the mcp version (S-1322). */
function surfaceMismatches() {
  const mcp = readJson(join(REPO_ROOT, "packages/mcp/package.json")).version;
  const text = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");
  const out = [];
  const expect = (what, got) => {
    if (got !== mcp) out.push(`${what} is ${got ?? "(missing)"}, expected ${mcp}`);
  };
  expect("CITATION.cff version", text("CITATION.cff").match(/^version:\s*"?([^"\s]+)"?/m)?.[1]);
  const server = readJson(join(REPO_ROOT, "packages/mcp/server.json"));
  expect("packages/mcp/server.json version", server.version);
  for (const [i, p] of (server.packages ?? []).entries()) {
    expect(`packages/mcp/server.json packages[${i}].version`, p.version);
  }
  expect(
    "crates/axiom-hook/Cargo.toml version",
    text("crates/axiom-hook/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  );
  expect(
    "packages/vscode-axm/package.json version",
    readJson(join(REPO_ROOT, "packages/vscode-axm/package.json")).version,
  );
  const major = mcp.split(".")[0];
  if (!new RegExp(`\\b${major}\\.x\\b`).test(text("SECURITY.md"))) {
    out.push(`SECURITY.md does not list the ${major}.x line under Supported versions`);
  }
  return out;
}

for (const m of surfaceMismatches()) {
  if (STRICT) problems.push(`${m} — run node scripts/sync-release-versions.mjs`);
  else notes.push(`version drift (fails under --strict): ${m}`);
}

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
  if (results[i] === null) {
    const msg = `${pkg.name} has never been published (new package; first publish is the next release — enable npm trusted publishing for it first: scripts/npm-trust-all.ps1)`;
    if (STRICT) problems.push(msg);
    else notes.push(msg);
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
