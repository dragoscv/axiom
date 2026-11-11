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
 *
 * 4.0: the spawned gate gets a temp HOME, so the measurement is the built-in policy and not
 * whatever `~/.axiom/gate-profile.json` the developer has (reality check #2: the guard failed
 * on the maintainer's machine because of a profile key the local dist did not know). A bare
 * `node -e 0` is timed next to it: when node itself needs more than LOADED_BASELINE_MS to
 * start, the machine is too busy to say anything about the gate. Without `--strict` that is
 * reported as "not judged" (never as a pass of the budget); CI runs `--strict` and always judges.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, REPO_ROOT, report, STRICT } from "./_guard-lib.mjs";

const RUNS = 15;
const P95_LIMIT_MS = 250;
const MAX_ROUNDS = 3;
/** Median start time of a bare `node -e 0` above which a local run is "not judged". */
const LOADED_BASELINE_MS = 90;
const BASELINE_RUNS = 7;
const target = join(REPO_ROOT, "packages", "mcp", "dist", "cli.js");

if (!exists(target)) {
  report(
    "gate-latency",
    STRICT ? ["packages/mcp/dist/cli.js missing — run pnpm build first"] : [],
    { notes: ["skipped: packages/mcp/dist/cli.js not built"], skipped: true },
  );
}

const root = mkdtempSync(join(tmpdir(), "axiom-gate-latency-"));
const home = mkdtempSync(join(tmpdir(), "axiom-gate-latency-home-"));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const payload = JSON.stringify({
  session_id: "guard",
  hook_event_name: "PreToolUse",
  cwd: root,
  tool_name: "Write",
  tool_input: { file_path: "src/allowed.ts", content: "export const ok = true;\n" },
});

const problems = [];
function baselineP50() {
  const samples = [];
  for (let i = 0; i < BASELINE_RUNS; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, ["-e", "0"], { cwd: root, env, timeout: 10_000 });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}
function measure() {
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [target, "gate", "--stdin"], {
      cwd: root,
      env,
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
    // Rank q·(n−1), floored (numpy "lower"): for n=15 that is index 13 — the second-worst
    // sample, as documented above. `floor(n·0.95)` = 14 = the MAX, which made this guard judge
    // the single Defender-scanned spawn: 22 Windows CI jobs all reported p95 === max, at
    // 210–243 ms against a 250 ms budget (runs 35504605381 / 35475685730 tipped over).
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

let stats;
let rounds = 0;
let baseline = 0;
try {
  // Warm-up: page in node + dist (and let an AV scanner finish with the fresh files).
  spawnSync(process.execPath, [target, "gate", "--stdin"], {
    cwd: root,
    env,
    input: payload,
    encoding: "utf8",
    timeout: 10_000,
  });
  baseline = baselineP50();
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
  rmSync(home, { recursive: true, force: true });
}

if (problems.length === 0) {
  const { p50, p95, max, samples } = stats;
  const line = `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${max.toFixed(0)} ms over ${RUNS} runs (${rounds} round${rounds === 1 ? "" : "s"}); bare node p50 ${baseline.toFixed(0)} ms`;
  const measured = {
    p50Ms: p50,
    p95Ms: p95,
    maxMs: max,
    baselineP50Ms: baseline,
    samplesMs: samples.map((s) => Math.round(s)),
  };
  if (p95 > P95_LIMIT_MS && !STRICT && baseline > LOADED_BASELINE_MS) {
    report("gate-latency", [], {
      notes: [
        `NOT JUDGED: machine under load (bare node needs ${baseline.toFixed(0)} ms > ${LOADED_BASELINE_MS} ms to start) — ${line}; CI judges with --strict`,
      ],
      skipped: true,
      stats: measured,
    });
  }
  if (p95 > P95_LIMIT_MS) {
    problems.push(`gate p95 ${p95.toFixed(0)} ms > ${P95_LIMIT_MS} ms (p50 ${p50.toFixed(0)} ms)`);
  }
  report("gate-latency", problems, { notes: [line], stats: measured });
}
report("gate-latency", problems);
