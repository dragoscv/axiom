import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AxiomError } from "@codai/axiom-schema";
import { errnoCode } from "./fsx.js";

export interface LockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
  manifestDigest: string;
}

export const LOCK_STALE_MS: number = 60 * 60 * 1000;
export const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;

export function lockPath(root: string): string {
  return path.join(root, ".axiom", "lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const c = errnoCode(err);
    // EPERM = exists but not ours → alive.
    return c === "EPERM";
  }
}

async function readHolder(p: string): Promise<LockHolder | undefined> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof j.pid !== "number" || typeof j.startedAt !== "string") return undefined;
    return {
      pid: j.pid,
      hostname: typeof j.hostname === "string" ? j.hostname : "",
      startedAt: j.startedAt,
      manifestDigest: typeof j.manifestDigest === "string" ? j.manifestDigest : "",
    };
  } catch {
    return undefined;
  }
}

function isStale(holder: LockHolder | undefined): boolean {
  if (holder === undefined) return true; // unreadable/corrupt → treat as stale
  const age = Date.now() - Date.parse(holder.startedAt);
  if (Number.isNaN(age) || age > LOCK_STALE_MS) return true;
  if (holder.hostname === hostname() && !pidAlive(holder.pid)) return true;
  return false;
}

export interface Lock {
  path: string;
  holder: LockHolder;
  release(): Promise<void>;
}

/** O_EXCL lockfile at `.axiom/lock`; waits up to `timeoutMs`, reclaims stale locks. */
export async function acquireLock(
  root: string,
  manifestDigest: string,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<Lock> {
  const p = lockPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const holder: LockHolder = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    manifestDigest,
  };
  const body = JSON.stringify(holder);
  const deadline = Date.now() + timeoutMs;
  let lastHolder: LockHolder | undefined;
  for (;;) {
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(p, "wx");
      await fh.writeFile(body, "utf8");
      await fh.sync();
      return {
        path: p,
        holder,
        release: async () => {
          // Only remove if we still own it.
          const cur = await readHolder(p);
          if (cur !== undefined && cur.pid === holder.pid && cur.startedAt === holder.startedAt) {
            await fs.rm(p, { force: true });
          }
        },
      };
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
    } finally {
      await fh?.close();
    }
    lastHolder = await readHolder(p);
    if (isStale(lastHolder)) {
      await fs.rm(p, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new AxiomError("ERR_LOCKED", "another apply holds the root lock", {
        details: { holder: lastHolder, lock: p },
      });
    }
    await sleep(LOCK_POLL_MS);
  }
}

export async function withLock<T>(
  root: string,
  manifestDigest: string,
  fn: (lock: Lock) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const lock = await acquireLock(root, manifestDigest, timeoutMs);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
