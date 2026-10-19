/**
 * Decision journal (Phase 8, D-36): one JSON line per write/shell-class tool call the gate
 * judged, appended to `<root>/.axiom/decisions.jsonl` when the gate profile sets
 * `record: true`. Each record maps 1:1 onto an in-toto agent-decision Statement
 * (`buildAgentDecisionStatement` in `@codai/axiom-canon`), so `axiom attest decisions` can sign
 * them later without re-reading the payloads (only the JCS hash of the arguments is kept).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import * as path from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";

export const DECISIONS_FILE = ".axiom/decisions.jsonl";

export interface DecisionRecord {
  v: 1;
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

/** Append one record (creates `.axiom/`). Throws on fs errors — the gate catches and ignores. */
export async function appendDecision(root: string, rec: DecisionRecord): Promise<void> {
  const file = path.join(root, DECISIONS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(rec)}\n`, "utf8");
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
