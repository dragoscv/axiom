/**
 * Decision journal (Phase 8, D-36): one JSON line per write/shell-class tool call the gate
 * judged, appended to `<root>/.axiom/decisions.jsonl` when the gate profile sets
 * `record: true`. Each record maps 1:1 onto an in-toto agent-decision Statement
 * (`buildAgentDecisionStatement` in `@codai/axiom-canon`), so `axiom attest decisions` can sign
 * them later without re-reading the payloads (only the JCS hash of the arguments is kept).
 *
 * 3.0 (D-45, S-1316): every line is redacted before it is written — `command`, `reason` and
 * `override_reason` pass through the `content.noSecrets` secret patterns (matches become
 * `[REDACTED:<pattern>]`), `principal.subject` is `sha256(username)[:16]` unless
 * `AXIOM_JOURNAL_USERNAME=1`, and each line gets a time-sortable `id` plus `enforced` (false for
 * observer hooks, `AXIOM_GATE_OBSERVE=1`). The journal is never hashed into a manifest, so the
 * wall-clock part of the id is harmless.
 */
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import * as path from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { SECRET_PATTERNS } from "@codai/axiom-checks";

export const DECISIONS_FILE = ".axiom/decisions.jsonl";

export interface DecisionRecord {
  v: 1;
  /** 3.0: time-sortable id (10 Crockford base32 chars of ms time + 16 random). Set by appendDecision. */
  id?: string;
  /** ISO 8601. */
  decided_at: string;
  /** `<harness-or-unknown>:<sessionId-or-unknown>`. */
  agent_id: string;
  principal: { subject: string };
  tool: string;
  args_hash: `sha256:${string}`;
  args_state: "recorded" | "unavailable";
  /** `ask` = the gate handed the decision to the human (v2.6 rule verdicts). */
  decision: "allow" | "deny" | "ask";
  code?: string;
  reason?: string;
  /** Root-relative POSIX paths judged. */
  paths: string[];
  /** Gate profile source (file path or `builtin`). */
  profile: string;
  /** Profile of a sibling worktree that decided, when it is not `profile`. */
  profile_decided?: string;
  /** Gate wall time in ms (v2.6, `axiom stats`). */
  ms?: number;
  /** Shadow mode (v2.6): the gate allowed the call; `decision` is what it WOULD have done. */
  shadow?: true;
  /** `post` = a PostToolUse check of what a tool actually changed (v2.6, S-1205); absent = pre. */
  phase?: "pre" | "post";
  /** Rule id of a v2.6 rule verdict (`command.deny`, …) when it decided. */
  rule?: string;
  /** Shadow mode only: the shell command text, for `scripts/guard-parity.mjs --replay`. */
  command?: string;
  /**
   * 2.7: the call was allowed although a check fired — `warn` (profile `mode: "warn"`) or
   * `override` (the agent stated `axiom-override: <reason>`). `code` names the check.
   */
  relaxed?: "warn" | "override";
  /** The reason the agent gave for an override. */
  override_reason?: string;
  /**
   * 3.0: false when the hook only observes (`AXIOM_GATE_OBSERVE=1`) — the harness did not act on
   * the decision. Set by appendDecision when the caller leaves it out.
   */
  enforced?: boolean;
  /** 4.0: `sha256:<hex>` of the effective policy that judged the call (`resolvePolicy().policyDigest`). */
  policy_digest?: string;
  /** 4.0: harness recognised from the payload or `--format` (`vscode`, `claude`, `cursor`, …). */
  harness?: string;
  /** 4.0: session id as sent by the harness, or the synthetic one the gate derived. */
  session?: string;
  /** 4.0: write-named tool with nothing on disk to judge (`create_issue`, `TodoWrite`): allowed, recorded. */
  no_target?: true;
  /** 4.0 (S-1414): 1-based position inside its file; absent only when the chain was not available. */
  seq?: number;
  /**
   * 4.0 (S-1414): `sha256:<hex>` of the previous line's exact bytes (no trailing newline). The
   * first line of a file carries the last line of the previous file, or `sha256:""`. The two
   * sentinels `unknown` (the append could not take the lock) and `pruned` (retention rewrote the
   * file) mark a documented gap, not tampering.
   */
  prev?: string;
}

