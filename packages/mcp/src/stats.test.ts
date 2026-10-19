import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRecord } from "./decisions.js";
import {
  collectStats,
  GATE_SLOW_P95_MS,
  harnessOf,
  parseSince,
  renderStats,
  summarizeDecisions,
} from "./stats.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-stats-");
  home = await tmpRepo("axiom-stats-home-");
});
afterEach(async () => {
  await repo.cleanup();
  await home.cleanup();
});

function rec(p: Partial<DecisionRecord> & Pick<DecisionRecord, "decided_at">): DecisionRecord {
  return {
    v: 1,
    agent_id: "claude:s1",
    principal: { subject: "u" },
    tool: "Write",
    args_hash: "sha256:00",
    args_state: "recorded",
    decision: "allow",
    paths: ["a.txt"],
    profile: "builtin",
    ...p,
  };
}

async function writeJournal(root: string, records: readonly unknown[]): Promise<void> {
  await mkdir(join(root, ".axiom"), { recursive: true });
  await writeFile(
    join(root, ".axiom", "decisions.jsonl"),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`,
  );
}

/** Options that keep every locator away from the real machine. */
function isolated(extra: Record<string, unknown> = {}) {
  return {
    root: repo.root,
    home: home.root,
    platform: "linux" as const,
    hookLogs: [] as string[],
    copilotLogsDir: join(home.root, "no-copilot"),
    ...extra,
  };
}

const FIXTURE: DecisionRecord[] = [
  rec({ decided_at: "2026-10-10T00:00:00Z", ms: 10 }),
  rec({ decided_at: "2026-10-11T00:00:00Z", ms: 20, decision: "deny", code: "ERR_GATE_DENY_GLOB" }),
  rec({
    decided_at: "2026-10-12T00:00:00Z",
    ms: 30,
    agent_id: "copilot:x:y",
    tool: "Bash",
    decision: "deny",
    code: "ERR_GATE_DENY_GLOB",
  }),
  rec({
    decided_at: "2026-10-13T00:00:00Z",
    ms: 40,
    agent_id: "copilot:z",
    decision: "deny",
    shadow: true,
    code: "ERR_SECRET_DETECTED",
  }),
  rec({ decided_at: "2026-10-14T00:00:00Z", ms: 5000, agent_id: "codex:q", phase: "post" }),
];

describe("summarizeDecisions", () => {
  it("counts allow/deny/ask, ignores unknown decisions, shadow diffs and nearest-rank percentiles", () => {
    const ask = { ...rec({ decided_at: "2026-10-01T00:00:00Z", ms: 7 }), decision: "ask" };
    const weird = { ...rec({ decided_at: "2026-10-01T00:00:00Z", ms: 999 }), decision: "maybe" };
    const shadowAllow = rec({ decided_at: "2026-10-01T00:00:00Z", shadow: true });
    const b = summarizeDecisions([
      ...FIXTURE,
      ask as unknown as DecisionRecord,
      weird as unknown as DecisionRecord,
      shadowAllow,
    ]);
    expect(b).toEqual({
      total: 7,
      allow: 3,
      deny: 3,
      ask: 1,
      shadowDiffs: 1,
      relaxed: 0,
      // ms sorted: 7 10 20 30 40 5000 → floor(5*0.5)=2 → 20, floor(5*0.95)=4 → 40
      p50: 20,
      p95: 40,
      codes: { ERR_GATE_DENY_GLOB: 2, ERR_SECRET_DETECTED: 1 },
    });
  });

  it("an empty set has null percentiles", () => {
    expect(summarizeDecisions([])).toMatchObject({ total: 0, p50: null, p95: null });
  });

  it("harnessOf takes everything before the first colon", () => {
    expect([harnessOf("copilot:x:y"), harnessOf("claude"), harnessOf(":s")]).toEqual([
      "copilot",
      "claude",
      "unknown",
    ]);
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  it("relative days/hours/minutes and ISO passthrough", () => {
    expect(parseSince("7d", now)).toBe("2026-10-07T12:00:00.000Z");
    expect(parseSince("12h", now)).toBe("2026-10-14T00:00:00.000Z");
    expect(parseSince("30m", now)).toBe("2026-10-14T11:30:00.000Z");
    expect(parseSince("2026-10-01T00:00:00Z", now)).toBe("2026-10-01T00:00:00.000Z");
  });
  it("throws on garbage", () => {
    for (const bad of ["", "7w", "yesterday", "2026-13-99"]) {
      expect(() => parseSince(bad, now)).toThrow(Error);
    }
  });
});

describe("collectStats — decisions", () => {
  it("buckets by harness, tool and post phase", async () => {
    await writeJournal(repo.root, FIXTURE);
    const s = await collectStats(isolated());
    expect(s.decisions).toMatchObject({ total: 5, allow: 2, deny: 3, shadowDiffs: 1 });
    expect(s.decisions.p50).toBe(30);
    expect(s.decisions.p95).toBe(40);
    expect(Object.keys(s.decisions.byHarness)).toEqual(["claude", "codex", "copilot"]);
    expect(s.decisions.byHarness.copilot).toMatchObject({ total: 2, deny: 2, shadowDiffs: 1 });
    expect(s.decisions.byTool.Bash).toMatchObject({ total: 1, deny: 1 });
    expect(s.decisions.byTool.Write?.total).toBe(4);
    expect(s.decisions.post).toMatchObject({ total: 1, allow: 1, p50: 5000, p95: 5000 });
    expect(s.logs).toEqual([]);
    expect(s.alarms).toEqual([]);
  });

  it("since filters the window", async () => {
    await writeJournal(repo.root, FIXTURE);
    const s = await collectStats(isolated({ since: "2026-10-12T00:00:00Z" }));
    expect(s.since).toBe("2026-10-12T00:00:00Z");
    expect(s.decisions.total).toBe(3);
    expect(Object.keys(s.decisions.byHarness)).toEqual(["codex", "copilot"]);
  });

  it("missing journal + record:true profile → decisions.empty; record:false → no alarm", async () => {
    expect((await collectStats(isolated())).decisions.total).toBe(0);
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(join(repo.root, ".axiom", "gate-profile.json"), '{"record":false}');
    expect((await collectStats(isolated())).alarms).toEqual([]);
    await writeFile(join(repo.root, ".axiom", "gate-profile.json"), '{"record":true}');
    expect((await collectStats(isolated())).alarms.map((a) => a.id)).toEqual(["decisions.empty"]);
  });
});

/** VS Code Insiders hook log line shapes (2026-10-14, see hooklog.test.ts), cwd = the root. */
function vscodeLog(root: string, opts: { other: number; gate: number; gateMs?: number }): string {
  const cwd = JSON.stringify({ fsPath: root });
  const lines: string[] = [];
  let id = 1;
  for (let i = 0; i < opts.other; i++, id++) {
    lines.push(
      `2026-10-14 01:43:28.080 [info] [#${id}] [PreToolUse] Running: {"command":"guard-tooluse.ps1","cwd":${cwd},"timeout":10}`,
      `2026-10-14 01:43:29.156 [info] [#${id}] [PreToolUse] Completed (Success) in 40ms`,
    );
  }
  for (let i = 0; i < opts.gate; i++, id++) {
    lines.push(
      `2026-10-14 01:44:00.000 [info] [#${id}] [PreToolUse] Running: {"command":"axiom gate --stdin","cwd":${cwd},"timeout":10}`,
      `2026-10-14 01:44:12.692 [info] [#${id}] [PreToolUse] Completed (${i === 0 ? "NonBlockingError" : "Success"}) in ${opts.gateMs ?? 100}ms`,
    );
  }
  // A run for another workspace never counts.
  lines.push(
    `2026-10-14 01:45:00.000 [info] [#${id}] [PreToolUse] Running: {"command":"axiom gate --stdin","cwd":{"fsPath":"/elsewhere"}}`,
  );
  return lines.join("\r\n");
}

