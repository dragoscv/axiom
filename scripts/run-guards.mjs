#!/usr/bin/env node
/**
 * Run every `scripts/check-*.mjs` guard concurrently and summarise.
 *
 * Contract (brivio house pattern): each guard is standalone, prints
 * `OK    <name>` / `FAIL  <name>: reason` lines, exits 0/1, supports `--json`.
 * Output is buffered per guard so concurrent runs do not interleave.
 *
 * Usage:
 *   node scripts/run-guards.mjs                 all guards
 *   node scripts/run-guards.mjs deps stdout     only guards whose file name contains a filter
 *   node scripts/run-guards.mjs --fast          skip slow/build-dependent guards (pre-commit)
 *   node scripts/run-guards.mjs --json          machine-readable summary
 *   node scripts/run-guards.mjs --quiet         no "slowest" line
 *   GUARD_CONCURRENCY=4 …                       override the pool size
 */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS_DIR, "..");
const TIMEOUT_MS = 60_000;

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("-")));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const quiet = flags.has("--quiet");
const json = flags.has("--json");
const fast = flags.has("--fast");

/** Guards that need a build, spawn processes or the network — skipped under `--fast`. */
const SLOW = new Set([
  "check-cold-start.mjs",
  "check-bundle-size.mjs",
  "check-schema-json-fresh.mjs",
  "check-release-complete.mjs",
]);

const guards = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith("check-") && f.endsWith(".mjs"))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .filter((f) => !fast || !SLOW.has(f))
  .sort();

const limit = Math.max(
  1,
  Math.min(guards.length, Number(process.env.GUARD_CONCURRENCY) || Math.min(8, cpus().length)),
);

/** Slowest first so the wall clock is bounded by them, not queued behind them. */
const SLOWEST_FIRST = [
  "check-schema-json-fresh.mjs",
  "check-cold-start.mjs",
  "check-changeset-present.mjs",
];
const rank = (n) => {
  const i = SLOWEST_FIRST.indexOf(n);
  return i === -1 ? SLOWEST_FIRST.length : i;
};

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const childArgs = [join(SCRIPTS_DIR, name)];
    if (json) childArgs.push("--json");
    if (flags.has("--strict")) childArgs.push("--strict");
    execFile(
      process.execPath,
      childArgs,
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        const timedOut = err?.killed === true || err?.signal === "SIGTERM";
        resolve({
          name,
          ms: Date.now() - started,
          code: timedOut ? 124 : err ? (typeof err.code === "number" ? err.code : 1) : 0,
          timedOut,
          out: `${stdout ?? ""}${stderr ?? ""}`.trimEnd(),
        });
      },
    );
  });
}

const queue = [...guards].sort((a, b) => rank(a) - rank(b));
const results = [];
const started = Date.now();

await Promise.all(
  Array.from({ length: limit }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      results.push(await run(next));
    }
  }),
);

results.sort((a, b) => a.name.localeCompare(b.name));
const failed = results.filter((r) => r.code !== 0);

if (json) {
  const parsed = results.map((r) => {
    let detail = null;
    try {
      detail = JSON.parse(r.out.split("\n").find((l) => l.startsWith("{")) ?? "null");
    } catch {
      detail = null;
    }
    return { name: r.name, ok: r.code === 0, code: r.code, ms: r.ms, timedOut: r.timedOut, detail };
  });
  process.stdout.write(
    `${JSON.stringify({ ok: failed.length === 0, passed: results.length - failed.length, total: results.length, ms: Date.now() - started, guards: parsed })}\n`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

for (const r of results) {
  if (r.code === 0) {
    console.log(r.out || `OK    ${r.name}`);
  }
}
for (const r of failed) {
  const why = r.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
  console.log(`\nFAILED ${r.name} (${why}, ${(r.ms / 1000).toFixed(1)}s)`);
  console.log(r.out);
}

if (!quiet) {
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(
    `\nslowest: ${slowest
      .map((r) => `${r.name.replace(/^check-|\.mjs$/g, "")} ${(r.ms / 1000).toFixed(1)}s`)
      .join(", ")}`,
  );
}

console.log(
  `\n${results.length - failed.length}/${results.length} guards passed in ${((Date.now() - started) / 1000).toFixed(1)}s (concurrency ${limit}${fast ? ", --fast" : ""}).`,
);

process.exit(failed.length > 0 ? 1 : 0);