/**
 * sha256 of the JCS form of the normalised tool input. A value JCS refuses (lone surrogate,
 * non-finite number, …) is recorded as `unavailable` with the hash of the empty string.
 */
export function hashArgs(input: unknown): {
  args_hash: `sha256:${string}`;
  args_state: "recorded" | "unavailable";
} {
  try {
    return { args_hash: `sha256:${sha256Hex(canonicalize(input))}`, args_state: "recorded" };
  } catch {
    return { args_hash: `sha256:${sha256Hex("")}`, args_state: "unavailable" };
  }
}

/** OS user running the hook; `unknown` when the platform cannot tell. */
export function principalSubject(): string {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : "unknown";
  } catch {
    return "unknown";
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char id: 10 base32 chars of `now` (ms, sortable) + 16 random base32 chars. */
export function decisionId(now: number = Date.now()): string {
  let t = Math.max(0, Math.floor(now));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[t % 32] ?? "0") + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const b of randomBytes(16)) rand += CROCKFORD[b % 32] ?? "0";
  return time + rand;
}

const SECRET_ONLY = SECRET_PATTERNS.filter((p) => p.kind === "secret");

function globalRe(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * Replace every secret-pattern match in `text` with `[REDACTED:<pattern>]`. Regex patterns are
 * replaced span by span; test-only patterns (`credentialAssignment`) redact the smallest window
 * of up to 6 whitespace-separated tokens that matches, or the whole text as a last resort.
 */
export function redactText(text: string): string {
  let out = text;
  for (const p of SECRET_ONLY) {
    if (p.re !== undefined) {
      out = out.replace(globalRe(p.re), `[REDACTED:${p.name}]`);
      continue;
    }
    if (p.test !== undefined) out = redactWindows(out, p.test, `[REDACTED:${p.name}]`);
  }
  return out;
}

function redactWindows(text: string, test: (t: string) => boolean, mark: string): string {
  let out = text;
  for (let guard = 0; guard < 64 && test(out); guard++) {
    // parts alternate token, separator, token, …; tokens sit at even indexes.
    const parts = out.split(/(\s+)/);
    let replaced = false;
    for (let n = 1; n <= 6 && !replaced; n++) {
      for (let i = 0; i < parts.length && !replaced; i += 2) {
        const end = i + 2 * (n - 1);
        if (end >= parts.length) break;
        if (!test(parts.slice(i, end + 1).join(""))) continue;
        parts.splice(i, end - i + 1, mark);
        replaced = true;
      }
    }
    out = replaced ? parts.join("") : mark;
  }
  return out;
}

/** `sha256(subject)[:16]`; the raw OS user only when `AXIOM_JOURNAL_USERNAME=1`. */
export function journalSubject(subject: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.AXIOM_JOURNAL_USERNAME === "1") return subject;
  return sha256Hex(subject).slice(0, 16);
}

/** The line exactly as appendDecision writes it (redacted, id + enforced filled in). */
export function redactDecision(
  rec: DecisionRecord,
  o: { env?: NodeJS.ProcessEnv; now?: number } = {},
): DecisionRecord {
  const env = o.env ?? process.env;
  const out: DecisionRecord = {
    ...rec,
    id: rec.id ?? decisionId(o.now),
    principal: { subject: journalSubject(rec.principal.subject, env) },
    enforced: rec.enforced ?? env.AXIOM_GATE_OBSERVE !== "1",
  };
  if (out.command !== undefined) out.command = redactText(out.command);
  if (out.reason !== undefined) out.reason = redactText(out.reason);
  if (out.override_reason !== undefined) out.override_reason = redactText(out.override_reason);
  return out;
}

// ------------------------------------------------------------- hash chain --

/**
 * S-1414 / EN-5: the journal was append-only in name only — a flipped `deny`, a deleted override
 * or a forged `allow` was invisible to every reader. Each line now carries `seq` (1-based, inside
 * its file) and `prev` (sha256 of the previous line's bytes); `.axiom/decisions.head` records the
 * newest `{ file, seq, hash }` so an append is O(1) instead of reading a 60 MB file, and
 * `verifyDecisions` re-walks every file including the rotated months.
 */
