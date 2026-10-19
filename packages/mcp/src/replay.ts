/**
 * `axiom journal replay --session <agent_id|session> [--root <dir>] [--profile <file>] [--json]`
 * (3.0, I-9, D-45): re-judge every journaled decision of one agent session with the CURRENT
 * profile and print what would change. Read-only towards the repository.
 *
 * The journal keeps no file content (only a hash of the arguments), so content predicates
 * (`noSecrets`, `maxBytes`) cannot fire on replay — a decision that was decided by one is
 * reported as `skipped`. Shell decisions replay only when the record carries the command
 * (shadow / relaxed lines). Session rules (`sessions`) depend on live session state and are not
 * replayed.
 *
 * Side-effect freedom: the gate journals relaxed decisions, captures undo pre-images, records
 * session writes and claims steer hints. Replay therefore judges with a sanitised COPY of the
 * profile written to the OS temp dir (record/shadow/undo off, no `sessions`, `steer: off`,
 * `mode: enforce`, `override: false`) and applies warn/override relaxation itself, exactly as the
 * gate does (hard codes and asks are never relaxed).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type DecisionRecord, readDecisions } from "./decisions.js";
import { ascii, type CliIo } from "./fleet.js";
import {
  extractTargets,
  type GateProfile,
  isHardCode,
  loadGateProfile,
  loadGateProfileForRoot,
  normalizePayload,
  runGate,
} from "./gate.js";
import { realDir } from "./roots.js";

export type ReplayVerdict = "allow" | "deny" | "ask" | "warn" | "override";

export interface ReplayRow {
  /** 1-based position in the journal. */
  index: number;
  decided_at: string;
  tool: string;
  paths: string[];
  old: ReplayVerdict;
  oldCode?: string;
  new?: ReplayVerdict;
  newCode?: string;
  changed: boolean;
  skipped?: string;
}

export interface ReplayResult {
  root: string;
  session: string;
  profile: string;
  rows: ReplayRow[];
  changed: number;
  skipped: number;
  notes: string[];
}

const CONTENT_CODE_RE = /^content\./;
/**
 * Write records are replayed as a targeted `Edit` of each judged path: the original tool's
 * arguments are not journaled, and a whole-file tool name would make the gate leave a
 * denied-create marker (stale-script rule) in `.axiom/`.
 */
export const REPLAY_WRITE_TOOL = "Edit";

/** True when `agentId` (`<harness>:<session>`) belongs to the selector. */
export function sessionMatches(agentId: string, selector: string): boolean {
  if (agentId === selector) return true;
  const i = agentId.indexOf(":");
  return i >= 0 && agentId.slice(i + 1) === selector;
}

export function oldVerdict(r: DecisionRecord): ReplayVerdict {
  if (r.relaxed === "warn") return "warn";
  if (r.relaxed === "override") return "override";
  return r.decision;
}

/** The profile the replay gate runs with: same policy, none of the gate's write side effects. */
export function sanitizeProfile(p: GateProfile): Record<string, unknown> {
  const { sessions: _s, ...rest } = p;
  return {
    ...rest,
    record: false,
    shadow: false,
    undo: false,
    steer: "off",
    mode: "enforce",
    override: false,
  };
}

/** Apply warn / override relaxation the way the gate does. */
export function relaxVerdict(
  verdict: "allow" | "deny" | "ask",
  code: string | undefined,
  profile: GateProfile,
  overrideStated: boolean,
): ReplayVerdict {
  if (verdict !== "deny" || code === undefined || isHardCode(profile.hard, code)) return verdict;
  if (profile.override && overrideStated) return "override";
  if (profile.mode === "warn") return "warn";
  return verdict;
}

/** Payloads rebuilt from one record, or the reason it cannot be replayed. */
export function rebuildPayloads(
  r: DecisionRecord,
  root: string,
): { payloads: Record<string, unknown>[] } | { skip: string } {
  if (r.phase === "post") return { skip: "post-write check (needs the tool result)" };
  if (CONTENT_CODE_RE.test(r.code ?? "")) {
    return { skip: `decided by ${r.code ?? "a content check"}; content is not journaled` };
  }
  const base = { hook_event_name: "PreToolUse", tool_name: r.tool, cwd: root };
  const probe = normalizePayload({ ...base, tool_input: { command: "true" } });
  const cls = probe === undefined ? "other" : extractTargets(probe).cls;
  if (cls === "other") return { skip: `tool ${r.tool} is not a write/shell tool` };
  if (r.command !== undefined) {
    return { payloads: [{ ...base, tool_input: { command: r.command } }] };
  }
  if (cls === "shell") {
    return { skip: "shell command not journaled (only shadow / relaxed lines carry it)" };
  }
  const paths = r.paths.filter((p) => p !== ".");
  if (paths.length === 0) return { skip: "no judged path in the record" };
  return {
    payloads: paths.map((p) => ({
      ...base,
      tool_name: REPLAY_WRITE_TOOL,
      tool_input: { file_path: p },
    })),
  };
}

const RANK: Record<ReplayVerdict, number> = { allow: 0, warn: 1, override: 1, ask: 2, deny: 3 };

export interface ReplayOptions {
  root: string;
  session: string;
  profilePath?: string;
  home?: string;
}

