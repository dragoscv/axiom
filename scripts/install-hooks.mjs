#!/usr/bin/env node
/**
 * install-hooks — point git at the versioned hooks in `.githooks/`.
 * Run once per clone: `node scripts/install-hooks.mjs`.
 * Idempotent; prints the resulting `core.hooksPath`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = ".githooks";

const set = spawnSync("git", ["config", "core.hooksPath", HOOKS], { cwd: ROOT, encoding: "utf8" });
if (set.status !== 0) {
  console.error(`FAIL  install-hooks: git config failed: ${set.stderr.trim()}`);
  process.exit(1);
}

if (process.platform !== "win32") {
  for (const f of readdirSync(join(ROOT, HOOKS))) {
    if (!f.includes(".")) chmodSync(join(ROOT, HOOKS, f), 0o755);
  }
}

const get = spawnSync("git", ["config", "--get", "core.hooksPath"], {
  cwd: ROOT,
  encoding: "utf8",
});
console.log(`OK    install-hooks: core.hooksPath=${get.stdout.trim()}`);