export const DECISIONS_ARCHIVE_DIR = ".axiom/decisions";
export const DECISIONS_HEAD_FILE = ".axiom/decisions.head";
/** Appends that could not take the chain lock in time: recorded, reported as a gap, never as tampering. */
export const DECISIONS_UNKNOWN_PREV = "unknown";
/** First line after retention rewrote the file: same reason, different cause. */
export const DECISIONS_PRUNED_PREV = "pruned";

const DECISIONS_LOCK_FILE = ".axiom/decisions.lock";
/** Bounded so the gate never stalls on the journal (it is advisory, the decision is not). */
const DECISIONS_LOCK_WAIT_MS = 250;
const DECISIONS_LOCK_STALE_MS = 10_000;

export interface DecisionsHead {
  /** Basename of the file the head belongs to (`decisions.jsonl` or `<YYYY-MM>.jsonl`). */
  file: string;
  seq: number;
  hash: string;
}

/** `sha256:<hex>` of one line's exact bytes (no trailing newline). */
function lineHash(line: string): string {
  return `sha256:${sha256Hex(line)}`;
}

const EMPTY_HASH = lineHash("");

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ageMs(file: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` while holding `.axiom/decisions.lock`, or `undefined` when the lock could not be taken
 * within {@link DECISIONS_LOCK_WAIT_MS} (a crashed holder is stolen after 10 s).
 */
async function withDecisionsLock<T>(root: string, fn: () => Promise<T>): Promise<T | undefined> {
  const lock = path.join(root, DECISIONS_LOCK_FILE);
  const deadline = Date.now() + DECISIONS_LOCK_WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (;;) {
    try {
      handle = await open(lock, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      const age = await ageMs(lock);
      if (age !== undefined && age > DECISIONS_LOCK_STALE_MS) {
        await rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await delay(5);
    }
  }
  try {
    return await fn();
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(lock, { force: true }).catch(() => undefined);
  }
}

async function readHead(root: string): Promise<DecisionsHead | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(root, DECISIONS_HEAD_FILE), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const h = raw as Record<string, unknown>;
    if (typeof h.file !== "string" || typeof h.seq !== "number" || typeof h.hash !== "string") {
      return undefined;
    }
    return { file: h.file, seq: h.seq, hash: h.hash };
  } catch {
    return undefined;
  }
}

async function writeHead(root: string, head: DecisionsHead): Promise<void> {
  const file = path.join(root, DECISIONS_HEAD_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(head)}\n`, "utf8");
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** `seq` of the last line of a file and its hash (`0` / `sha256:""` for an empty one). */
function lastOf(text: string): { seq: number; hash: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return { seq: 0, hash: EMPTY_HASH };
  let seq = lines.length;
  try {
    const o = JSON.parse(last) as { seq?: unknown };
    if (typeof o.seq === "number") seq = o.seq;
  } catch {
    /* an undatable line still contributes a position */
  }
  return { seq, hash: lineHash(last) };
}

/**
 * Where the next line links to. The head file answers it in O(1); a missing or foreign head
 * (first run, rotation, or a lost write) falls back to reading the file, which is then small.
 */
async function tailOf(root: string): Promise<{ seq: number; hash: string }> {
  // Only the CURRENT file can hold something newer than the head; after a rotation it is empty and
  // the head still names the newest line, which lives in the archive.
  let current = "";
  try {
    current = await readFile(path.join(root, DECISIONS_FILE), "utf8");
  } catch {
    current = "";
  }
  const inCurrent = lastOf(current);
  if (inCurrent.seq > 0) return inCurrent;
  const head = await readHead(root);
  if (head !== undefined) return { seq: head.seq, hash: head.hash };
  return { seq: 0, hash: EMPTY_HASH };
}

async function appendLinked(
  root: string,
  file: string,
  rec: DecisionRecord,
  tail: { seq: number; hash: string } | undefined,
): Promise<DecisionRecord> {
  const line = redactDecision(rec);
  if (tail === undefined) line.prev = DECISIONS_UNKNOWN_PREV;
  else {
    line.seq = tail.seq + 1;
    line.prev = tail.hash;
  }
  const text = JSON.stringify(line);
  await appendFile(file, `${text}\n`, "utf8");
  if (tail !== undefined) {
    await writeHead(root, { file: path.basename(file), seq: tail.seq + 1, hash: lineHash(text) });
  }
  return line;
}