export async function replaySession(o: ReplayOptions): Promise<ReplayResult> {
  const notes: string[] = [];
  const loaded =
    o.profilePath === undefined
      ? await loadGateProfileForRoot(o.root, o.home === undefined ? {} : { home: o.home })
      : await loadGateProfile({
          root: o.root,
          profilePath: o.profilePath,
          ...(o.home === undefined ? {} : { home: o.home }),
        });
  const profile = loaded.profile;
  if (profile.sessions !== undefined) notes.push("sessions rules are not replayed (live state)");
  const all = await readDecisions(o.root);
  const mine = all
    .map((r, i) => ({ r, index: i + 1 }))
    .filter(({ r }) => sessionMatches(r.agent_id, o.session));
  const dir = await mkdtemp(path.join(tmpdir(), "axiom-replay-"));
  const rows: ReplayRow[] = [];
  try {
    const tmpProfile = path.join(dir, "gate-profile.json");
    await writeFile(tmpProfile, JSON.stringify(sanitizeProfile(profile)), "utf8");
    for (const { r, index } of mine) {
      const old = oldVerdict(r);
      const row: ReplayRow = {
        index,
        decided_at: r.decided_at,
        tool: r.tool,
        paths: r.paths,
        old,
        ...(r.code === undefined ? {} : { oldCode: r.code }),
        changed: false,
      };
      const rebuilt = rebuildPayloads(r, o.root);
      if ("skip" in rebuilt) {
        rows.push({ ...row, skipped: rebuilt.skip });
        continue;
      }
      let worst: { v: ReplayVerdict; code?: string } = { v: "allow" };
      for (const payload of rebuilt.payloads) {
        const g = await runGate(JSON.stringify(payload), {
          root: o.root,
          profilePath: tmpProfile,
          noRootDiscovery: true,
          cwdFallback: () => o.root,
          ...(o.home === undefined ? {} : { home: o.home }),
        });
        const raw = g.verdict === "ask" ? "ask" : g.decision;
        const v = relaxVerdict(raw, g.code, profile, r.relaxed === "override");
        if (RANK[v] > RANK[worst.v]) worst = g.code === undefined ? { v } : { v, code: g.code };
      }
      rows.push({
        ...row,
        new: worst.v,
        ...(worst.code === undefined ? {} : { newCode: worst.code }),
        changed: worst.v !== old || (worst.code !== undefined && worst.code !== r.code),
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    root: o.root,
    session: o.session,
    profile: loaded.source,
    rows,
    changed: rows.filter((x) => x.changed).length,
    skipped: rows.filter((x) => x.skipped !== undefined).length,
    notes,
  };
}

export function renderReplay(r: ReplayResult): string[] {
  const lines = [
    `axiom journal replay: session ${r.session}, ${r.rows.length} decision(s), ${r.changed} changed, ${r.skipped} skipped (profile ${r.profile})`,
  ];
  if (r.rows.length === 0) lines.push("no journaled decision for this session");
  for (const x of r.rows) {
    const what = `#${x.index} ${x.decided_at} ${x.tool} ${x.paths.join(",") || "-"}`;
    const old = `${x.old}${x.oldCode === undefined ? "" : ` ${x.oldCode}`}`;
    if (x.skipped !== undefined) lines.push(`  SKIP ${what}: ${old} (${x.skipped})`);
    else {
      const nw = `${x.new ?? "?"}${x.newCode === undefined ? "" : ` ${x.newCode}`}`;
      lines.push(`  ${x.changed ? "DIFF" : "SAME"} ${what}: ${old} -> ${nw}`);
    }
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.map(ascii);
}

export const REPLAY_USAGE =
  "usage: axiom journal replay --session <agent_id|session> [--root <dir>] [--profile <file>] [--json]";

/** `axiom journal replay`. Exit 0 = nothing changed, 1 = some verdict changed, 2 = usage/profile. */
export async function replayMain(argv: string[], io: CliIo): Promise<number> {
  let values: { root?: string; session?: string; profile?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        session: { type: "string" },
        profile: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.stderr(`ERR_USAGE ${err instanceof Error ? err.message : String(err)}\n${REPLAY_USAGE}`);
    return 2;
  }
  if (values.session === undefined || values.session === "") {
    io.stderr(`ERR_USAGE --session is required\n${REPLAY_USAGE}`);
    return 2;
  }
  let root: string;
  try {
    root = await realDir(path.resolve(values.root ?? "."), "ERR_ROOT_NOT_DIR");
  } catch {
    io.stderr(`ERR_ROOT_NOT_DIR ${ascii(path.resolve(values.root ?? "."))}`);
    return 2;
  }
  let r: ReplayResult;
  try {
    r = await replaySession({
      root,
      session: values.session,
      ...(values.profile === undefined ? {} : { profilePath: path.resolve(values.profile) }),
      ...(io.home === undefined ? {} : { home: io.home }),
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "ERR_INTERNAL";
    io.stderr(ascii(`${code} ${err instanceof Error ? err.message : String(err)}`));
    return 2;
  }
  if (values.json === true) io.stdout(JSON.stringify(r, null, 2));
  else for (const l of renderReplay(r)) io.stdout(l);
  return r.changed > 0 ? 1 : 0;
}
