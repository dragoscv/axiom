import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import * as path from "node:path";
import { AxiomError, type DigestRef, type Journal } from "@codai/axiom-schema";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendChainEntry,
  assertChain,
  CHAIN_GENESIS,
  chainPath,
  journalStatus,
  newJournal,
  readHistory,
  recordTerminal,
  serializeChainEntry,
  setPhase,
  verifyChain,
  writeJournal,
} from "./journal.js";
import { mkRoot } from "./test-helpers.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const r = await mkRoot();
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

function dg(n: number): DigestRef {
  return `sha256:${createHash("sha256").update(`m${n}`).digest("hex")}`;
}

async function seed(r: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await appendChainEntry(r, { manifestDigest: dg(i), state: "committed", files: i });
  }
}

async function lines(r: string): Promise<string[]> {
  const raw = await fs.readFile(chainPath(r), "utf8");
  return raw.split("\n").slice(0, -1);
}

async function writeLines(r: string, ls: string[], trailing = true): Promise<void> {
  await fs.mkdir(path.dirname(chainPath(r)), { recursive: true });
  await fs.writeFile(chainPath(r), ls.join("\n") + (trailing && ls.length > 0 ? "\n" : ""));
}

async function catchCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AxiomError ? err.code : "not-axiom";
  }
}

