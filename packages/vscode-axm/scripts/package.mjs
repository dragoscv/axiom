#!/usr/bin/env node
/**
 * Package the extension into `<repo>/.copilot-tmp/axiom-axm-<version>.vsix` (gitignored).
 *
 * `--no-dependencies` skips vsce's npm-ls walk (which does not understand pnpm's layout) and
 * `.vscodeignore` drops `node_modules` entirely: both the client (`dist/extension.cjs`) and the
 * language server (`dist/server.cjs`) are self-contained bundles.
 *
 * vsce validates `devDependencies["@types/vscode"]` as semver and rejects pnpm's `catalog:`
 * spec, so the manifest is temporarily rewritten with the resolved version (from the installed
 * package) and restored afterwards — the tracked `package.json` is never left modified.
 *
 * The extension is `private` and outside the changesets `fixed` group, so its `version` is
 * stamped from `@codai/axiom-mcp` (the release version) for the same rewrite window: the
 * Marketplace rejects a re-publish of an existing version, and `axiom-axm-<version>.vsix`
 * must match the `v<version>` tag it is attached to (S-412).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const manifestPath = join(pkgDir, "package.json");
const original = readFileSync(manifestPath, "utf8");
const pkg = JSON.parse(original);
const releaseVersion = JSON.parse(
  readFileSync(join(repoRoot, "packages", "mcp", "package.json"), "utf8"),
).version;
const outDir = join(repoRoot, ".copilot-tmp");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${pkg.name}-${releaseVersion}.vsix`);

for (const required of ["dist/extension.cjs", "dist/server.cjs"]) {
  if (!existsSync(join(pkgDir, required))) {
    console.error(`package: missing ${required} — run \`pnpm build\` first`);
    process.exit(1);
  }
}

const require = createRequire(import.meta.url);
let vsceBin;
try {
  vsceBin = require.resolve("@vscode/vsce/vsce");
} catch {
  console.error("package: @vscode/vsce is not installed (pnpm install)");
  process.exit(1);
}

const typesVersion = JSON.parse(
  readFileSync(join(pkgDir, "node_modules", "@types", "vscode", "package.json"), "utf8"),
).version;
const resolved = {
  ...pkg,
  version: releaseVersion,
  devDependencies: { ...pkg.devDependencies, "@types/vscode": typesVersion },
};

let status = 1;
writeFileSync(manifestPath, `${JSON.stringify(resolved, null, 2)}\n`);
try {
  const r = spawnSync(
    process.execPath,
    [
      vsceBin,
      "package",
      "--no-dependencies",
      "--allow-missing-repository",
      "--skip-license",
      "-o",
      out,
    ],
    { cwd: pkgDir, stdio: "inherit" },
  );
  status = r.status ?? 1;
} finally {
  writeFileSync(manifestPath, original);
}
if (status !== 0) process.exit(status);
const kb = (statSync(out).size / 1024).toFixed(1);
console.error(`package: ${out} (${kb} KB)`);
