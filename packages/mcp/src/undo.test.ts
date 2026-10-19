import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { casHas } from "@codai/axiom-plan";
import { type AxiomError, isAxiomError } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSessionWrite } from "./session-guard.js";
import { tmpRepo } from "./test-helpers.js";
import {
  captureOutsideUndo,
  captureUndo,
  pruneUndo,
  undoLiveDigests,
  undoSession,
} from "./undo.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-undo-");
});
afterEach(async () => {
  await repo.cleanup();
});

const A = "claude:sess-A";
const B = "copilot:sess-B";

function abs(rel: string): string {
  return path.join(repo.root, ...rel.split("/"));
}
async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), content);
}
async function read(rel: string): Promise<string | undefined> {
  try {
    return await readFile(abs(rel), "utf8");
  } catch {
    return undefined;
  }
}
async function capture(agentId: string, rel: string, op: "write" | "delete", now: number) {
  await captureUndo(repo.root, {
    agentId,
    sessionId: agentId.split(":")[1] ?? agentId,
    tool: "Edit",
    targets: [{ relPath: rel, op }],
    now,
  });
}

/** A modifies m.txt twice, deletes d.txt, creates c.txt. */
async function scenario(): Promise<void> {
  await put("m.txt", "original m");
  await put("dir/d.txt", "original d");
  await capture(A, "m.txt", "write", 1000);
  await put("m.txt", "A edit 1");
  await capture(A, "m.txt", "write", 2000);
  await put("m.txt", "A edit 2");
  await capture(A, "dir/d.txt", "delete", 3000);
  await rm(abs("dir/d.txt"));
  await capture(A, "c.txt", "write", 4000);
  await put("c.txt", "created by A");
}

describe("captureUndo", () => {
  it("stores pre-images in the CAS and appends one line per target", async () => {
    await put("m.txt", "original m");
    await capture(A, "m.txt", "write", 1000);
    await capture(A, "new.txt", "write", 1001);
    expect(await casHas(repo.root, sha256Hex("original m"))).toBe(true);
    const logs = await readdir(path.join(repo.root, ".axiom", "undo"));
    expect(logs).toEqual([`${sha256Hex(A).slice(0, 16)}.jsonl`]);
    const lines = (await readFile(path.join(repo.root, ".axiom", "undo", logs[0] ?? ""), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pre: string; path: string; v: number });
    expect(lines.map((l) => [l.v, l.path, l.pre])).toEqual([
      [1, "m.txt", `sha256:${sha256Hex("original m")}`],
      [1, "new.txt", "absent"],
    ]);
  });

  it("never throws on an escaping path", async () => {
    await expect(capture(A, "../outside.txt", "write", 1)).resolves.toBeUndefined();
    expect(
      await stat(path.join(repo.root, ".axiom", "undo")).catch(() => undefined),
    ).toBeUndefined();
  });
});