describe("journal chain (S-706)", () => {
  it("a root without chain.jsonl verifies ok with 0 entries", async () => {
    const r = await root();
    const v = await verifyChain(r);
    expect(v).toEqual({ ok: true, entries: 0, head: CHAIN_GENESIS, missing: [] });
  });

  it("append 3 → verify ok, seq 1..3, prev links, genesis prev", async () => {
    const r = await root();
    await seed(r, 3);
    const v = await verifyChain(r);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(3);
    expect(v.firstBad).toBeUndefined();
    const ls = await lines(r);
    const parsed = ls.map((l) => JSON.parse(l) as { seq: number; prev: string });
    expect(parsed.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(parsed[0]?.prev).toBe(CHAIN_GENESIS);
    const h = (s: string) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
    expect(parsed[1]?.prev).toBe(h(ls[0] ?? ""));
    expect(parsed[2]?.prev).toBe(h(ls[1] ?? ""));
    expect(v.head).toBe(h(ls[2] ?? ""));
    expect(Object.keys(JSON.parse(ls[0] ?? "{}"))).toEqual([
      "seq",
      "manifestDigest",
      "state",
      "at",
      "prev",
      "files",
    ]);
  });

  it("editing a middle line → prev-mismatch at the next seq; assertChain throws ERR_JOURNAL_CHAIN", async () => {
    const r = await root();
    await seed(r, 3);
    const ls = await lines(r);
    ls[1] = (ls[1] ?? "").replace('"files":2', '"files":9');
    await writeLines(r, ls);
    const v = await verifyChain(r);
    expect(v.ok).toBe(false);
    expect(v.firstBad).toEqual({ seq: 3, reason: "prev-mismatch" });
    expect(v.entries).toBe(2);
    expect(await catchCode(assertChain(r))).toBe("ERR_JOURNAL_CHAIN");
  });

  it("deleting a line → seq-gap", async () => {
    const r = await root();
    await seed(r, 3);
    const ls = await lines(r);
    await writeLines(r, [ls[0] ?? "", ls[2] ?? ""]);
    expect((await verifyChain(r)).firstBad).toEqual({ seq: 2, reason: "seq-gap" });
  });

  it("reordering lines → detected", async () => {
    const r = await root();
    await seed(r, 3);
    const ls = await lines(r);
    await writeLines(r, [ls[0] ?? "", ls[2] ?? "", ls[1] ?? ""]);
    const v = await verifyChain(r);
    expect(v.ok).toBe(false);
    expect(v.firstBad?.seq).toBe(2);
  });

  it("truncated last line (crash mid-write) → parse at that seq; append refuses", async () => {
    const r = await root();
    await seed(r, 3);
    const raw = await fs.readFile(chainPath(r), "utf8");
    await fs.writeFile(chainPath(r), raw.slice(0, raw.length - 10));
    const v = await verifyChain(r);
    expect(v.firstBad).toEqual({ seq: 3, reason: "parse" });
    expect(v.entries).toBe(2);
    expect(
      await catchCode(appendChainEntry(r, { manifestDigest: dg(9), state: "committed", files: 0 })),
    ).toBe("ERR_JOURNAL_CHAIN");
  });

  it("a complete last line missing only its newline is treated as torn (parse)", async () => {
    const r = await root();
    await seed(r, 2);
    const raw = await fs.readFile(chainPath(r), "utf8");
    await fs.writeFile(chainPath(r), raw.slice(0, -1));
    expect((await verifyChain(r)).firstBad).toEqual({ seq: 2, reason: "parse" });
  });

  it("missing journal files are listed, not fatal", async () => {
    const r = await root();
    const j = newJournal(dg(1), [{ path: "a.txt", op: "create", done: true }]);
    await writeJournal(r, { ...j, phase: "committed" });
    await seed(r, 2);
    const v = await verifyChain(r);
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([dg(2)]);
  });

  it("property: any single-byte edit, line deletion or reorder is detected", async () => {
    const r = await root();
    await seed(r, 4);
    const original = await fs.readFile(chainPath(r));
    const ls = await lines(r);
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({
            kind: fc.constant("byte" as const),
            // exclude the final line: only an external anchor (head) protects it
            at: fc.nat({ max: original.length - (ls[3]?.length ?? 0) - 2 }),
            xor: fc.integer({ min: 1, max: 255 }),
          }),
          fc.record({ kind: fc.constant("delete" as const), i: fc.nat({ max: 2 }) }),
          fc.record({
            kind: fc.constant("swap" as const),
            i: fc.nat({ max: 3 }),
            j: fc.nat({ max: 3 }),
          }),
        ),
        async (m) => {
          if (m.kind === "byte") {
            const b = Buffer.from(original);
            b[m.at] = (b[m.at] ?? 0) ^ m.xor;
            await fs.writeFile(chainPath(r), b);
          } else if (m.kind === "delete") {
            await writeLines(
              r,
              ls.filter((_, k) => k !== m.i),
            );
          } else {
            fc.pre(m.i !== m.j);
            const c = [...ls];
            const t = c[m.i] ?? "";
            c[m.i] = c[m.j] ?? "";
            c[m.j] = t;
            await writeLines(r, c);
          }
          const v = await verifyChain(r);
          expect(v.ok).toBe(false);
          expect(v.firstBad).toBeDefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("recordTerminal maps committed/rolled-back, skips non-terminal, forces failed with code", async () => {
    const r = await root();
    const j: Journal = newJournal(dg(1), [
      { path: "a.txt", op: "create", done: true },
      { path: "b.txt", op: "delete", done: true },
    ]);
    expect(await recordTerminal(r, j)).toBeUndefined();
    const c = await recordTerminal(r, { ...j, phase: "committed" });
    expect(c).toMatchObject({ seq: 1, state: "committed", files: 2, manifestDigest: dg(1) });
    const rb = await recordTerminal(r, { ...j, manifestDigest: dg(2), phase: "rolled-back" });
    expect(rb?.state).toBe("rolled-back");
    const f = await recordTerminal(
      r,
      { ...j, manifestDigest: dg(3), phase: "committing" },
      { state: "failed", code: "ERR_ROLLBACK" },
    );
    expect(f).toMatchObject({ seq: 3, state: "failed", code: "ERR_ROLLBACK" });
    expect((await verifyChain(r)).entries).toBe(3);
  });

  it("an unknown error code in a line is a parse fault", async () => {
    const r = await root();
    const line = serializeChainEntry({
      seq: 1,
      manifestDigest: dg(1),
      state: "failed",
      at: new Date().toISOString(),
      prev: CHAIN_GENESIS,
      files: 0,
      code: "ERR_NOPE",
    });
    await writeLines(r, [line]);
    expect((await verifyChain(r)).firstBad).toEqual({ seq: 1, reason: "parse" });
  });
});

describe("readHistory", () => {
  it("newest-first, honours limit, joins journal + manifest name", async () => {
    const r = await root();
    const j = newJournal(dg(3), [{ path: "src/x.ts", op: "overwrite", done: true }]);
    await writeJournal(r, { ...j, phase: "committed" });
    await fs.mkdir(path.join(r, ".axiom", "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(r, ".axiom", "manifests", `${dg(3).slice(7)}.json`),
      JSON.stringify({ manifest: { name: "demo" } }),
    );
    await seed(r, 3);
    const all = await readHistory(r);
    expect(all.map((h) => h.seq)).toEqual([3, 2, 1]);
    expect(all[0]).toMatchObject({
      name: "demo",
      journalPresent: true,
      fileList: [{ path: "src/x.ts", op: "overwrite" }],
    });
    expect(all[1]?.journalPresent).toBe(false);
    const two = await readHistory(r, { limit: 2 });
    expect(two.map((h) => h.seq)).toEqual([3, 2]);
    expect(await readHistory(r, { limit: 0 })).toEqual([]);
  });

  it("empty root → []", async () => {
    expect(await readHistory(await root())).toEqual([]);
  });

  it("picks up the error code from the applied marker", async () => {
    const r = await root();
    await appendChainEntry(r, { manifestDigest: dg(1), state: "rolled-back", files: 1 });
    await fs.mkdir(path.join(r, ".axiom", "applied"), { recursive: true });
    await fs.writeFile(
      path.join(r, ".axiom", "applied", `${dg(1).slice(7)}.json`),
      JSON.stringify({ error: { code: "ERR_PREIMAGE_CHANGED", message: "x" } }),
    );
    const [h] = await readHistory(r);
    expect(h?.code).toBe("ERR_PREIMAGE_CHANGED");
  });
});

describe("journalStatus", () => {
  it("lists interrupted journals and the last committed entry", async () => {
    const r = await root();
    const j = newJournal(dg(7), [
      { path: "a", op: "create", done: true },
      { path: "b", op: "create", done: false },
    ]);
    await writeJournal(r, j);
    await setPhase(r, j, "committing");
    await writeJournal(r, { ...newJournal(dg(8), []), phase: "committed" });
    await seed(r, 2);
    await appendChainEntry(r, { manifestDigest: dg(5), state: "rolled-back", files: 0 });
    const s = await journalStatus(r);
    expect(s.interrupted).toHaveLength(1);
    expect(s.interrupted[0]).toMatchObject({
      manifestDigest: dg(7),
      phase: "committing",
      files: 2,
      done: 1,
    });
    expect(s.lastApplied).toMatchObject({ seq: 2, manifestDigest: dg(2), state: "committed" });
    expect(s.corrupt).toEqual([]);
  });

  it("clean root → nothing interrupted, no lastApplied", async () => {
    const s = await journalStatus(await root());
    expect(s.interrupted).toEqual([]);
    expect(s.lastApplied).toBeUndefined();
  });
});
