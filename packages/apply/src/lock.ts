import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AxiomError } from "@codai/axiom-schema";
import { errnoCode } from "./fsx.js";

/**
 * Single-writer root lock (`.axiom/lock`, O_EXCL) with a fair FIFO wait queue
 * (`.axiom/queue/*.ticket`) and an intent registry (`.axiom/intents/*.json`)
 * used for early multi-agent conflict detection (S-703).
 *
 * Only the head of the queue (lowest-sorted LIVE ticket) competes for the lock;
 * tickets and intents of dead pids on this host, or older than LOCK_STALE_MS,
 * are skipped and removed.
 */
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
export function queueDir(root: string): string {
  return path.join(root, ".axiom", "queue");
}
export function intentsDir(root: string): string {
  return path.join(root, ".axiom", "intents");
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

/** Dead pid on this host, unparseable timestamp, or older than LOCK_STALE_MS. */
function staleRecord(pid: number, host: string, since: string): boolean {
  const age = Date.now() - Date.parse(since);
  if (Number.isNaN(age) || age > LOCK_STALE_MS) return true;
  return host === hostname() && !pidAlive(pid);
}

function isStale(holder: LockHolder | undefined): boolean {
  if (holder === undefined) return true; // unreadable/corrupt → treat as stale
  return staleRecord(holder.pid, holder.hostname, holder.startedAt);
}

let seqCounter = 0;
/** Sortable id: 15-digit epoch ms + 6-digit per-process counter + random tie-breaker. */
function sortableId(): string {
  seqCounter = (seqCounter + 1) % 1_000_000;
  return `${String(Date.now()).padStart(15, "0")}${String(seqCounter).padStart(6, "0")}${randomBytes(3).toString("hex")}`;
}

/** tmp (not matching the reader's suffix) + rename → readers never see a half-written record. */
async function writeRecordAtomic(dir: string, name: string, body: unknown): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(body), "utf8");
  try {
    await fs.rename(tmp, final);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return final;
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
}

/**
 * Windows: a file whose delete is pending (another waiter just `rm`'d it while someone held a
 * handle) answers EPERM/EACCES/EBUSY to open and read. That is contention, not an error.
 */
function transient(err: unknown): boolean {
  const c = errnoCode(err);
  return c === "EEXIST" || c === "EPERM" || c === "EACCES" || c === "EBUSY";
}

