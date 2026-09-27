import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerIntent } from "@codai/axiom-apply";
import type { ApplyResult, ManifestBundle } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStatus, renderStatus } from "./status.js";
import { type Harness, harness, makePlan, structured, textOf, tmpRepo } from "./test-helpers.js";
import { StatusOutput } from "./tools.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let h: Harness;
beforeEach(async () => {
  repo = await tmpRepo("axiom-status-");
  h = await harness([repo.root]);
});
afterEach(async () => {
  await h.close();
  await repo.cleanup();
});

async function compileAndApply(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const c = await h.call("axiom_plan_compile", { plan: makePlan(files, { name: "st" }) });
  const bundle = structured<ManifestBundle>(c);
  const ap = await h.call("axiom_apply", {
    bundle,
    root: repo.root,
    confirmDigest: bundle.manifestDigest,
    ...extra,
  });
  return { bundle, result: structured<ApplyResult>(ap), raw: ap };
}

describe("axiom_status tool + axiom://lock resource (S-706)", () => {
  it("fresh root: lock free, no journals, empty chain", async () => {
    const r = await h.call("axiom_status", {});
    expect(r.isError).toBeUndefined();
    const s = StatusOutput.parse(r.structuredContent);
    expect(s.lock).toEqual({ held: false, queue: [], intents: [] });
    expect(s.interrupted).toEqual([]);
    expect(s.chain).toMatchObject({ ok: true, entries: 0 });
    expect(s.lastApplied).toBeUndefined();
    expect(JSON.parse(textOf(r))).toMatchObject({ held: false, chainOk: true, interrupted: 0 });
  });

  it("after an apply: lastApplied is the committed digest and the chain has one entry", async () => {
    const { bundle, result } = await compileAndApply({ "a.txt": "a\n" });
    expect(result.status).toBe("applied");
    const s = StatusOutput.parse(
      (await h.call("axiom_status", { root: repo.root })).structuredContent,
    );
    expect(s.lastApplied?.manifestDigest).toBe(bundle.manifestDigest);
    expect(s.lastApplied?.state).toBe("committed");
    expect(s.chain).toMatchObject({ ok: true, entries: 1 });
    expect(renderStatus(await collectStatus(repo.root)).some((l) => l.startsWith("chain ok"))).toBe(
      true,
    );
  });

  it("a root outside the allowlist is a structured ERR_ROOT_NOT_ALLOWED, never a throw", async () => {
    const other = await tmpRepo("axiom-status-other-");
    try {
      const r = await h.call("axiom_status", { root: other.root });
      expect(r.isError).toBe(true);
      expect(structured<{ code: string }>(r).code).toBe("ERR_ROOT_NOT_ALLOWED");
      const bad = await h.call("axiom_status", { root: 42 });
      expect(bad.isError).toBe(true);
    } finally {
      await other.cleanup();
    }
  });

  it("axiom://lock lists lockStatus per allowlisted root, including live intents", async () => {
    const intent = await registerIntent(repo.root, `sha256:${"cd".repeat(32)}`, ["x.txt"]);
    try {
      const res = await h.client.readResource({ uri: "axiom://lock" });
      const doc = JSON.parse(res.contents[0]?.text as string) as {
        roots: { root: string; held: boolean; queue: unknown[]; intents: { paths: string[] }[] }[];
      };
      expect(doc.roots).toHaveLength(1);
      expect(doc.roots[0]).toMatchObject({ held: false, queue: [] });
      expect(doc.roots[0]?.intents.map((i) => i.paths)).toEqual([["x.txt"]]);
      const listed = await h.client.listResources();
      expect(listed.resources.map((r) => r.uri)).toContain("axiom://lock");
      const st = StatusOutput.parse((await h.call("axiom_status", {})).structuredContent);
      expect(st.lock.intents).toHaveLength(1);
    } finally {
      await intent.release();
    }
  });

  it("an overlapping in-flight intent fails axiom_apply with ERR_CONFLICT + details", async () => {
    const other = `sha256:${"ef".repeat(32)}`;
    const intent = await registerIntent(repo.root, other, ["a.txt"]);
    try {
      const { result } = await compileAndApply({ "a.txt": "a\n" });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("ERR_CONFLICT");
      expect(result.error?.details).toMatchObject({ otherDigest: other, paths: ["a.txt"] });
    } finally {
      await intent.release();
    }
  });

  it("axiom_apply passes lockTimeoutMs through: a held lock → ERR_LOCKED quickly", async () => {
    await mkdir(join(repo.root, ".axiom"), { recursive: true });
    await writeFile(
      join(repo.root, ".axiom", "lock"),
      JSON.stringify({
        pid: process.pid,
        hostname: (await import("node:os")).hostname(),
        manifestDigest: "",
        startedAt: new Date().toISOString(),
      }),
    );
    const t0 = Date.now();
    const { result } = await compileAndApply({ "b.txt": "b\n" }, { lockTimeoutMs: 100 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ERR_LOCKED");
    expect(Date.now() - t0).toBeLessThan(20_000);
    const s = StatusOutput.parse((await h.call("axiom_status", {})).structuredContent);
    expect(s.lock.held).toBe(true);
  });

  it("axiom_apply rejects out-of-range lockTimeoutMs / keepBackups at the schema", async () => {
    const c = await h.call("axiom_plan_compile", { plan: makePlan({ "c.txt": "c" }) });
    const bundle = structured<ManifestBundle>(c);
    for (const extra of [
      { lockTimeoutMs: -1 },
      { lockTimeoutMs: 600_001 },
      { keepBackups: 1001 },
    ]) {
      const r = await h.call("axiom_apply", {
        bundle,
        root: repo.root,
        confirmDigest: bundle.manifestDigest,
        ...extra,
      });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
    }
    const ok = await compileAndApply({ "c.txt": "c" }, { keepBackups: 0, lockTimeoutMs: 1000 });
    expect(ok.result.status).toBe("applied");
  });
});
