#!/usr/bin/env node
/**
 * sync-release-versions — after `changeset version` bumped the fixed @codai/axiom-* group,
 * carry `packages/mcp/package.json` version into every non-npm file that names the release
 * (S-1322). `check-release-complete --strict` asserts the same set after publish.
 *
 *   CITATION.cff                    version + date-released (UTC today)
 *   packages/mcp/server.json        version + packages[].version
 *   crates/axiom-hook/Cargo.toml    [package] version
 *   crates/axiom-hook/Cargo.lock    the axiom-hook [[package]] entry
 *   packages/vscode-axm/package.json version (private, not in the changesets group)
 *
 * Usage: node scripts/sync-release-versions.mjs [--check] [--date YYYY-MM-DD]
 *   --check  write nothing; exit 1 listing the files that are out of sync
 * Byte-preserving: only the version tokens change (line endings, key order, comments kept).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const dateArg = argv.indexOf("--date");
const today = dateArg >= 0 ? argv[dateArg + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? "")) {
  console.error("sync-release-versions: --date must be YYYY-MM-DD");
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(ROOT, "packages/mcp/package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`sync-release-versions: packages/mcp version "${version}" is not SemVer`);
  process.exit(2);
}

/** [relative path, (text) => new text]; each rewrite must match exactly where it expects. */
const rewrites = [
  [
    "CITATION.cff",
    (t) =>
      must(
        must(t, /^version:[^\r\n]*/m, `version: ${version}`),
        /^date-released:[^\r\n]*/m,
        CHECK ? null : `date-released: "${today}"`,
      ),
  ],
  ["packages/mcp/server.json", (t) => t.replace(/("version"\s*:\s*")[^"]*(")/g, `$1${version}$2`)],
  [
    "crates/axiom-hook/Cargo.toml",
    // First `version =` at column 0 inside [package] (the manifest has no other top-level one).
    (t) => must(t, /(\[package\][^[]*?^version\s*=\s*")[^"]*(")/ms, `$1${version}$2`),
  ],
  [
    "crates/axiom-hook/Cargo.lock",
    (t) =>
      must(
        t,
        /(\[\[package\]\]\r?\nname = "axiom-hook"\r?\nversion = ")[^"]*(")/,
        `$1${version}$2`,
      ),
  ],
  [
    "packages/vscode-axm/package.json",
    (t) => must(t, /^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`),
  ],
];

/** Replace the first match of `re` or throw — a silent no-op would hide a format change. */
function must(text, re, replacement) {
  if (!re.test(text)) throw new Error(`pattern ${re} not found`);
  if (replacement === null) return text; // --check ignores the release date
  return text.replace(re, replacement);
}

let drift = 0;
for (const [rel, fn] of rewrites) {
  const file = join(ROOT, rel);
  const before = readFileSync(file, "utf8");
  let after;
  try {
    after = fn(before);
  } catch (err) {
    console.error(`FAIL  ${rel}: ${err.message}`);
    process.exit(1);
  }
  if (after === before) {
    console.log(`ok    ${rel} (${version})`);
    continue;
  }
  drift++;
  if (CHECK) console.log(`DRIFT ${rel} is not at ${version}`);
  else {
    writeFileSync(file, after);
    console.log(`wrote ${rel} → ${version}`);
  }
}
if (CHECK && drift > 0) process.exit(1);