describe("undoSession", () => {
  it("restores modified, recreates deleted, deletes created", async () => {
    await scenario();
    const r = await undoSession(repo.root, { agent: A });
    expect(r.dryRun).toBe(false);
    expect(r.agentId).toBe(A);
    expect(r.items.map((i) => [i.path, i.action])).toEqual([
      ["c.txt", "delete"],
      ["dir/d.txt", "restore"],
      ["m.txt", "restore"],
    ]);
    expect(r.restored).toBe(3);
    expect(r.conflicts).toBe(0);
    expect(await read("m.txt")).toBe("original m");
    expect(await read("dir/d.txt")).toBe("original d");
    expect(await read("c.txt")).toBeUndefined();
    // second run: everything already at its pre-image
    const again = await undoSession(repo.root, { agent: "sess-A" });
    expect(again.items.every((i) => i.action === "skip" && i.reason === "unchanged")).toBe(true);
  });

  it("dry-run writes nothing", async () => {
    await scenario();
    const r = await undoSession(repo.root, { agent: "sess-A", dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.restored).toBe(3);
    expect(await read("m.txt")).toBe("A edit 2");
    expect(await read("c.txt")).toBe("created by A");
    expect(await read("dir/d.txt")).toBeUndefined();
  });

  it("a later write by another agent → skip/conflict; force restores", async () => {
    await scenario();
    await capture(B, "m.txt", "write", 5000);
    await put("m.txt", "B edit");
    const r = await undoSession(repo.root, { agent: A });
    const m = r.items.find((i) => i.path === "m.txt");
    expect(m?.action).toBe("skip");
    expect(m?.reason).toBe("conflict");
    expect(r.conflicts).toBe(1);
    expect(await read("m.txt")).toBe("B edit");
    const f = await undoSession(repo.root, { agent: A, force: true });
    expect(f.items.find((i) => i.path === "m.txt")?.action).toBe("restore");
    expect(await read("m.txt")).toBe("original m");
  });

  it("a later foreign write seen only by the session-guard writers map is a conflict", async () => {
    await put("m.txt", "v0");
    await capture(A, "m.txt", "write", 1000);
    await put("m.txt", "A");
    await recordSessionWrite({
      root: repo.root,
      sessionId: "sess-B",
      agentId: B,
      tool: "Edit",
      targets: [{ relPath: "m.txt", op: "write", whole: false }],
      now: Date.now(),
    });
    const r = await undoSession(repo.root, { agent: A });
    expect(r.items[0]?.reason).toBe("conflict");
  });

  it("missing blob → skip/missing-blob; --since filters; unknown agent → ERR_NOT_FOUND", async () => {
    await scenario();
    await rm(path.join(repo.root, ".axiom", "cas"), { recursive: true, force: true });
    const r = await undoSession(repo.root, { agent: A, dryRun: true });
    expect(r.items.find((i) => i.path === "m.txt")?.reason).toBe("missing-blob");
    const since = await undoSession(repo.root, {
      agent: A,
      dryRun: true,
      since: new Date(3500).toISOString(),
    });
    expect(since.items.map((i) => i.path)).toEqual(["c.txt"]);
    for (const o of [{ agent: "nobody" }, { agent: A, since: "not a date" }]) {
      try {
        await undoSession(repo.root, o);
        throw new Error("expected AxiomError");
      } catch (err) {
        expect(isAxiomError(err)).toBe(true);
        expect((err as AxiomError).code).toBe(
          o.agent === "nobody" ? "ERR_NOT_FOUND" : "ERR_INVALID_PLAN",
        );
      }
    }
  });
});

describe("undo TTL", () => {
  it("live digests and prune respect the ttl", async () => {
    await put("old.txt", "old pre");
    await put("new.txt", "new pre");
    await capture(A, "old.txt", "write", 1000);
    await capture(B, "new.txt", "write", 9000);
    const live = await undoLiveDigests(repo.root, { ttlMs: 5000, now: 10_000 });
    expect([...live]).toEqual([sha256Hex("new pre")]);
    const dry = await pruneUndo(repo.root, { ttlMs: 5000, now: 10_000, dryRun: true });
    expect(dry).toEqual({ removedLines: 1, removedFiles: 1 });
    expect(await readdir(path.join(repo.root, ".axiom", "undo"))).toHaveLength(2);
    const real = await pruneUndo(repo.root, { ttlMs: 5000, now: 10_000 });
    expect(real).toEqual({ removedLines: 1, removedFiles: 1 });
    expect(await readdir(path.join(repo.root, ".axiom", "undo"))).toEqual([
      `${sha256Hex(B).slice(0, 16)}.jsonl`,
    ]);
  });
});

describe("outside-root undo (I-20)", () => {
  let out: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    out = await tmpRepo("axiom-undo-out-");
  });
  afterEach(async () => {
    await out.cleanup();
  });
  const o = (name: string) => path.join(out.root, name);
  const outside = (agentId: string, absPaths: string[], now: number) =>
    captureOutsideUndo(repo.root, {
      agentId,
      sessionId: agentId.split(":")[1] ?? agentId,
      tool: "Write",
      absPaths,
      now,
    });

  it("captures into the root CAS and undo restores modified + deletes created outside files", async () => {
    await writeFile(o("cfg.json"), "outside original");
    await outside(A, [o("cfg.json"), o("new.txt"), o("cfg.json")], 1000);
    await put("m.txt", "in v0");
    await capture(A, "m.txt", "write", 1001);
    expect(await casHas(repo.root, sha256Hex("outside original"))).toBe(true);
    await writeFile(o("cfg.json"), "outside changed");
    await writeFile(o("new.txt"), "created outside");
    await put("m.txt", "in v1");
    const r = await undoSession(repo.root, { agent: A });
    const fwd = (p: string) => path.resolve(p).replace(/\\/g, "/");
    expect(r.items.filter((i) => i.outside).map((i) => [i.path, i.action])).toEqual([
      [fwd(o("cfg.json")), "restore"],
      [fwd(o("new.txt")), "delete"],
    ]);
    expect(r.restored).toBe(3);
    expect(await readFile(o("cfg.json"), "utf8")).toBe("outside original");
    expect(await stat(o("new.txt")).catch(() => undefined)).toBeUndefined();
    expect(await read("m.txt")).toBe("in v0");
  });

  it("ignores in-root and relative paths; never throws", async () => {
    await outside(A, [abs("inside.txt"), "rel.txt", repo.root], 1);
    expect(
      await stat(path.join(repo.root, ".axiom", "undo")).catch(() => undefined),
    ).toBeUndefined();
  });

  it("a later outside write by another agent is a conflict; force restores", async () => {
    await writeFile(o("x.txt"), "v0");
    await outside(A, [o("x.txt")], 1000);
    await writeFile(o("x.txt"), "A");
    await outside(B, [o("x.txt")], 2000);
    await writeFile(o("x.txt"), "B");
    const r = await undoSession(repo.root, { agent: A });
    expect(r.items[0]).toMatchObject({ action: "skip", reason: "conflict", outside: true });
    expect(await readFile(o("x.txt"), "utf8")).toBe("B");
    await undoSession(repo.root, { agent: A, force: true });
    expect(await readFile(o("x.txt"), "utf8")).toBe("v0");
  });

  it("a forged log line with a relative path flagged outside, or an absolute in-root line, is ignored", async () => {
    await mkdir(path.join(repo.root, ".axiom", "undo"), { recursive: true });
    const bad = [
      {
        v: 1,
        at: 1,
        agentId: A,
        tool: "Write",
        path: "../escape.txt",
        pre: "absent",
        outside: true,
      },
      { v: 1, at: 1, agentId: A, tool: "Write", path: o("y.txt"), pre: "absent" },
    ];
    await writeFile(
      path.join(repo.root, ".axiom", "undo", `${sha256Hex(A).slice(0, 16)}.jsonl`),
      `${bad.map((b) => JSON.stringify(b)).join("\n")}\n`,
    );
    await expect(undoSession(repo.root, { agent: A })).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
    });
  });
});
