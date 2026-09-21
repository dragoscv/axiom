#!/usr/bin/env node
/**
 * Build the standalone `axiom` executable for the CURRENT platform (D-27).
 *
 *   pnpm --filter @codai/axiom-mcp build:sea        # 1. dist/sea/axiom.cjs (tsdown, inlined CJS)
 *   node scripts/build-sea.mjs [--out <dir>]        # 2. node --build-sea → <dir>/axiom-<os>-<arch>[.exe]
 *
 * Requires Node ≥ 25.5 (`--build-sea`); release.yml pins Node 26 on every runner. The builder
 * Node is the runtime that gets embedded — SEA blobs carry no version marker, so a blob built by
 * one Node version injected into another aborts at startup; building natively per OS makes the two
 * identical by construction. `useCodeCache`/`useSnapshot` stay off: code cache breaks `import()`
 * and neither survives a different platform. macOS binaries get an ad-hoc signature.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(
  outIdx >= 0 ? (args[outIdx + 1] ?? "dist/sea/bin") : join(pkgDir, "dist/sea/bin"),
);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`build-sea: Node ≥ 25.5 required for --build-sea (running ${process.version})`);
  process.exit(2);
}

const main = join(pkgDir, "dist/sea/axiom.cjs");
if (!existsSync(main)) {
  console.error(
    `build-sea: ${main} missing — run \`pnpm --filter @codai/axiom-mcp build:sea\` first`,
  );
  process.exit(2);
}

const os =
  process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
const target = `axiom-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
mkdirSync(outDir, { recursive: true });
const output = join(outDir, target);

const configPath = join(pkgDir, "dist/sea/sea-config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      main,
      output,
      mainFormat: "commonjs",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "env",
    },
    null,
    2,
  )}\n`,
);

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`build-sea: ${cmd} ${cmdArgs.join(" ")} exited ${r.status ?? r.signal}`);
    process.exit(r.status ?? 1);
  }
}

run(process.execPath, ["--build-sea", configPath]);
if (process.platform === "darwin") run("codesign", ["--sign", "-", output]);

// Smoke: the binary must answer --version with the package version and no stderr noise.
const expected = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const smoke = spawnSync(output, ["--version"], { encoding: "utf8" });
if (smoke.status !== 0 || smoke.stdout.trim() !== expected) {
  console.error(
    `build-sea: smoke failed — exit ${smoke.status}, stdout ${JSON.stringify(smoke.stdout)}, stderr ${JSON.stringify(smoke.stderr)}`,
  );
  process.exit(1);
}
const mb = (statSync(output).size / 1024 / 1024).toFixed(1);
console.error(`build-sea: ${output} (${mb} MB, node ${process.version}, --version → ${expected})`);
console.log(output);
