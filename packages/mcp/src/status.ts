/**
 * `axiom status` / `axiom_status` / `axiom://lock` (S-706): a read-only snapshot of one root's
 * write state — who holds `.axiom/lock`, who waits, which intents are registered, which journals
 * were interrupted, the last applied manifest and whether the journal hash chain verifies.
 * Never takes the lock, never writes.
 */
import {
  type ChainEntry,
  type ChainVerifyResult,
  type JournalSummary,
  journalStatus,
  type LockStatus,
  lockStatus,
  verifyChain,
} from "@codai/axiom-apply";

export interface RootStatus {
  root: string;
  lock: LockStatus;
  /** Journals left in `staged` / `committing` / `rolling-back` (need `axiom rollback`). */
  interrupted: JournalSummary[];
  /** Journal files under `.axiom/journal/` that do not parse. */
  corrupt: string[];
  /** Newest `committed` chain entry. */
  lastApplied?: ChainEntry;
  chain: {
    ok: boolean;
    entries: number;
    head: ChainVerifyResult["head"];
    firstBad?: NonNullable<ChainVerifyResult["firstBad"]>;
    /** Count of chain entries whose journal file was pruned (legal; details via `verify --journal`). */
    missingJournals: number;
  };
}

export async function collectStatus(rootReal: string): Promise<RootStatus> {
  const [lock, journals, chain] = await Promise.all([
    lockStatus(rootReal),
    journalStatus(rootReal),
    verifyChain(rootReal),
  ]);
  const out: RootStatus = {
    root: rootReal,
    lock,
    interrupted: journals.interrupted,
    corrupt: journals.corrupt,
    chain: {
      ok: chain.ok,
      entries: chain.entries,
      head: chain.head,
      missingJournals: chain.missing.length,
    },
  };
  if (chain.firstBad !== undefined) out.chain.firstBad = chain.firstBad;
  if (journals.lastApplied !== undefined) out.lastApplied = journals.lastApplied;
  return out;
}

/** Human rendering for `axiom status` (without `--json`). */
export function renderStatus(s: RootStatus): string[] {
  const lines = [`root ${s.root}`];
  const h = s.lock.holder;
  if (!s.lock.held) lines.push("lock free");
  else if (h === undefined) lines.push("lock held (holder unreadable)");
  else {
    lines.push(
      `lock held by pid ${h.pid}${h.host === undefined ? "" : `@${h.host}`}${h.digest === undefined ? "" : ` for ${h.digest}`}${h.since === undefined ? "" : ` since ${h.since}`}${h.stale ? " (STALE)" : ""}`,
    );
  }
  lines.push(`queue ${s.lock.queue.length}`);
  for (const q of s.lock.queue) lines.push(`  pid ${q.pid} since ${q.since}`);
  lines.push(`intents ${s.lock.intents.length}`);
  for (const i of s.lock.intents)
    lines.push(`  ${i.digest} pid ${i.pid} (${i.paths.length} paths) since ${i.since}`);
  lines.push(`interrupted journals ${s.interrupted.length}`);
  for (const j of s.interrupted)
    lines.push(`  ${j.manifestDigest} ${j.phase} ${j.done}/${j.files} pid ${j.pid}`);
  if (s.corrupt.length > 0) lines.push(`corrupt journals ${s.corrupt.join(", ")}`);
  lines.push(
    s.lastApplied === undefined
      ? "last applied: none"
      : `last applied #${s.lastApplied.seq} ${s.lastApplied.manifestDigest} at ${s.lastApplied.at}`,
  );
  lines.push(
    s.chain.ok
      ? `chain ok (${s.chain.entries} entries, head ${s.chain.head})`
      : `chain BROKEN at #${s.chain.firstBad?.seq} (${s.chain.firstBad?.reason})`,
  );
  return lines;
}