describe("collectStats — VS Code hook log", () => {
  it("≥ 20 PreToolUse runs for the root and 0 gate runs → gate.silent", async () => {
    const f = join(home.root, "Hooks.log");
    await writeFile(f, vscodeLog(repo.root, { other: 20, gate: 0 }));
    const s = await collectStats(isolated({ hookLogs: [f] }));
    expect(s.logs).toEqual([
      {
        harness: "vscode",
        files: [f],
        hookRuns: 20,
        gateRuns: 0,
        silent: true,
        nonBlockingErrors: 0,
      },
    ]);
    expect(s.alarms.map((a) => [a.id, a.harness])).toEqual([["gate.silent", "vscode"]]);
  });

  it("19 runs is below the threshold", async () => {
    const f = join(home.root, "Hooks.log");
    await writeFile(f, vscodeLog(repo.root, { other: 19, gate: 0 }));
    const s = await collectStats(isolated({ hookLogs: [f] }));
    expect(s.logs[0]?.silent).toBe(false);
    expect(s.alarms).toEqual([]);
  });

  it("gate runs with a NonBlockingError and p95 over the budget → gate.nonBlocking + gate.slow", async () => {
    const f = join(home.root, "Hooks.log");
    await writeFile(f, vscodeLog(repo.root, { other: 3, gate: 2, gateMs: GATE_SLOW_P95_MS + 1 }));
    const s = await collectStats(isolated({ hookLogs: [f, join(home.root, "missing.log")] }));
    expect(s.logs[0]).toMatchObject({
      hookRuns: 5,
      gateRuns: 2,
      silent: false,
      nonBlockingErrors: 1,
      p95: GATE_SLOW_P95_MS + 1,
    });
    expect(s.alarms.map((a) => a.id)).toEqual(["gate.nonBlocking", "gate.slow"]);
  });

  it("finds the newest VS Code session log under home when hookLogs is not given", async () => {
    const dir = join(
      home.root,
      ".config",
      "Code",
      "logs",
      "20261014T080000",
      "window1",
      "exthost",
      "GitHub.copilot-chat",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "GitHub Copilot Chat Hooks.log"),
      vscodeLog(repo.root, { other: 0, gate: 3 }),
    );
    const { hookLogs: _drop, ...opts } = isolated();
    const s = await collectStats(opts);
    expect(s.logs[0]).toMatchObject({ harness: "vscode", gateRuns: 3 });
  });
});