/**
 * Append one redacted record (creates `.axiom/`) and return what was written. Throws on fs
 * errors — the gate catches and ignores. Never blocks longer than the lock wait: without the
 * lock the line is still recorded, linked as `unknown`.
 */
export async function appendDecision(root: string, rec: DecisionRecord): Promise<DecisionRecord> {
  const file = path.join(root, DECISIONS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const locked = await withDecisionsLock(root, async () =>
    appendLinked(root, file, rec, await tailOf(root)),
  );
  if (locked !== undefined) return locked;
  return appendLinked(root, file, rec, undefined);
}

/** Every journal file, oldest first: rotated months by name, then the current file. */
export async function journalFiles(root: string): Promise<{ name: string; abs: string }[]> {
  const out: { name: string; abs: string }[] = [];
  const dir = path.join(root, DECISIONS_ARCHIVE_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    names = [];
  }
  for (const n of names)
    out.push({ name: `${DECISIONS_ARCHIVE_DIR}/${n}`, abs: path.join(dir, n) });
  out.push({ name: DECISIONS_FILE, abs: path.join(root, DECISIONS_FILE) });
  return out;
}

export interface DecisionsVerify {
  ok: boolean;
  files: number;
  entries: number;
  /** Lines whose link is a documented sentinel (`unknown` / `pruned`): a gap, not tampering. */
  gaps: number;
  breaks: { file: string; seq?: number; reason: string }[];
}

/**
 * Walk every journal file in order and check that each line's `prev` is the hash of the line
 * before it, across file boundaries. A missing `prev` (a 3.x line) is reported as a gap so a
 * journal written by an older binary still verifies.
 */
export async function verifyDecisions(root: string): Promise<DecisionsVerify> {
  const files = await journalFiles(root);
  const breaks: DecisionsVerify["breaks"] = [];
  let entries = 0;
  let gaps = 0;
  let prevHash = EMPTY_HASH;
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(f.abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    let prevInFile: string | undefined;
    /**
     * The previous line could not be placed in the chain (no `prev`, or a sentinel): the line that
     * follows links to a hash the verifier cannot know, so it is a gap too. Only ONE line is
     * excused, because the line after that has a known hash again.
     */
    let prevUnanchored = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      entries++;
      let got: string | undefined;
      try {
        const o = JSON.parse(line) as { prev?: unknown };
        got = typeof o.prev === "string" ? o.prev : undefined;
      } catch {
        breaks.push({ file: f.name, seq: i + 1, reason: "malformed" });
        prevInFile = lineHash(line);
        prevUnanchored = true;
        continue;
      }
      if (got === undefined || got === DECISIONS_UNKNOWN_PREV || got === DECISIONS_PRUNED_PREV) {
        gaps++;
        prevUnanchored = true;
      } else if (got !== (prevInFile ?? prevHash)) {
        if (prevUnanchored) gaps++;
        else breaks.push({ file: f.name, seq: i + 1, reason: "prev-mismatch" });
        prevUnanchored = false;
      } else {
        prevUnanchored = false;
      }
      prevInFile = lineHash(line);
    }
    if (prevInFile !== undefined) prevHash = prevInFile;
  }
  return { ok: breaks.length === 0, files: files.length, entries, gaps, breaks };
}

/**
 * Re-link `lines` into a fresh chain: `seq` restarts at 1 and the first line is anchored at
 * {@link DECISIONS_PRUNED_PREV}. Used by retention, which removes lines and would otherwise leave
 * every following line pointing at a hash that no longer exists.
 */
export function rechainLines(lines: readonly string[]): string[] {
  let prev = DECISIONS_PRUNED_PREV;
  return lines.map((line, i) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      prev = lineHash(line);
      return line;
    }
    const head: Record<string, unknown> = { ...obj };
    delete head.seq;
    delete head.prev;
    const text = JSON.stringify({ ...head, seq: i + 1, prev });
    prev = lineHash(text);
    return text;
  });
}

/** Rewrite `.axiom/decisions.head` from the current file (retention rebuilt it) or drop it when empty. */
export async function refreshHead(root: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(path.join(root, DECISIONS_FILE), "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    await rm(path.join(root, DECISIONS_HEAD_FILE), { force: true }).catch(() => undefined);
    return;
  }
  const { seq, hash } = lastOf(text);
  await writeHead(root, { file: path.basename(DECISIONS_FILE), seq, hash });
}

