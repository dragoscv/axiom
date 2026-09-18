#!/usr/bin/env node
/**
 * check-gate-latency — `node packages/mcp/dist/cli.js gate --stdin` end-to-end (node startup
 * included) p95 ≤ 250 ms over 15 sequential runs with a fixed, allowed Claude-shaped payload
 * (v2-architecture §5.6: the hook must be fast, because harness timeouts fail open).
 *
 * Also asserts the allow contract: exit 0 and empty stdout on every run.
 * Skips with OK+note when dist is absent; `--strict` fails instead.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, REPO_ROOT, report, STRICT } from "./_guard-lib.mjs";

const RUNS = 15;
const P95_LIMIT_MS = 250;
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

const samples = [];
const problems = [];
try {
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
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length === 0) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const max = sorted[sorted.length - 1];
  if (p95 > P95_LIMIT_MS) {
    problems.push(`gate p95 ${p95.toFixed(0)} ms > ${P95_LIMIT_MS} ms (p50 ${p50.toFixed(0)} ms)`);
  }
  report("gate-latency", problems, {
    notes: [
      `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${max.toFixed(0)} ms over ${RUNS} runs`,
    ],
    stats: { p50Ms: p50, p95Ms: p95, maxMs: max, samplesMs: samples.map((s) => Math.round(s)) },
  });
}
report("gate-latency", problems);
