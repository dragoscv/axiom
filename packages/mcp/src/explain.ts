/**
 * `axiom explain <decision-id|last|-N|N> [--root <dir>]` (3.0, I-6, D-45): one journaled gate
 * decision in plain words, plus the fix for its code family. Read-only.
 *
 * Selectors: `last` (= `-1`), `-N` (N-th from the end), `N` (1-based position in the journal),
 * or a record `id` when the journal lines carry one.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { HOUSE_PACK } from "./command-rules.js";
import { type DecisionRecord, readDecisions } from "./decisions.js";
import { ascii, type CliIo } from "./fleet.js";
import { realDir } from "./roots.js";

/** A journal line, plus the optional fields newer gates add. */
export type ExplainRecord = DecisionRecord & { id?: string; profile_decided?: string };

export interface Explained {
  /** 1-based position in the journal. */
  index: number;
  record: ExplainRecord;
  fix?: string;
}

/** Resolve a selector against the journal; `undefined` when nothing matches. */
export function selectDecision(
  records: readonly ExplainRecord[],
  selector: string,
): { index: number; record: ExplainRecord } | undefined {
  const s = selector.trim();
  let i: number | undefined;
  if (s === "last") i = records.length - 1;
  else if (/^-\d+$/.test(s)) i = records.length - Number(s.slice(1));
  else if (/^\d+$/.test(s)) i = Number(s) - 1;
  if (i === undefined) {
    const at = records.findIndex((r) => r.id === s);
    if (at < 0) return undefined;
    i = at;
  }
  const record = records[i];
  return record === undefined ? undefined : { index: i + 1, record };
}

const HOUSE_FIX = new Map(
  HOUSE_PACK.filter((r) => r.id !== undefined).map((r) => [r.id as string, r]),
);

/** The fix line for a decision code (and rule id), `undefined` for codes without a known fix. */
export function fixFor(code: string | undefined, rule?: string): string | undefined {
  const id = rule ?? code;
  if (id?.startsWith("house.")) {
    const r = HOUSE_FIX.get(id);
    if (r !== undefined) return r.fix ?? `${r.reason} (ask the user; no automatic fix)`;
  }
  if (code === undefined) return undefined;
  if (code === "path.deny" || code === "path.allow") {
    return "edit the profile deny/allow list (.axiom/gate-profile.json), or state `axiom-override: <reason>` if the profile allows overrides";
  }
  if (code === "path.ask") return "a human must approve this path (profile `ask` globs)";
  if (code === "ERR_CONTAINMENT") {
    return "the target is outside the root: set `outside` (warn|allow) in the gate profile, or work inside the repository / a worktree of it";
  }
  if (code.startsWith("content.noSecrets")) {
    return "move the secret to an environment variable or a secret store and reference it; for test fixtures, exclude the path in the profile";
  }
  if (code.startsWith("content.maxBytes"))
    return "split the file or raise `maxBytes` in the profile";
  if (code === "git.destructiveTree") {
    return "do not clean/reset the whole tree in a shared clone; name the paths, or ask the user";
  }
  if (code === "ERR_PROFILE_VERSION")
    return "upgrade the axiom bin: npm install -g @codai/axiom-mcp@latest";
  if (code === "ERR_INVALID_PROFILE")
    return "fix .axiom/gate-profile.json (axiom setup doctor shows the error)";
  if (code === "steer.requireApply")
    return "write through the axiom_write MCP tool instead of a direct edit";
  if (code === "ERR_UNSUPPORTED_OP")
    return "the tool carries no recognised path key; report the tool shape";
  if (code === "ERR_INTERNAL") return "the gate failed internally; rerun with --log-level debug";
  return undefined;
}

export function explainDecision(
  records: readonly ExplainRecord[],
  selector: string,
): Explained | undefined {
  const hit = selectDecision(records, selector);
  if (hit === undefined) return undefined;
  const fix = fixFor(hit.record.code, hit.record.rule);
  return fix === undefined ? hit : { ...hit, fix };
}

export function renderExplained(e: Explained, total: number): string[] {
  const r = e.record;
  const lines = [
    `decision #${e.index} of ${total}${r.id === undefined ? "" : ` (id ${r.id})`}`,
    `  when:      ${r.decided_at}`,
    `  agent:     ${r.agent_id}`,
    `  tool:      ${r.tool}`,
    `  decision:  ${r.decision}${r.shadow === true ? " (shadow: would have)" : ""}${r.phase === "post" ? " (post-write check)" : ""}`,
  ];
  if (r.code !== undefined) lines.push(`  code:      ${r.code}`);
  if (r.rule !== undefined) lines.push(`  rule:      ${r.rule}`);
  if (r.reason !== undefined) lines.push(`  reason:    ${r.reason}`);
  lines.push(`  profile:   ${r.profile}`);
  if (r.profile_decided !== undefined) lines.push(`  decided by profile: ${r.profile_decided}`);
  lines.push(`  paths:     ${r.paths.length === 0 ? "-" : r.paths.join(", ")}`);
  if (r.command !== undefined) lines.push(`  command:   ${r.command}`);
  if (r.relaxed !== undefined) {
    lines.push(
      `  relaxed:   ${r.relaxed}${r.override_reason === undefined ? "" : ` (reason: ${r.override_reason})`}`,
    );
  }
  if (e.fix !== undefined) lines.push(`  FIX:       ${e.fix}`);
  return lines.map(ascii);
}

export const EXPLAIN_USAGE = "usage: axiom explain <decision-id|last|-N|N> [--root <dir>] [--json]";

/** `axiom explain`. Exit 0 found, 1 not found / empty journal, 2 usage error. */
export async function explainMain(argv: string[], io: CliIo): Promise<number> {
  let values: { root?: string; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { root: { type: "string" }, json: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
      allowNegative: false,
    }));
  } catch (err) {
    io.stderr(`ERR_USAGE ${err instanceof Error ? err.message : String(err)}\n${EXPLAIN_USAGE}`);
    return 2;
  }
  const selector = positionals[0] ?? "last";
  if (positionals.length > 1) {
    io.stderr(`ERR_USAGE one selector expected\n${EXPLAIN_USAGE}`);
    return 2;
  }
  let root: string;
  try {
    root = await realDir(path.resolve(values.root ?? "."), "ERR_ROOT_NOT_DIR");
  } catch {
    io.stderr(`ERR_ROOT_NOT_DIR ${ascii(path.resolve(values.root ?? "."))}`);
    return 2;
  }
  const records = (await readDecisions(root)) as ExplainRecord[];
  const e = explainDecision(records, selector);
  if (e === undefined) {
    io.stderr(
      ascii(
        records.length === 0
          ? `ERR_NOT_FOUND no decisions in ${root}/.axiom/decisions.jsonl (set "record": true in the gate profile)`
          : `ERR_NOT_FOUND no decision matches ${selector} (${records.length} in the journal)`,
      ),
    );
    return 1;
  }
  if (values.json === true) io.stdout(JSON.stringify({ ...e, total: records.length }, null, 2));
  else for (const l of renderExplained(e, records.length)) io.stdout(l);
  return 0;
}
