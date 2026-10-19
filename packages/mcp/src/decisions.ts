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
import { appendFile, mkdir, readFile } from "node:fs/promises";
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

/**
 * Append one redacted record (creates `.axiom/`) and return what was written. Throws on fs
 * errors — the gate catches and ignores.
 */
export async function appendDecision(root: string, rec: DecisionRecord): Promise<DecisionRecord> {
  const file = path.join(root, DECISIONS_FILE);
  const line = redactDecision(rec);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
  return line;
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
 * Every well-formed record, in file order. `since` (ISO) keeps records decided at or after it.
 * Malformed lines are skipped; a missing journal is an empty list.
 */
export async function readDecisions(
  root: string,
  opts: { since?: string } = {},
): Promise<DecisionRecord[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, DECISIONS_FILE), "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return [];
    throw err;
  }
  const sinceMs = opts.since === undefined ? undefined : Date.parse(opts.since);
  const out: DecisionRecord[] = [];
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
  return out;
}
