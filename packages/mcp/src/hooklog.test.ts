import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findHookLogs,
  HOOK_LOG_FILE,
  hookLogRoots,
  parseHookLog,
  parseHookRuns,
  readHookLogStats,
  readTail,
  runsForRoot,
} from "./hooklog.js";
import { tmpRepo } from "./test-helpers.js";

let home: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  home = await tmpRepo("axiom-hooklog-");
});
afterEach(async () => {
  await home.cleanup();
});

// Real VS Code Insiders lines (2026-10-14), cwd elided.
const SAMPLE = [
  '2026-10-14 01:43:28.080 [info] [#2879] [PreToolUse] Running: {"command":"& ./.github/hooks/axiom-gate.ps1","cwd":{"$mid":1},"timeout":10}',
  "2026-10-14 01:43:29.156 [info] [#2879] [PreToolUse] Completed (Success) in 1092ms",
  '2026-10-14 01:43:29.156 [info] [#2879] [PreToolUse] Output: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}',
  '2026-10-14 01:44:00.000 [info] [#3056] [PreToolUse] Running: {"command":"axiom gate --stdin","timeout":10}',
  "2026-10-14 01:44:12.692 [info] [#3056] [PreToolUse] Completed (NonBlockingError) in 12692ms, no output",
].join("\r\n");

describe("parseHookLog", () => {
  it("counts axiom runs, denies, NonBlockingError and timeouts from the real sample", () => {
    expect(parseHookLog(SAMPLE)).toEqual({
      runs: 2,
      p50: 1092,
      p95: 12692,
      nonBlockingErrors: 1,
      denies: 1,
      timeouts: 1,
      preToolUseRuns: 2,
    });
  });

  it("attributes Completed/Output to the most recent Running of the same id", () => {
    const text = [
      '[#7] [PreToolUse] Running: {"command":"guard-tooluse.ps1","timeout":5}',
      "[#7] [PreToolUse] Completed (Success) in 30ms",
      '[#7] [PreToolUse] Running: {"command":"axiom-hook gate --stdin --format copilot","timeout":5}',
      '[#8] [PreToolUse] Running: {"command":"other.sh"}',
      "[#7] [PreToolUse] Completed (Success) in 70ms",
      '[#7] [PreToolUse] Output: {"permissionDecision":"deny"}',
      '[#8] [PreToolUse] Output: {"permissionDecision":"deny"}',
    ].join("\n");
    const runs = parseHookRuns(text);
    expect(runs.map((r) => [r.command, r.ms, r.denied])).toEqual([
      ["guard-tooluse.ps1", 30, false],
      ["axiom-hook gate --stdin --format copilot", 70, true],
      ["other.sh", undefined, true],
    ]);
    expect(parseHookLog(text)).toMatchObject({ runs: 1, p50: 70, denies: 1, timeouts: 0 });
  });

  it("ignores non-axiom hooks, unmatched lines and orphan Completed lines", () => {
    const text = [
      "garbage",
      "[#1] [PreToolUse] Completed (Success) in 5ms",
      '[#2] [PreToolUse] Running: {"command":"npx prettier"}',
      "[#2] [PreToolUse] Completed (Success) in 5ms",
    ].join("\n");
    expect(parseHookLog(text)).toEqual({
      runs: 0,
      p50: 0,
      p95: 0,
      nonBlockingErrors: 0,
      denies: 0,
      timeouts: 0,
      preToolUseRuns: 1,
    });
  });

  it("reads the workspace from cwd.fsPath and filters runs by root (case-insensitive)", () => {
    const text = [
      '[#1] [PreToolUse] Running: {"command":"hook-pre.ps1","cwd":{"fsPath":"e:\\\\gh\\\\a"}}',
      '[#2] [PreToolUse] Running: {"command":"hook-pre.ps1","cwd":{"fsPath":"e:\\\\gh\\\\b"}}',
      '[#3] [PreToolUse] Running: {"command":"hook-pre.ps1"}',
    ].join("\n");
    const runs = parseHookRuns(text);
    expect(runs.map((r) => r.cwd)).toEqual(["e:\\gh\\a", "e:\\gh\\b", undefined]);
    // Runs without a cwd are always kept; on win32 the match is case-insensitive.
    const kept = runsForRoot(runs, "E:\\gh\\A\\").map((r) => r.id);
    expect(kept).toContain("3");
    expect(kept).not.toContain("2");
    if (process.platform === "win32") expect(kept).toEqual(["1", "3"]);
  });

  it("a non-JSON Running payload keeps the raw command text", () => {
    const runs = parseHookRuns("[#3] [PreToolUse] Running: axiom gate --stdin");
    expect(runs[0]?.command).toBe("axiom gate --stdin");
    expect(runs[0]?.timeoutSec).toBeUndefined();
  });
});

describe("findHookLogs / readTail", () => {
  it("per-platform logs roots", () => {
    expect(hookLogRoots({ home: "/h", platform: "linux" })).toEqual([
      join("/h", ".config", "Code", "logs"),
      join("/h", ".config", "Code - Insiders", "logs"),
    ]);
    expect(hookLogRoots({ home: "/h", platform: "darwin" })[0]).toBe(
      join("/h", "Library", "Application Support", "Code", "logs"),
    );
    expect(hookLogRoots({ home: "/h", appData: "/ad", platform: "win32" })[1]).toBe(
      join("/ad", "Code - Insiders", "logs"),
    );
  });

  it("returns only the newest session's window logs", async () => {
    const logs = join(home.root, ".config", "Code", "logs");
    const mk = async (session: string, window: string) => {
      const dir = join(logs, session, window, "exthost", "GitHub.copilot-chat");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, HOOK_LOG_FILE), SAMPLE);
      return join(dir, HOOK_LOG_FILE);
    };
    await mk("20261013T080000", "window1");
    const a = await mk("20261014T080000", "window1");
    const b = await mk("20261014T080000", "window2");
    await mkdir(join(logs, "20261014T080000", "window3"), { recursive: true });
    expect(await findHookLogs({ home: home.root, platform: "linux" })).toEqual([a, b]);
    expect(await findHookLogs({ home: join(home.root, "none"), platform: "linux" })).toEqual([]);
    expect((await readHookLogStats([a, b, join(home.root, "missing.log")])).runs).toBe(4);
  });

  it("reads only the tail and drops the partial first line", async () => {
    const f = join(home.root, "big.log");
    await writeFile(f, "aaaaaaaaaa\nbbbb\ncccc\n");
    expect(await readTail(f, 8)).toBe("cccc\n");
    expect(await readTail(f)).toBe("aaaaaaaaaa\nbbbb\ncccc\n");
  });
});