/**
 * Real Copilot CLI `session-state/<id>/events.jsonl` lines (copilotVersion 1.0.92-4,
 * 2026-10-06), ids shortened, toolCalls elided, cwd replaced by the test root.
 */
function cliEvents(root: string, n: number, opts: { gateError?: boolean } = {}): string {
  const cwd = JSON.stringify(root);
  const lines: string[] = [
    `{"type":"hook.start","data":{"hookInvocationId":"s1","hookType":"sessionStart","input":{"source":"new","sessionId":"sid","timestamp":1791290235265,"cwd":${cwd}}},"id":"e0","timestamp":"2026-10-06T12:37:15.270Z","parentId":null}`,
  ];
  for (let i = 0; i < n; i++) {
    lines.push(
      `{"type":"hook.start","data":{"hookInvocationId":"p${i}","hookType":"preToolUse","input":{"sessionId":"sid","cwd":${cwd},"toolCalls":[]}},"id":"a${i}","timestamp":"2026-10-06T15:14:00.000Z","parentId":null}`,
    );
    const fail = opts.gateError === true && i === 0;
    lines.push(
      fail
        ? `{"type":"hook.end","data":{"hookInvocationId":"p${i}","hookType":"preToolUse","success":false,"output":{"toolu_01":"Denied by preToolUse hook from \\"E:_gh_codai_.github_hooks_axiom-gate.json\\" (hook errored)"},"error":{"message":"Error: spawn axiom ENOENT","source":"E:\\\\gh\\\\codai\\\\.github\\\\hooks\\\\axiom-gate.json"}},"id":"b${i}","timestamp":"2026-10-06T15:14:01.393Z","parentId":"a${i}"}`
        : `{"type":"hook.end","data":{"hookInvocationId":"p${i}","hookType":"preToolUse","success":true},"id":"b${i}","timestamp":"2026-10-06T15:14:00.250Z","parentId":"a${i}"}`,
    );
  }
  return lines.join("\n");
}

describe("collectStats — Copilot CLI session-state", () => {
  it("counts preToolUse invocations for the root and flags errored gate runs", async () => {
    const dir = join(home.root, ".copilot", "session-state");
    await mkdir(join(dir, "sid"), { recursive: true });
    await mkdir(join(dir, "other"), { recursive: true });
    await writeFile(
      join(dir, "sid", "events.jsonl"),
      cliEvents(repo.root, 25, { gateError: true }),
    );
    await writeFile(join(dir, "other", "events.jsonl"), cliEvents("/elsewhere", 30));
    const { copilotLogsDir: _drop, ...opts } = isolated();
    const s = await collectStats(opts);
    expect(s.logs).toEqual([
      {
        harness: "copilot-cli",
        files: [join(dir, "sid", "events.jsonl")],
        hookRuns: 25,
        gateRuns: 1,
        // Successful CLI invocations do not name the hook file: never "silent" from this log.
        silent: false,
        nonBlockingErrors: 1,
      },
    ]);
    expect(s.alarms.map((a) => [a.id, a.harness])).toEqual([["gate.nonBlocking", "copilot-cli"]]);
  });

  it("since excludes older invocations; no matching invocations → no log entry", async () => {
    const dir = join(home.root, "ss");
    await mkdir(join(dir, "sid"), { recursive: true });
    await writeFile(join(dir, "sid", "events.jsonl"), cliEvents(repo.root, 3));
    const late = await collectStats(
      isolated({ copilotLogsDir: dir, since: "2026-10-07T00:00:00Z" }),
    );
    expect(late.logs).toEqual([]);
    const early = await collectStats(
      isolated({ copilotLogsDir: dir, since: "2026-10-01T00:00:00Z" }),
    );
    expect(early.logs[0]?.hookRuns).toBe(3);
  });
});

describe("renderStats", () => {
  it("includes totals, codes, harness/tool breakdowns, logs and alarms", async () => {
    await writeJournal(repo.root, FIXTURE);
    const f = join(home.root, "Hooks.log");
    await writeFile(f, vscodeLog(repo.root, { other: 21, gate: 0 }));
    const lines = renderStats(await collectStats(isolated({ hookLogs: [f] })));
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[1]).toMatch(/\b5\b.*allow 2.*deny 3.*shadow 1.*30 ms.*40 ms/);
    expect(text).toContain("ERR_GATE_DENY_GLOB 2");
    expect(text).toMatch(/harness copilot: 2 /);
    expect(text).toMatch(/tool Bash: 1 /);
    expect(text).toMatch(/log vscode: 21 PreToolUse hook runs, 0 gate runs/);
    expect(text).toContain("ALARM gate.silent [vscode]");
  });

  it("empty result still renders a header and 'none' markers", async () => {
    const lines = renderStats(await collectStats(isolated()));
    expect(lines[1]).toMatch(/decisions: 0 /);
    expect(lines).toContain("harness logs: none found");
    expect(lines).toContain("alarms: none");
  });
});
