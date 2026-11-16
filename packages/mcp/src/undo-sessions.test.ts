/**
 * Contract 6 (journal/undo): `syntheticSessionId` and `listUndoSessions`. Own file so the journal
 * writer's `undo.test.ts` stays theirs; the functions live in `undo.ts`.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpRepo } from "./test-helpers.js";
import {
  captureTreeUndo,
  captureUndo,
  journalSessionsMain,
  listUndoSessions,
  syntheticSessionId,
  undoSession,
} from "./undo.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;

beforeEach(async () => {
  repo = await tmpRepo("axiom-undo-sessions-");
  await mkdir(join(repo.root, ".git"));
});
afterEach(async () => {
  await repo.cleanup();
});

const at = (iso: string): number => Date.parse(iso);

describe("syntheticSessionId (contract 6)", () => {
  it("is auto-<yyyymmdd>-<8 hex>, with the date in UTC", () => {
    const id = syntheticSessionId("copilot:s1", "E:/repo", new Date("2026-10-19T10:00:00Z"));
    expect(id).toMatch(/^auto-20261019-[0-9a-f]{8}$/);
    // 2026-01-01T00:30+02:00 is 2025-12-31T22:30Z: a naive local-date stamp would read 20260101.
    expect(syntheticSessionId("a", "b", new Date("2026-01-01T00:30:00+02:00"))).toMatch(
      /^auto-20251231-/,
    );
  });

  it("is stable for an agent in a checkout and different for another checkout or agent", () => {
    const day = new Date("2026-10-19T23:59:00Z");
    const a = syntheticSessionId("copilot:s1", "E:/repo", day);
    expect(syntheticSessionId("copilot:s1", "E:/repo", day)).toBe(a);
    expect(syntheticSessionId("copilot:s1", "E:/other", day)).not.toBe(a);
    expect(syntheticSessionId("copilot:s2", "E:/repo", day)).not.toBe(a);
  });
});

describe("listUndoSessions (contract 6)", () => {
  it("groups captured pre-images per (agent, session), oldest first, with the span and the count", async () => {
    await writeFile(join(repo.root, "a.ts"), "one");
    await captureUndo(repo.root, {
      agentId: "copilot:s2",
      sessionId: "s2",
      tool: "create_file",
      targets: [{ relPath: "a.ts", op: "write" }],
      now: at("2026-10-19T12:00:00.000Z"),
    });
    await writeFile(join(repo.root, "a.ts"), "two");
    await captureUndo(repo.root, {
      agentId: "copilot:s1",
      sessionId: "s1",
      tool: "create_file",
      targets: [{ relPath: "a.ts", op: "write" }],
      now: at("2026-10-19T10:00:00.000Z"),
    });
    await writeFile(join(repo.root, "a.ts"), "three");
    await captureUndo(repo.root, {
      agentId: "copilot:s1",
      sessionId: "s1",
      tool: "create_file",
      targets: [{ relPath: "a.ts", op: "write" }],
      now: at("2026-10-19T11:00:00.000Z"),
    });

    const rows = await listUndoSessions(repo.root);
    expect(rows.map((r) => [r.agentId, r.session, r.files])).toEqual([
      ["copilot:s1", "s1", 2],
      ["copilot:s2", "s2", 1],
    ]);
    expect(rows[0]?.first).toBe("2026-10-19T10:00:00.000Z");
    expect(rows[0]?.last).toBe("2026-10-19T11:00:00.000Z");
    expect(rows[1]?.first).toBe(rows[1]?.last);
  });

  it("lists a capture that named no session under its synthetic id, and is empty without a store", async () => {
    await writeFile(join(repo.root, "b.ts"), "x");
    await captureUndo(repo.root, {
      agentId: "copilot:s9",
      tool: "create_file",
      targets: [{ relPath: "b.ts", op: "write" }],
      now: at("2026-10-19T09:00:00.000Z"),
    });
    const rows = await listUndoSessions(repo.root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe("copilot:s9");
    expect(rows[0]?.session).toMatch(/^auto-\d{8}-[0-9a-f]{8}$/);
    expect(await listUndoSessions(join(repo.root, "..", "nowhere"))).toEqual([]);
  });

  it("`journal sessions` prints ASCII rows, JSON with --json and 2 on a bad flag", async () => {
    await writeFile(join(repo.root, "c.ts"), "x");
    await captureUndo(repo.root, {
      agentId: "copilot:s1",
      sessionId: "s1",
      tool: "create_file",
      targets: [{ relPath: "c.ts", op: "write" }],
      now: at("2026-10-19T10:00:00.000Z"),
    });
    const out: string[] = [];
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) };
    expect(await journalSessionsMain(["--root", repo.root], io)).toBe(0);
    expect(out.join("\n")).toContain("s1  copilot:s1");
    expect(out.every((l) => /^[\x20-\x7e]*$/.test(l))).toBe(true);

    out.length = 0;
    expect(await journalSessionsMain(["--root", repo.root, "--json"], io)).toBe(0);
    const doc = JSON.parse(out.join("\n")) as { sessions: { session: string; files: number }[] };
    expect(doc.sessions[0]).toMatchObject({ session: "s1", files: 1 });

    out.length = 0;
    expect(await journalSessionsMain(["--nope"], io)).toBe(2);
    expect(out.join("\n")).toContain("axiom journal sessions");
  });
});

describe("captureTreeUndo (contract 6)", () => {
  it("snapshots a directory before a recursive delete, bounded, and records what it left out", async () => {
    await mkdir(join(repo.root, "tree", "sub"), { recursive: true });
    await writeFile(join(repo.root, "tree", "a.ts"), "a");
    await writeFile(join(repo.root, "tree", "sub", "b.ts"), "b");
    await writeFile(join(repo.root, "tree", "sub", "c.ts"), "c");

    const all = await captureTreeUndo(repo.root, {
      agentId: "copilot:s3",
      sessionId: "s3",
      tool: "Remove-Item",
      relDirs: ["tree"],
      now: at("2026-10-19T08:00:00.000Z"),
    });
    expect(all).toEqual({ files: 3, bytes: 3, skipped: 0 });

    const bounded = await captureTreeUndo(repo.root, {
      agentId: "copilot:s4",
      sessionId: "s4",
      tool: "Remove-Item",
      relDirs: ["tree"],
      maxFiles: 1,
      now: at("2026-10-19T08:30:00.000Z"),
    });
    expect(bounded.files).toBe(1);
    expect(bounded.skipped).toBeGreaterThan(0);
    expect(bounded.reason).toBe("maxFiles");

    // The command the snapshot preceded deleted the captured file; the truncated directory was
    // never captured, so `undoSession` must restore one and report the other as a skip.
    await rm(join(repo.root, "tree", "a.ts"), { force: true });
    const undone = await undoSession(repo.root, { agent: "copilot:s4", dryRun: true });
    expect(undone.items.some((i) => i.action === "skip" && i.reason === "toolarge")).toBe(true);
    expect(undone.items.some((i) => i.action === "restore")).toBe(true);
  });
});