/** `undefined` = vanished or transiently unreadable (never pruned); `null` = corrupt. */
async function readJsonRecord(p: string): Promise<Record<string, unknown> | null | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || transient(err)) return undefined;
    return null;
  }
  try {
    const j: unknown = JSON.parse(raw);
    return typeof j === "object" && j !== null ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- queue tickets

interface Ticket {
  name: string;
  pid: number;
  hostname: string;
  since: string;
  manifestDigest: string;
}

const TICKET_SUFFIX = ".ticket";

/** Live tickets sorted by name (= FIFO). With `prune`, stale/corrupt tickets are removed. */
async function listTickets(root: string, prune: boolean): Promise<Ticket[]> {
  const dir = queueDir(root);
  const out: Ticket[] = [];
  for (const name of await readdirOrEmpty(dir)) {
    if (!name.endsWith(TICKET_SUFFIX) || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const j = await readJsonRecord(p);
    if (j === undefined) continue;
    const ok =
      j !== null &&
      typeof j.pid === "number" &&
      typeof j.since === "string" &&
      typeof j.hostname === "string";
    if (!ok || staleRecord(j.pid as number, j.hostname as string, j.since as string)) {
      if (prune) await fs.rm(p, { force: true });
      continue;
    }
    out.push({
      name,
      pid: j.pid as number,
      hostname: j.hostname as string,
      since: j.since as string,
      manifestDigest: typeof j.manifestDigest === "string" ? j.manifestDigest : "",
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function holderDetails(h: LockHolder | undefined): Record<string, unknown> | undefined {
  if (h === undefined) return undefined;
  return { pid: h.pid, host: h.hostname, digest: h.manifestDigest, since: h.startedAt };
}

export interface Lock {
  path: string;
  holder: LockHolder;
  release(): Promise<void>;
}

/**
 * O_EXCL lockfile at `.axiom/lock`; waits up to `timeoutMs` in a FIFO queue, reclaims stale
 * locks. Timeout → `ERR_LOCKED` with `details: { holder, waitedMs, queuePosition, lock }`
 * (`queuePosition` is 1-based: 1 = head of the queue).
 */
export async function acquireLock(
  root: string,
  manifestDigest: string,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<Lock> {
  const p = lockPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const started = Date.now();
  const deadline = started + timeoutMs;
  const ticketName = `${sortableId()}-${process.pid}${TICKET_SUFFIX}`;
  const ticketPath = await writeRecordAtomic(queueDir(root), ticketName, {
    pid: process.pid,
    hostname: hostname(),
    since: new Date(started).toISOString(),
    manifestDigest,
  });
  let lastHolder: LockHolder | undefined;
  try {
    for (;;) {
      const tickets = await listTickets(root, true);
      const ahead = tickets.filter((t) => t.name < ticketName).length;
      if (ahead === 0) {
        const holder: LockHolder = {
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          manifestDigest,
        };
        let fh: fs.FileHandle | undefined;
        let acquired = false;
        try {
          fh = await fs.open(p, "wx");
          await fh.writeFile(JSON.stringify(holder), "utf8");
          await fh.sync();
          acquired = true;
        } catch (err) {
          if (!transient(err)) throw err;
        } finally {
          await fh?.close();
        }
        if (acquired) {
          return {
            path: p,
            holder,
            release: async () => {
              // Only remove if we still own it.
              const cur = await readHolder(p);
              if (
                cur !== undefined &&
                cur.pid === holder.pid &&
                cur.startedAt === holder.startedAt
              ) {
                await fs.rm(p, { force: true });
              }
            },
          };
        }
        lastHolder = await readHolder(p);
        if (isStale(lastHolder)) {
          await fs.rm(p, { force: true });
          continue;
        }
      } else {
        lastHolder = await readHolder(p);
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new AxiomError("ERR_LOCKED", "another apply holds the root lock", {
          details: {
            holder: holderDetails(lastHolder),
            waitedMs: now - started,
            queuePosition: ahead + 1,
            lock: p,
          },
        });
      }
      await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - now)));
    }
  } finally {
    await fs.rm(ticketPath, { force: true });
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

// ---------------------------------------------------------------- intents

export interface IntentRecord {
  manifestDigest: string;
  /** Artifact paths, sorted. */
  paths: string[];
  pid: number;
  host: string;
  /** ISO timestamp. */
  since: string;
  /** Sortable registration order; the older intent wins an overlap. */
  seq: string;
}

export interface Intent {
  path: string;
  record: IntentRecord;
  release(): Promise<void>;
}

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function normPath(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/** Overlap = same path, or one is a directory prefix of the other (`a` vs `a/b`). */
export function overlappingPaths(mine: readonly string[], theirs: readonly string[]): string[] {
  const other = theirs.map(normPath);
  const out = new Set<string>();
  for (const m of mine) {
    const n = normPath(m);
    if (other.some((o) => o === n || o.startsWith(`${n}/`) || n.startsWith(`${o}/`))) out.add(m);
  }
  return [...out].sort();
}

function hexOfDigest(d: string): string {
  const hex = d.startsWith("sha256:") ? d.slice(7) : d;
  return /^[a-f0-9]{1,64}$/.test(hex) ? hex : "unknown";
}

async function listIntents(
  root: string,
  prune: boolean,
): Promise<(IntentRecord & { file: string })[]> {
  const dir = intentsDir(root);
  const out: (IntentRecord & { file: string })[] = [];
  for (const name of await readdirOrEmpty(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    const j = await readJsonRecord(file);
    if (j === undefined) continue;
    const ok =
      j !== null &&
      typeof j.manifestDigest === "string" &&
      Array.isArray(j.paths) &&
      j.paths.every((x) => typeof x === "string") &&
      typeof j.pid === "number" &&
      typeof j.host === "string" &&
      typeof j.since === "string";
    if (!ok || staleRecord(j.pid as number, j.host as string, j.since as string)) {
      if (prune) await fs.rm(file, { force: true });
      continue;
    }
    out.push({
      file,
      manifestDigest: j.manifestDigest as string,
      paths: j.paths as string[],
      pid: j.pid as number,
      host: j.host as string,
      since: j.since as string,
      seq: typeof j.seq === "string" ? j.seq : "",
    });
  }
  return out;
}

const REGISTRY_MUTEX = ".mutex";
const REGISTRY_MUTEX_STALE_MS = 10_000;
const REGISTRY_MUTEX_WAIT_MS = 10_000;

/**
 * Short critical section around "scan intents + write ours" so check-and-register is atomic:
 * of two overlapping applies racing, the second to enter always sees the first. Held for
 * milliseconds only; a mutex of a dead pid or older than 10 s is reclaimed.
 */
async function withRegistryMutex<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = intentsDir(root);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, REGISTRY_MUTEX);
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + REGISTRY_MUTEX_WAIT_MS;
  for (;;) {
    let fh: fs.FileHandle | undefined;
    let acquired = false;
    try {
      fh = await fs.open(p, "wx");
      await fh.writeFile(
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          since: new Date().toISOString(),
          token,
        }),
        "utf8",
      );
      acquired = true;
    } catch (err) {
      if (!transient(err)) throw err;
    } finally {
      await fh?.close();
    }
    if (acquired) break;
    const j = await readJsonRecord(p);
    if (j !== undefined) {
      const since = j !== null && typeof j.since === "string" ? Date.parse(j.since) : Number.NaN;
      const deadPid =
        j !== null && typeof j.pid === "number" && j.hostname === hostname() && !pidAlive(j.pid);
      // A null (corrupt / mid-write) record is only reclaimed once it has aged out via mtime.
      let aged = !Number.isNaN(since) && Date.now() - since > REGISTRY_MUTEX_STALE_MS;
      if (j === null) {
        const st = await fs.stat(p).catch(() => undefined);
        aged = st !== undefined && Date.now() - st.mtimeMs > REGISTRY_MUTEX_STALE_MS;
      }
      if (deadPid || aged) {
        await fs.rm(p, { force: true });
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new AxiomError("ERR_LOCKED", "intent registry is busy", { details: { lock: p } });
    }
    await sleep(5);
  }
  try {
    return await fn();
  } finally {
    const cur = await readJsonRecord(p);
    if (cur !== undefined && cur !== null && cur.token === token) await fs.rm(p, { force: true });
  }
}

/**
 * Register an in-flight intent (`.axiom/intents/<hex>-<seq>.json`, written atomically) after
 * checking it against every other LIVE intent on the root, atomically (registry mutex). An
 * overlapping intent of a DIFFERENT digest → `ERR_CONFLICT` with
 * `details: { otherDigest, paths }` (sorted) and nothing is registered. The same digest (a
 * re-apply) never conflicts with itself.
 *
 * The file name carries a unique suffix after the hex so two concurrent applies of the same
 * digest do not clobber each other's record. The registry is an EARLY detector: correctness
 * under anything it misses is still guaranteed by the lock + pre-image re-verification at commit.
 */
export async function registerIntent(
  root: string,
  manifestDigest: string,
  paths: readonly string[],
): Promise<Intent> {
  const seq = sortableId();
  const record: IntentRecord = {
    manifestDigest,
    paths: [...paths].sort(),
    pid: process.pid,
    host: hostname(),
    since: new Date().toISOString(),
    seq,
  };
  const file = await withRegistryMutex(root, async () => {
    for (const other of await listIntents(root, true)) {
      if (other.manifestDigest === manifestDigest) continue;
      const overlap = overlappingPaths(record.paths, other.paths);
      if (overlap.length > 0) {
        throw new AxiomError(
          "ERR_CONFLICT",
          `in-flight apply ${other.manifestDigest} on this root touches the same paths: ${overlap.join(", ")}`,
          { details: { otherDigest: other.manifestDigest, paths: overlap } },
        );
      }
    }
    return writeRecordAtomic(
      intentsDir(root),
      `${hexOfDigest(manifestDigest)}-${seq}.json`,
      record,
    );
  });
  return {
    path: file,
    record,
    release: async () => {
      await fs.rm(file, { force: true });
    },
  };
}

// ---------------------------------------------------------------- status

export interface LockStatus {
  held: boolean;
  holder?: { pid: number; host?: string; digest?: string; since?: string; stale: boolean };
  queue: { pid: number; since: string }[];
  intents: { digest: string; paths: string[]; pid: number; since: string }[];
}

/** Read-only snapshot of `.axiom/lock`, the wait queue and live intents. Never mutates. */
export async function lockStatus(root: string): Promise<LockStatus> {
  const p = lockPath(root);
  let held = false;
  try {
    await fs.lstat(p);
    held = true;
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
  const out: LockStatus = { held, queue: [], intents: [] };
  if (held) {
    const h = await readHolder(p);
    if (h !== undefined) {
      const holder: NonNullable<LockStatus["holder"]> = {
        pid: h.pid,
        since: h.startedAt,
        stale: isStale(h),
      };
      if (h.hostname !== "") holder.host = h.hostname;
      if (h.manifestDigest !== "") holder.digest = h.manifestDigest;
      out.holder = holder;
    }
  }
  out.queue = (await listTickets(root, false)).map((t) => ({ pid: t.pid, since: t.since }));
  const intents = await listIntents(root, false);
  intents.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  out.intents = intents.map((i) => ({
    digest: i.manifestDigest,
    paths: i.paths,
    pid: i.pid,
    since: i.since,
  }));
  return out;
}
