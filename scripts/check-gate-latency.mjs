#!/usr/bin/env node
/**
 * check-gate-latency — `node packages/mcp/dist/cli.js gate --stdin` end-to-end (node startup
 * included) p95 ≤ 250 ms over 15 sequential runs with a fixed, allowed Claude-shaped payload
 * (v2-architecture §5.6: the hook must be fast, because harness timeouts fail open).
 *
 * Also asserts the allow contract: exit 0 and empty stdout on every run.
 * The p95 of 15 spawns is the second-worst sample, so it is dominated by scheduler noise when
 * other guards run in the same pool — and on hosted Windows runners by Defender scanning a
 * freshly built `dist/` on the first spawns (observed: p50 101 ms, p95 654 ms, run
 * 35475685730). So: one untimed warm-up spawn, then a miss is re-measured up to two more
 * times and the MEDIAN round p95 is judged. A genuine regression misses every round; a busy
 * machine misses one.
 * Skips with OK+note when dist is absent; `--strict` fails instead.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, REPO_ROOT, report, STRICT } from "./_guard-lib.mjs";

const RUNS = 15;
const P95_LIMIT_MS = 250;
const MAX_ROUNDS = 3;
const target = join(REPO_ROOT, "packages", "mcp", "dist", "cli.js");

if (!exists(target)) {
  report(
    "gate-latency",
    STRICT ? ["packages/mcp/dist/cli.js missing — run pnpm build first"] : [],
    { notes: ["skipped: packages/mcp/dist/cli.js not built"], skipped: true },
  );
}

const root = mkdtempSync(join(tmpdir(), "axiom-gate-latency-"));
const payload = JSON.stringify({
  session_id: "guard",
  hook_event_name: "PreToolUse",
  cwd: root,
  tool_name: "Write",
  tool_input: { file_path: "src/allowed.ts", content: "export const ok = true;\n" },
});

const problems = [];
function measure() {
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [target, "gate", "--stdin"], {
      cwd: root,
      input: payload,
      encoding: "utf8",
      timeout: 10_000,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.status !== 0 || r.stdout !== "") {
      problems.push(
        `run ${i + 1}: exit ${r.status ?? r.signal}, stdout ${JSON.stringify(r.stdout.slice(0, 80))} — ${(r.stderr || "").trim().split("\n")[0]}`,
      );
      break;
    }
    samples.push(ms);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

let stats;
let rounds = 0;
try {
  // Warm-up: page in node + dist (and let an AV scanner finish with the fresh files).
  spawnSync(process.execPath, [target, "gate", "--stdin"], {
    cwd: root,
    input: payload,
    encoding: "utf8",
    timeout: 10_000,
  });
  const roundsSeen = [];
  stats = measure();
  rounds = 1;
  roundsSeen.push(stats);
  while (problems.length === 0 && stats.p95 > P95_LIMIT_MS && rounds < MAX_ROUNDS) {
    const again = measure();
    rounds++;
    roundsSeen.push(again);
    // Judge the median round by p95: noise must hit a majority of rounds to fail the guard.
    const byP95 = [...roundsSeen].sort((a, b) => a.p95 - b.p95);
    stats = byP95[Math.floor(byP95.length / 2)];
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length === 0) {
  const { p50, p95, max, samples } = stats;
  if (p95 > P95_LIMIT_MS) {
    problems.push(`gate p95 ${p95.toFixed(0)} ms > ${P95_LIMIT_MS} ms (p50 ${p50.toFixed(0)} ms)`);
  }
  report("gate-latency", problems, {
    notes: [
      `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${max.toFixed(0)} ms over ${RUNS} runs (${rounds} round${rounds === 1 ? "" : "s"})`,
    ],
    stats: { p50Ms: p50, p95Ms: p95, maxMs: max, samplesMs: samples.map((s) => Math.round(s)) },
  });
}
report("gate-latency", problems);
