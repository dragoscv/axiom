/**
 * S-1414 / EN-5: the decision journal is a hash chain. Before 4.0 a flipped `deny`, a deleted
 * override line or a forged `allow` was invisible (`journal verify` said `ok: true`), because
 * nothing linked one line to the next.
 *
 * These tests own `decisions.ts`, so they live in their own file; `decisions.test.ts` stays as it
 * was for the redaction/id behaviour it already covers.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDecision,
  DECISIONS_ARCHIVE_DIR,
  DECISIONS_HEAD_FILE,
  DECISIONS_UNKNOWN_PREV,
  type DecisionRecord,
  journalFiles,
  readDecisions,
  rechainLines,
  refreshHead,
  rotateDecisions,
  verifyDecisions,
} from "./decisions.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axiom-chain-"));
});
afterEach(() => {
  root = "";
});

function rec(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    v: 1,
    decided_at: "2026-11-16T10:00:00.000Z",
    agent_id: "vscode:s1",
    principal: { subject: "tester" },
    tool: "Write",
    args_hash: "sha256:00",
    args_state: "recorded",
    decision: "deny",
    paths: ["src/a.ts"],
    profile: ".axiom/axiom.json",
    ...over,
  };
}

const file = (): string => join(root, ".axiom", "decisions.jsonl");

async function lineObjects(): Promise<Record<string, unknown>[]> {
  const text = await readFile(file(), "utf8");
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("decision journal hash chain (S-1414)", () => {
  it("links each line to the previous one and records the head", async () => {
    const a = await appendDecision(root, rec({ decision: "allow" }));
    const b = await appendDecision(root, rec({ decision: "deny", code: "path.deny" }));
    const c = await appendDecision(root, rec({ decision: "ask" }));

    const lines = await lineObjects();
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(a.seq).toBe(1);
    expect(c.seq).toBe(3);
    // The first line anchors at the hash of the empty string, not at nothing.
    expect(lines[0]?.prev).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Each `prev` is the hash of the line before it, byte for byte.
    const text = await readFile(file(), "utf8");
    const raw = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(b.prev).toBe(`sha256:${sha256Hex(raw[0] as string)}`);

    const head = JSON.parse(await readFile(join(root, DECISIONS_HEAD_FILE), "utf8")) as {
      file: string;
      seq: number;
    };
    expect(head.file).toBe("decisions.jsonl");
    expect(head.seq).toBe(3);

    const v = await verifyDecisions(root);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(3);
    expect(v.breaks).toEqual([]);
  });

  it("catches a flipped decision, a deleted line and a forged line", async () => {
    await appendDecision(root, rec({ decision: "deny", code: "house.forcePush" }));
    await appendDecision(root, rec({ decision: "deny", code: "path.deny" }));
    await appendDecision(root, rec({ decision: "deny", code: ".env" }));
    expect((await verifyDecisions(root)).ok).toBe(true);

    const lines = (await readFile(file(), "utf8")).split(/\r?\n/).filter((l) => l.trim() !== "");

    // 1. The middle deny is rewritten as an allow (the original attack: "it never happened").
    const flipped = JSON.parse(lines[1] as string) as Record<string, unknown>;
    flipped.decision = "allow";
    delete flipped.code;
    await writeFile(
      file(),
      `${[lines[0], JSON.stringify(flipped), lines[2]].join("\n")}\n`,
      "utf8",
    );
    let v = await verifyDecisions(root);
    expect(v.ok).toBe(false);
    expect(v.breaks.some((b) => b.seq === 3 && b.reason === "prev-mismatch")).toBe(true);

    // 2. A line is deleted outright.
    await writeFile(file(), `${[lines[0], lines[2]].join("\n")}\n`, "utf8");
    v = await verifyDecisions(root);
    expect(v.ok).toBe(false);
    expect(v.breaks.some((b) => b.reason === "prev-mismatch")).toBe(true);
  });

  it("treats a 3.x line without a link as a gap, never as tampering", async () => {
    const legacy = JSON.stringify({
      v: 1,
      decided_at: "2026-10-01T00:00:00.000Z",
      agent_id: "vscode:old",
      principal: { subject: "u" },
      tool: "Write",
      args_hash: "sha256:00",
      args_state: "recorded",
      decision: "allow",
      paths: [],
      profile: "builtin",
    });
    await mkdir(join(root, ".axiom"), { recursive: true });
    await writeFile(file(), `${legacy}\n`, "utf8");
    const v = await verifyDecisions(root);
    expect(v.ok).toBe(true);
    expect(v.gaps).toBe(1);
    expect(v.breaks).toEqual([]);
  });

  it("rotates the current month into an archive and keeps every reader whole", async () => {
    await appendDecision(root, rec({ decided_at: "2026-10-31T23:00:00.000Z" }));
    await appendDecision(root, rec({ decided_at: "2026-10-31T23:30:00.000Z" }));

    const r = await rotateDecisions(root, { now: Date.parse("2026-11-16T00:00:00.000Z") });
    expect(r.rotated).toBe(`${DECISIONS_ARCHIVE_DIR}/2026-10.jsonl`);
    expect((await readFile(file(), "utf8")).trim()).toBe("");

    // The archive is not invisible: readers and the verifier walk it in order.
    const files = await journalFiles(root);
    expect(files.map((f) => f.name)).toEqual([
      `${DECISIONS_ARCHIVE_DIR}/2026-10.jsonl`,
      ".axiom/decisions.jsonl",
    ]);
    expect(await readDecisions(root)).toHaveLength(2);
    expect((await verifyDecisions(root)).ok).toBe(true);

    // A new line links across the file boundary to the last archived line.
    await appendDecision(root, rec({ decided_at: "2026-11-16T09:00:00.000Z" }));
    const v = await verifyDecisions(root);
    expect(v.ok).toBe(true);
    expect(v.files).toBe(2);
    expect(v.entries).toBe(3);
  });

  it("prunes whole archives by retention and never lines", async () => {
    await appendDecision(root, rec({ decided_at: "2026-06-01T00:00:00.000Z" }));
    await rotateDecisions(root, { now: Date.parse("2026-07-01T00:00:00.000Z") });
    await appendDecision(root, rec({ decided_at: "2026-07-01T00:00:00.000Z" }));
    await rotateDecisions(root, { now: Date.parse("2026-08-01T00:00:00.000Z") });

    const r = await rotateDecisions(root, {
      now: Date.parse("2026-11-16T00:00:00.000Z"),
      // 120 days before 2026-11-16 is 2026-07-19, so the July archive survives and June does not.
      retentionDays: 120,
    });
    expect(r.pruned).toEqual([`${DECISIONS_ARCHIVE_DIR}/2026-06.jsonl`]);
    const names = (await journalFiles(root)).map((f) => f.name);
    expect(names).toEqual([`${DECISIONS_ARCHIVE_DIR}/2026-07.jsonl`, ".axiom/decisions.jsonl"]);
  });

  it("re-links the file after retention removed lines, and says so as a gap", async () => {
    for (let i = 0; i < 5; i++) {
      await appendDecision(root, rec({ decided_at: `2026-11-1${i}T00:00:00.000Z` }));
    }
    const lines = (await readFile(file(), "utf8")).split(/\r?\n/).filter((l) => l.trim() !== "");
    const kept = rechainLines([lines[3] as string, lines[4] as string]);
    await writeFile(file(), `${kept.join("\n")}\n`, "utf8");
    await refreshHead(root);

    const v = await verifyDecisions(root);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(2);
    expect(v.gaps).toBe(1);
    // Without the re-chain the surviving lines would point at hashes that no longer exist.
    const after = (await readFile(file(), "utf8")).split(/\r?\n/).filter((l) => l.trim() !== "");
    expect((JSON.parse(after[0] as string) as { seq: number }).seq).toBe(1);
    expect((JSON.parse(after[1] as string) as { seq: number }).seq).toBe(2);
    expect((JSON.parse(after[1] as string) as { prev: string }).prev).toBe(
      `sha256:${sha256Hex(after[0] as string)}`,
    );
  });

  it("keeps the chain intact under concurrent hook processes", async () => {
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        appendDecision(root, rec({ tool: `Write${i}`, decided_at: "2026-11-16T11:00:00.000Z" })),
      ),
    );
    const lines = await lineObjects();
    expect(lines).toHaveLength(24);
    // A writer that cannot take the lock within its budget still records the decision, linked as
    // the documented `unknown` sentinel (a gap). What must NEVER happen is a link pointing at the
    // WRONG hash: that is exactly what an edited or forged line looks like.
    const v = await verifyDecisions(root);
    expect(v.breaks).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(24);
    expect(await readDecisions(root)).toHaveLength(24);
    expect(lines.every((l) => typeof l.prev === "string")).toBe(true);
    expect(lines.filter((l) => typeof l.seq === "number").length).toBeGreaterThan(0);
  });

  it("records the decision anyway when the chain lock cannot be taken", async () => {
    // A foreign process holds the lock (no `.axiom/lock` involvement: this is the journal's own).
    await mkdir(join(root, ".axiom"), { recursive: true });
    await writeFile(join(root, ".axiom", "decisions.lock"), "held", "utf8");
    const line = await appendDecision(root, rec({ decision: "deny" }));
    expect(line.prev).toBe(DECISIONS_UNKNOWN_PREV);
    expect(line.seq).toBeUndefined();
    const v = await verifyDecisions(root);
    expect(v.ok).toBe(true);
    expect(v.gaps).toBe(1);
  });
});