export interface RotateResult {
  /** Archive the current file was moved into, when a rotation happened. */
  rotated?: string;
  /** Archive files deleted by the retention window. */
  pruned: string[];
}

/** `YYYY-MM` of an ISO timestamp, or of `now` when the line cannot be dated. */
function monthOf(iso: string | undefined, now: number): string {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  const d = new Date(Number.isNaN(ms) ? now : ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * S-1414: move `.axiom/decisions.jsonl` into `.axiom/decisions/<YYYY-MM>.jsonl` once the month of
 * its last line has passed, so the file a hook appends to stays small (the field journals reached
 * 60 MB in four weeks). `retentionDays` deletes WHOLE archives older than the window — never
 * individual lines, which would break the chain.
 */
export async function rotateDecisions(
  root: string,
  o: { now?: number; retentionDays?: number } = {},
): Promise<RotateResult> {
  const now = o.now ?? Date.now();
  const current = path.join(root, DECISIONS_FILE);
  const result: RotateResult = { pruned: [] };
  let text = "";
  try {
    text = await readFile(current, "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length > 0) {
    const last = lines[lines.length - 1] as string;
    let decidedAt: string | undefined;
    try {
      const o2 = JSON.parse(last) as { decided_at?: unknown };
      if (typeof o2.decided_at === "string") decidedAt = o2.decided_at;
    } catch {
      /* undatable: rotate under the current month */
    }
    const month = monthOf(decidedAt, now);
    const dir = path.join(root, DECISIONS_ARCHIVE_DIR);
    const target = path.join(dir, `${month}.jsonl`);
    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (month !== monthOf(new Date(now).toISOString(), now) || exists) {
      await mkdir(dir, { recursive: true });
      await appendFile(target, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      await writeFile(current, "", "utf8");
      await writeHead(root, {
        file: `${month}.jsonl`,
        seq: lastOf(text).seq,
        hash: lastOf(text).hash,
      });
      result.rotated = `${DECISIONS_ARCHIVE_DIR}/${month}.jsonl`;
    }
  }
  if (o.retentionDays !== undefined && o.retentionDays > 0) {
    const cutoff = monthOf(new Date(now - o.retentionDays * 86_400_000).toISOString(), now);
    let names: string[] = [];
    try {
      names = (await readdir(path.join(root, DECISIONS_ARCHIVE_DIR))).filter((n) =>
        /^\d{4}-\d{2}\.jsonl$/.test(n),
      );
    } catch {
      names = [];
    }
    for (const n of names.sort()) {
      if (n.slice(0, 7) >= cutoff) continue;
      await rm(path.join(root, DECISIONS_ARCHIVE_DIR, n), { force: true });
      result.pruned.push(`${DECISIONS_ARCHIVE_DIR}/${n}`);
    }
  }
  return result;
}

function isDecisionRecord(v: unknown): v is DecisionRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.decided_at === "string" &&
    typeof r.agent_id === "string" &&
    typeof r.tool === "string" &&
    typeof r.args_hash === "string" &&
    (r.decision === "allow" || r.decision === "deny" || r.decision === "ask") &&
    Array.isArray(r.paths)
  );
}

/**
 * Every well-formed record, in file order (rotated months first, then the current file). `since`
 * (ISO) keeps records decided at or after it. Malformed lines are skipped; a missing journal is an
 * empty list. Every reader goes through here, so a rotated month is never invisible.
 */
export async function readDecisions(
  root: string,
  opts: { since?: string } = {},
): Promise<DecisionRecord[]> {
  const sinceMs = opts.since === undefined ? undefined : Date.parse(opts.since);
  const out: DecisionRecord[] = [];
  for (const file of await journalFiles(root)) {
    let text: string;
    try {
      text = await readFile(file.abs, "utf8");
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") continue;
      throw err;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isDecisionRecord(parsed)) continue;
      if (sinceMs !== undefined && !Number.isNaN(sinceMs)) {
        const at = Date.parse(parsed.decided_at);
        if (Number.isNaN(at) || at < sinceMs) continue;
      }
      out.push(parsed);
    }
  }
  return out;
}
