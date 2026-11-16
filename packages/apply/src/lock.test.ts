import fs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CheckReport, ManifestBundle } from "@codai/axiom-schema";
import { AxiomError } from "@codai/axiom-schema";
import { describe, expect, it, vi } from "vitest";
import { apply } from "./apply.js";
import {
  acquireLock,
  intentsDir,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  lockPath,
  lockStatus,
  overlappingPaths,
  queueDir,
  registerIntent,
} from "./lock.js";
import { exists, makeBundle, mkRoot, readText } from "./test-helpers.js";

const DEAD_PID = 999_999;

/** Send a lock / ticket / intent quiet: `LOCK_STALE_MS` past its last heartbeat. */
async function backdate(p: string, ms = LOCK_STALE_MS + 5_000): Promise<void> {
  const t = new Date(Date.now() - ms);
  await fs.utimes(p, t, t);
}

/** Wall-clock upper bound, ×5 on CI or a loaded box (AXIOM_LOADED_BOX). Lower bounds stay exact. */
const perfBound = (ms: number): number =>
  ms * (process.env.CI || process.env.AXIOM_LOADED_BOX ? 5 : 1);

function fsApply(
  bundle: ManifestBundle,
  root: string,
  extra: Partial<Parameters<typeof apply>[0]> = {},
) {
  return apply({ bundle, root, mode: "fs", confirmDigest: bundle.manifestDigest, ...extra });
}

function passReport(bundle: ManifestBundle): CheckReport {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "CheckReport",
    manifestDigest: bundle.manifestDigest,
    profile: "default",
    verdict: "pass",
    findings: [],
    factsDigest: `sha256:${"0".repeat(64)}`,
    durationMs: 0,
    providers: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

async function caught(p: Promise<unknown>): Promise<AxiomError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AxiomError) return err;
    throw err;
  }
  throw new Error("expected an AxiomError");
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

