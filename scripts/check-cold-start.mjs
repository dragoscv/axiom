#!/usr/bin/env node
/**
 * check-cold-start — `node packages/mcp/dist/cli.js --version` p50 ≤ 250 ms
 * over 7 sequential runs (PLAN.md D-11). Reported as measured, never estimated.
 *
 * Skips with OK+note when dist is absent; `--strict` fails instead.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { exists, REPO_ROOT, report, STRICT } from "./_guard-lib.mjs";

const RUNS = 7;
const P50_LIMIT_MS = 250;
const target = join(REPO_ROOT, "packages", "mcp", "dist", "cli.js");

if (!exists(target)) {
  report("cold-start", STRICT ? ["packages/mcp/dist/cli.js missing — run pnpm build first"] : [], {
    notes: ["skipped: packages/mcp/dist/cli.js not built"],
    skipped: true,
  });
}

const samples = [];
const problems = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [target, "--version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) {
    problems.push(
      `run ${i + 1}: exit ${r.status ?? r.signal} — ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`,
    );
    break;
  }
  samples.push(ms);
}

if (problems.length === 0) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  if (p50 > P50_LIMIT_MS) {
    problems.push(
      `cold start p50 ${p50.toFixed(0)} ms > ${P50_LIMIT_MS} ms (max ${max.toFixed(0)} ms)`,
    );
  }
  report("cold-start", problems, {
    notes: [`p50 ${p50.toFixed(0)} ms, max ${max.toFixed(0)} ms over ${RUNS} runs`],
    stats: { p50Ms: p50, maxMs: max, samplesMs: samples.map((s) => Math.round(s)) },
  });
}
report("cold-start", problems);
