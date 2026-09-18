import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { acquireLock } from "@codai/axiom-apply";
import { sha256Hex } from "@codai/axiom-canon";
import { casHas, casPut, compilePlan } from "@codai/axiom-plan";
import { type AxiomError, isAxiomError } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { casRootDir, collectGarbage, parseDuration } from "./gc.js";
import { saveManifest } from "./store.js";
import { makePlan, tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-gc-");
});
afterEach(async () => {
  await repo.cleanup();
});

async function fixture(): Promise<{ live: string; dead: string[] }> {
  const root = repo.root;
  // one referenced blob (via a stored manifest compiled with store: cas) + two orphans
  const { bundle } = await compilePlan(makePlan({ "a.txt": "live content" }), {
    store: "cas",
    root,
  });
  await saveManifest(root, bundle);
  const dead = [
    await casPut(root, new TextEncoder().encode("orphan one")),
    await casPut(root, new TextEncoder().encode("orphan two")),
  ];
  return { live: sha256Hex("live content"), dead };
}

async function allBlobs(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(casRootDir(root))) {
    for (const n of await readdir(path.join(casRootDir(root), shard))) out.push(n);
  }
  return out.sort();
}

describe("collectGarbage", () => {
  it("dry-run lists the 2 orphans and removes nothing", async () => {
    const { live, dead } = await fixture();
    const r = await collectGarbage(repo.root, { dryRun: true });
    expect(r.scanned).toBe(3);
    expect(r.live).toBe(1);
    expect(r.missing).toBe(0);
    expect(r.removed.map((x) => x.sha).sort()).toEqual([...dead].sort());
    expect(r.freedBytes).toBe("orphan one".length + "orphan two".length);
    expect(await allBlobs(repo.root)).toEqual([live, ...dead].sort());
  });

  it("real run removes the 2 orphans, keeps the live one; second run removes 0", async () => {
    const { live, dead } = await fixture();
    const r = await collectGarbage(repo.root);
    expect(r.dryRun).toBe(false);
    expect(r.removed.map((x) => x.sha).sort()).toEqual([...dead].sort());
    expect(await casHas(repo.root, live)).toBe(true);
    for (const d of dead) expect(await casHas(repo.root, d)).toBe(false);
    const again = await collectGarbage(repo.root);
    expect(again.scanned).toBe(1);
    expect(again.removed).toEqual([]);
    expect(again.freedBytes).toBe(0);
  });

  it("lock held by a live pid → ERR_LOCKED and nothing removed", async () => {
    const { dead } = await fixture();
    const lock = await acquireLock(repo.root, "sha256:other", 1000);
    try {
      await collectGarbage(repo.root, { lockTimeoutMs: 100 });
      throw new Error("expected ERR_LOCKED");
    } catch (err) {
      expect(isAxiomError(err)).toBe(true);
      expect((err as AxiomError).code).toBe("ERR_LOCKED");
    } finally {
      await lock.release();
    }
    for (const d of dead) expect(await casHas(repo.root, d)).toBe(true);
    // lock released → gc runs and releases its own lock afterwards
    await collectGarbage(repo.root);
    await expect(
      readdir(path.join(repo.root, ".axiom")).then((n) => n.includes("lock")),
    ).resolves.toBe(false);
  });

  it("olderThan keeps young orphans and removes stale ones + orphaned .tmp files", async () => {
    const { dead } = await fixture();
    const old = dead[0] as string;
    const oldFile = path.join(casRootDir(repo.root), old.slice(0, 2), old);
    const past = new Date(Date.now() - 3 * 86_400_000);
    await utimes(oldFile, past, past);
    const tmp = path.join(casRootDir(repo.root), "zz", "deadbeef.1.aa.tmp");
    await mkdir(path.dirname(tmp), { recursive: true });
    await writeFile(tmp, "partial");
    await utimes(tmp, past, past);
    const r = await collectGarbage(repo.root, { olderThanMs: 86_400_000 });
    expect(r.removed.map((x) => x.sha).sort()).toEqual([old, "deadbeef.1.aa.tmp"].sort());
    expect(r.skippedYoung).toBe(1);
    expect(await casHas(repo.root, dead[1] as string)).toBe(true);
  });

  it("keep: journal ignores compiled-only manifests but pins applied ones", async () => {
    const { live, dead } = await fixture();
    const r = await collectGarbage(repo.root, { keep: "journal", dryRun: true });
    expect(r.live).toBe(0);
    expect(r.removed).toHaveLength(3);
    // an applied/ record for the stored manifest pins its artifacts again
    const [hex] = (await readdir(path.join(repo.root, ".axiom", "manifests"))).map((n) =>
      n.replace(/\.json$/, ""),
    );
    await mkdir(path.join(repo.root, ".axiom", "applied"), { recursive: true });
    await writeFile(path.join(repo.root, ".axiom", "applied", `${hex}.json`), "{}");
    const r2 = await collectGarbage(repo.root, { keep: "journal" });
    expect(r2.live).toBe(1);
    expect(r2.removed.map((x) => x.sha).sort()).toEqual([...dead].sort());
    expect(await casHas(repo.root, live)).toBe(true);
  });

  it("reports live digests missing from the CAS and an empty root is a no-op", async () => {
    const { bundle } = await compilePlan(makePlan({ "b.txt": "never stored" }));
    await saveManifest(repo.root, bundle);
    const r = await collectGarbage(repo.root);
    expect(r).toMatchObject({ scanned: 0, live: 1, missing: 1, removed: [], freedBytes: 0 });
  });

  it("parseDuration", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("250")).toBe(250);
    expect(parseDuration("1w")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });
});