describe("S-703 conflict detection (intents)", () => {
  it("two concurrent applies with overlapping paths → exactly one applies, the other ERR_CONFLICT", async () => {
    const root = await mkRoot();
    const a = makeBundle(
      [
        { path: "shared.txt", content: "A" },
        { path: "only-a.txt", content: "a" },
      ],
      { name: "a" },
    );
    const b = makeBundle(
      [
        { path: "shared.txt", content: "B" },
        { path: "only-b.txt", content: "b" },
      ],
      { name: "b" },
    );
    const gate = deferred();
    const staged = deferred();
    // A parks inside its pre-checks (holding intent + lock) until B has been judged.
    const pa = fsApply(a, root, {
      preChecks: async () => {
        staged.resolve();
        await gate.promise;
        return passReport(a);
      },
    });
    await staged.promise;
    const rb = await fsApply(b, root, { lockTimeoutMs: 200 });
    gate.resolve();
    const ra = await pa;

    expect(ra.status).toBe("applied");
    expect(rb.status).toBe("failed");
    expect(rb.error?.code).toBe("ERR_CONFLICT");
    expect(await readText(root, "shared.txt")).toBe("A");
    expect(await exists(root, "only-b.txt")).toBe(false);
    // Intents are withdrawn after both applies (success and failure).
    expect(await listNames(intentsDir(root))).toEqual([]);
  });

  it("registerIntent: overlapping live intent → ERR_CONFLICT with details { otherDigest, paths (sorted) }", async () => {
    const root = await mkRoot();
    const first = await registerIntent(root, "sha256:aaaa", ["z.txt", "dir/x.ts", "a.txt"]);
    try {
      const err = await caught(
        registerIntent(root, "sha256:bbbb", ["z.txt", "other.txt", "a.txt", "dir"]),
      );
      expect(err.code).toBe("ERR_CONFLICT");
      expect(err.details).toEqual({ otherDigest: "sha256:aaaa", paths: ["a.txt", "dir", "z.txt"] });
      // The loser registered nothing.
      expect(await listNames(intentsDir(root))).toHaveLength(1);
      // Same digest (a re-apply) is not a conflict with itself.
      const again = await registerIntent(root, "sha256:aaaa", ["a.txt"]);
      await again.release();
    } finally {
      await first.release();
    }
    expect(await listNames(intentsDir(root))).toEqual([]);
  });

  it("overlap compare is case-insensitive on win32/darwin, exact on linux; dir prefixes overlap", () => {
    const ci = process.platform === "win32" || process.platform === "darwin";
    expect(overlappingPaths(["README.md"], ["readme.md"])).toEqual(ci ? ["README.md"] : []);
    expect(overlappingPaths(["src"], ["src/a.ts"])).toEqual(["src"]);
    expect(overlappingPaths(["src/a.ts"], ["src"])).toEqual(["src/a.ts"]);
    expect(overlappingPaths(["srcx/a.ts"], ["src"])).toEqual([]);
  });

  it("non-overlapping concurrent applies both succeed (serialised by the queue)", async () => {
    const root = await mkRoot();
    const bundles = [1, 2, 3].map((i) =>
      makeBundle([{ path: `f${i}.txt`, content: String(i) }], { name: `n${i}` }),
    );
    const rs = await Promise.all(bundles.map((b) => fsApply(b, root)));
    expect(
      rs.map((r) => r.status),
      JSON.stringify(rs.map((r) => r.error)),
    ).toEqual(["applied", "applied", "applied"]);
    for (const i of [1, 2, 3]) expect(await readText(root, `f${i}.txt`)).toBe(String(i));
    expect(await exists(root, ".axiom/lock")).toBe(false);
    expect(await listNames(queueDir(root))).toEqual([]);
    expect(await listNames(intentsDir(root))).toEqual([]);
  });

  it("an intent whose heartbeat went quiet is ignored and removed (A1-3: never pid alone)", async () => {
    const root = await mkRoot();
    await fs.mkdir(intentsDir(root), { recursive: true });
    const staleFile = path.join(intentsDir(root), "dead-0.json");
    await fs.writeFile(
      staleFile,
      JSON.stringify({
        manifestDigest: "sha256:dead",
        paths: ["a.txt"],
        pid: DEAD_PID,
        host: hostname(),
        since: new Date().toISOString(),
        seq: "0",
      }),
    );
    await backdate(staleFile);
    const oldFile = path.join(intentsDir(root), "old-0.json");
    await fs.writeFile(
      oldFile,
      JSON.stringify({
        manifestDigest: "sha256:old",
        paths: ["a.txt"],
        pid: process.pid,
        host: hostname(),
        since: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        seq: "0",
      }),
    );
    await backdate(oldFile);
    const r = await fsApply(makeBundle([{ path: "a.txt", content: "a" }]), root);
    expect(r.status).toBe("applied");
    expect(await exists(root, ".axiom/intents/dead-0.json")).toBe(false);
    expect(await exists(root, ".axiom/intents/old-0.json")).toBe(false);
  });

  it("a LIVE intent is honoured whatever its pid or declared age says (A1-3)", async () => {
    const root = await mkRoot();
    await fs.mkdir(intentsDir(root), { recursive: true });
    const p = path.join(intentsDir(root), "foreign-0.json");
    await fs.writeFile(
      p,
      JSON.stringify({
        manifestDigest: "sha256:foreign",
        paths: ["a.txt"],
        // A pid that is not ours and a `since` two hours old: with the old rule (dead pid on this
        // host, or older than an hour) this intent was ignored. It is live: its heartbeat is now.
        pid: DEAD_PID,
        host: hostname(),
        since: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        seq: "0",
      }),
    );
    const r = await fsApply(makeBundle([{ path: "a.txt", content: "a" }]), root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_CONFLICT");
    expect(await exists(root, ".axiom/intents/foreign-0.json")).toBe(true);
  });

  it("dry-run never registers an intent and never fails ERR_CONFLICT", async () => {
    const root = await mkRoot();
    const other = await registerIntent(root, "sha256:other", ["a.txt"]);
    try {
      const bundle = makeBundle([{ path: "a.txt", content: "a" }]);
      const r = await apply({
        bundle,
        root,
        mode: "dry-run",
        preChecks: async () => {
          expect(await listNames(intentsDir(root))).toHaveLength(1);
          return passReport(bundle);
        },
      });
      expect(r.status).toBe("applied");
      expect(r.error).toBeUndefined();
    } finally {
      await other.release();
    }
  });
});

describe("S-703 fair lock queue", () => {
  it("FIFO: three waiters acquire in ticket order", async () => {
    const root = await mkRoot();
    const holder = await acquireLock(root, "sha256:holder", 1000);
    const order: number[] = [];
    const waiters: Promise<void>[] = [];
    for (const i of [1, 2, 3]) {
      waiters.push(
        acquireLock(root, `sha256:w${i}`, 10_000).then(async (l) => {
          order.push(i);
          await sleep(20); // give later waiters a chance to jump the queue if it were unfair
          await l.release();
        }),
      );
      await waitFor(async () => (await lockStatus(root)).queue.length === i);
    }
    await holder.release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(await listNames(queueDir(root))).toEqual([]);
  });

  it("a ticket whose heartbeat went quiet at the head of the queue is skipped and removed", async () => {
    const root = await mkRoot();
    await fs.mkdir(queueDir(root), { recursive: true });
    const name = `${"0".repeat(27)}-${DEAD_PID}.ticket`;
    const ticket = path.join(queueDir(root), name);
    await fs.writeFile(
      ticket,
      JSON.stringify({
        pid: DEAD_PID,
        hostname: hostname(),
        since: new Date().toISOString(),
        manifestDigest: "sha256:dead",
      }),
    );
    await backdate(ticket);
    const t0 = Date.now();
    const lock = await acquireLock(root, "sha256:me", perfBound(2000));
    expect(Date.now() - t0).toBeLessThan(perfBound(2000));
    await lock.release();
    expect(await exists(root, `.axiom/queue/${name}`)).toBe(false);
  });

  it("lockTimeoutMs is honoured → ERR_LOCKED with holder, waitedMs >= timeout and queuePosition", async () => {
    const root = await mkRoot();
    const holder = await acquireLock(root, "sha256:holder", 1000);
    try {
      const first = acquireLock(root, "sha256:first", 5000);
      await waitFor(async () => (await lockStatus(root)).queue.length === 1);
      const err = await caught(acquireLock(root, "sha256:second", 250));
      expect(err.code).toBe("ERR_LOCKED");
      const d = err.details ?? {};
      expect(d.waitedMs).toBeGreaterThanOrEqual(250);
      expect(d.queuePosition).toBe(2);
      expect(d.holder).toMatchObject({ pid: process.pid, digest: "sha256:holder" });
      // The timed-out waiter's ticket is gone; the first waiter is still queued.
      expect((await lockStatus(root)).queue).toHaveLength(1);
      await holder.release();
      await (await first).release();
    } finally {
      await holder.release();
    }
    // Through apply(): the option reaches the lock.
    const held = await acquireLock(root, "sha256:holder2", 1000);
    try {
      const t0 = Date.now();
      const r = await fsApply(makeBundle([{ path: "a.txt", content: "a" }]), root, {
        lockTimeoutMs: 150,
      });
      expect(r.error?.code).toBe("ERR_LOCKED");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    } finally {
      await held.release();
    }
    expect(await listNames(queueDir(root))).toEqual([]);
    expect(await listNames(intentsDir(root))).toEqual([]);
  });
});

describe("lockStatus", () => {
  it("reports an unheld, empty root", async () => {
    const root = await mkRoot();
    expect(await lockStatus(root)).toEqual({ held: false, queue: [], intents: [] });
  });

  it("reports holder, queue and intents while a lock is held", async () => {
    const root = await mkRoot();
    const holder = await acquireLock(root, "sha256:holder", 1000);
    const intent = await registerIntent(root, "sha256:waiter", ["b.txt", "a.txt"]);
    const waiter = acquireLock(root, "sha256:waiter", 5000);
    try {
      await waitFor(async () => (await lockStatus(root)).queue.length === 1);
      const s = await lockStatus(root);
      expect(s.held).toBe(true);
      expect(s.holder).toEqual({
        pid: process.pid,
        host: hostname(),
        digest: "sha256:holder",
        since: holder.holder.startedAt,
        stale: false,
      });
      expect(s.queue).toEqual([{ pid: process.pid, since: expect.any(String) }]);
      expect(s.intents).toEqual([
        {
          digest: "sha256:waiter",
          paths: ["a.txt", "b.txt"],
          pid: process.pid,
          since: intent.record.since,
        },
      ]);
    } finally {
      await holder.release();
      await (await waiter).release();
      await intent.release();
    }
    expect(await lockStatus(root)).toEqual({ held: false, queue: [], intents: [] });
  });

  it("flags a quiet holder as stale without mutating anything", async () => {
    const root = await mkRoot();
    await fs.mkdir(path.join(root, ".axiom"), { recursive: true });
    const p = path.join(root, ".axiom", "lock");
    await fs.writeFile(
      p,
      JSON.stringify({
        pid: DEAD_PID,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        manifestDigest: "sha256:dead",
        token: "quiet",
      }),
    );
    await backdate(p);
    const s = await lockStatus(root);
    expect(s.held).toBe(true);
    expect(s.holder?.stale).toBe(true);
    expect(await exists(root, ".axiom/lock")).toBe(true);
  });

  it("does NOT flag a holder with a fresh heartbeat, whatever pid it names (A1-3)", async () => {
    const root = await mkRoot();
    await fs.mkdir(path.join(root, ".axiom"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".axiom", "lock"),
      JSON.stringify({
        pid: DEAD_PID,
        hostname: hostname(),
        // Ancient `startedAt`, a pid that is dead (or belongs to another namespace: WSL): the
        // heartbeat is the only evidence, and it is fresh, so this lock is LIVE.
        startedAt: new Date(0).toISOString(),
        manifestDigest: "sha256:live",
        token: "live",
      }),
    );
    const s = await lockStatus(root);
    expect(s.holder?.stale).toBe(false);
    // And a second writer is refused instead of reclaiming it.
    const r = await fsApply(makeBundle([{ path: "a.txt", content: "a" }]), root, {
      lockTimeoutMs: 200,
    });
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_LOCKED");
    expect(await exists(root, "a.txt")).toBe(false);
    expect(await exists(root, ".axiom/lock")).toBe(true);
  });

  it("the holder refreshes the lock heartbeat while it is held (A1-3)", async () => {
    const root = await mkRoot();
    // Only the heartbeat interval is faked, so `waitFor`'s real sleep still works.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const lock = await acquireLock(root, "sha256:hb", 1000);
      const p = lockPath(root);
      await backdate(p);
      const quiet = (await fs.stat(p)).mtimeMs;
      expect((await lockStatus(root)).holder?.stale).toBe(true);
      vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
      await waitFor(async () => (await fs.stat(p)).mtimeMs > quiet);
      expect((await lockStatus(root)).holder?.stale).toBe(false);
      await lock.release();
      expect(await exists(root, ".axiom/lock")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("release never deletes a lock another writer took (token comparison, A1-3)", async () => {
    const root = await mkRoot();
    const lock = await acquireLock(root, "sha256:mine", 1000);
    const p = lockPath(root);
    // Someone reclaimed it (we went quiet) and wrote their own token.
    await fs.writeFile(
      p,
      JSON.stringify({
        pid: 4242,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        manifestDigest: "sha256:theirs",
        token: "someone-else",
      }),
    );
    await lock.release();
    expect(await exists(root, ".axiom/lock")).toBe(true);
    expect((await lockStatus(root)).holder?.digest).toBe("sha256:theirs");
  });
});
