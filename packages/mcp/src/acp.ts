/**
 * ACP (Agent Client Protocol, agentclientprotocol.com — Zed, JetBrains, OpenCode, Gemini CLI …)
 * adapter for the AXIOM gate. ACP has no hook API: an agent asks the CLIENT for permission with
 * `session/request_permission` `{sessionId, toolCall:{toolCallId, name?, title, kind, locations?,
 * rawInput?, content?}, options:[{optionId, name, kind: allow_once|allow_always|reject_once|
 * reject_always}]}` and the client answers `{outcome:{outcome:"selected", optionId}}` or
 * `{outcome:{outcome:"cancelled"}}` (spec re-read 2026-10-19).
 *
 * - {@link acpPermissionDecision} maps one request to gate payloads (one per target), runs the
 *   in-process gate and picks the matching option.
 * - {@link runAcpProxy} sits between client and agent on line-delimited JSON-RPC stdio, forwards
 *   every message unchanged, and answers `session/request_permission` ITSELF only when the gate
 *   denies — an allow is forwarded so the human keeps the final say.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { type GateOptions, type GateResult, runGate } from "./gate.js";

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: AcpPermissionOptionKind | string;
}

export interface AcpToolCall {
  toolCallId?: string;
  name?: string | null;
  title?: string;
  kind?: string;
  locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown;
  content?: unknown[] | null;
}

export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface AcpDecision {
  outcome: AcpOutcome;
  decision: "allow" | "deny";
  /** First deny reason (`AXIOM GATE DENY <code>: …`). */
  reason?: string;
  code?: string;
}

export type GateRunner = (payloadText: string, opts: GateOptions) => Promise<GateResult>;

export interface AcpGateOptions {
  /** Session working directory (ACP `session/new` `cwd`); absolute. */
  cwd: string;
  /** Extra gate options (`profilePath`, `home`, …). `format` is always `claude`. */
  gate?: GateOptions;
  /** Test seam; default the in-process {@link runGate}. */
  runGate?: GateRunner;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const WRITE_KINDS = new Set(["edit", "delete", "move"]);

/** `{path, newText}` of every ACP `diff` content item. */
function diffs(call: AcpToolCall): { path: string; newText: string | undefined }[] {
  const out: { path: string; newText: string | undefined }[] = [];
  for (const c of call.content ?? []) {
    const r = asRecord(c);
    if (r?.type === "diff" && typeof r.path === "string" && r.path !== "") {
      out.push({ path: r.path, newText: typeof r.newText === "string" ? r.newText : undefined });
    }
  }
  return out;
}

function commandOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  const r = asRecord(raw);
  if (r === undefined) return undefined;
  for (const k of ["command", "cmd", "commandLine", "script"]) {
    const v = r[k];
    if (typeof v === "string" && v !== "") {
      const args = Array.isArray(r.args) ? r.args.filter((a) => typeof a === "string") : [];
      return [v, ...args].join(" ");
    }
    if (Array.isArray(v) && v.every((a) => typeof a === "string")) return v.join(" ");
  }
  return undefined;
}

/**
 * Gate payloads (Claude shape) for one ACP tool call: `edit`/`move` → one `Write` per target
 * (diff content first, then `locations`, then a path in `rawInput`), `delete` → `delete_file`,
 * `execute` → `Bash`, anything else → the tool's own `name` + `rawInput` (the gate classifies by
 * name; a nameless read/search/think call is allowed). A write kind with no target yields one
 * pathless `Write` so the gate denies it (`ERR_UNSUPPORTED_OP`) — never a silent allow.
 */
export function acpToGatePayloads(
  call: AcpToolCall,
  cwd: string,
  sessionId?: string,
): Record<string, unknown>[] {
  const base = {
    hook_event_name: "PreToolUse",
    cwd,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
  const raw = asRecord(call.rawInput) ?? {};
  const kind = call.kind ?? "other";
  if (WRITE_KINDS.has(kind)) {
    const tool = kind === "delete" ? "delete_file" : "Write";
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    const add = (p: string, content?: string) => {
      if (seen.has(p)) return;
      seen.add(p);
      out.push({
        ...base,
        tool_name: tool,
        tool_input: content === undefined ? { file_path: p } : { file_path: p, content },
      });
    };
    for (const d of diffs(call)) add(d.path, d.newText);
    for (const l of call.locations ?? []) if (typeof l?.path === "string" && l.path) add(l.path);
    for (const k of ["file_path", "filePath", "path", "destination", "target"]) {
      const v = raw[k];
      if (typeof v === "string" && v !== "")
        add(v, typeof raw.content === "string" ? raw.content : undefined);
    }
    return out.length > 0 ? out : [{ ...base, tool_name: tool, tool_input: {} }];
  }
  if (kind === "execute") {
    const command = commandOf(call.rawInput);
    return [{ ...base, tool_name: "Bash", tool_input: command === undefined ? {} : { command } }];
  }
  const name = typeof call.name === "string" && call.name !== "" ? call.name : undefined;
  return name === undefined ? [] : [{ ...base, tool_name: name, tool_input: raw }];
}

function pick(
  options: readonly AcpPermissionOption[],
  kinds: readonly string[],
): string | undefined {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o !== undefined) return o.optionId;
  }
  return undefined;
}

/**
 * Judge one `session/request_permission`. Allow → the `allow_once` option (never `allow_always`
 * on the user's behalf); deny (or ask) → `reject_once`, else `reject_always`, else `cancelled`.
 * A gate that throws is a deny (fail closed).
 */
export async function acpPermissionDecision(
  request: AcpPermissionRequest,
  opts: AcpGateOptions,
): Promise<AcpDecision> {
  const gate = opts.runGate ?? runGate;
  let denied: { reason?: string; code?: string } | undefined;
  for (const p of acpToGatePayloads(request.toolCall, opts.cwd, request.sessionId)) {
    let r: GateResult;
    try {
      r = await gate(JSON.stringify(p), { ...opts.gate, root: opts.cwd, format: "claude" });
    } catch (err) {
      denied = {
        reason: `AXIOM GATE DENY ERR_INTERNAL: ${err instanceof Error ? err.message : String(err)}`,
      };
      break;
    }
    if (r.decision === "deny") {
      const reason = r.stderr.find((l) => l.startsWith("AXIOM GATE"));
      denied = {
        ...(reason === undefined ? {} : { reason }),
        ...(r.code === undefined ? {} : { code: r.code }),
      };
      break;
    }
  }
  if (denied === undefined) {
    const id = pick(request.options, ["allow_once", "allow_always"]);
    // No allow option at all: nothing to select; the proxy forwards to the human.
    return {
      outcome: id === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: id },
      decision: "allow",
    };
  }
  const id = pick(request.options, ["reject_once", "reject_always"]);
  return {
    outcome: id === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: id },
    decision: "deny",
    ...denied,
  };
}

// ----------------------------------------------------------------- proxy --

export interface AcpProxyOptions {
  /** Lines from the ACP client (the proxy's stdin). */
  clientIn: Readable;
  /** Lines to the ACP client (the proxy's stdout). */
  clientOut: Writable;
  /** Lines from the agent (its stdout). */
  agentIn: Readable;
  /** Lines to the agent (its stdin). */
  agentOut: Writable;
  /** Fallback cwd when a session's `cwd` was not seen (`--root`). */
  root: string;
  gate?: GateOptions;
  /** Test seam. */
  decide?: (req: AcpPermissionRequest, cwd: string) => Promise<AcpDecision>;
  /** Called with every gate deny the proxy answered (stderr logging). */
  onDeny?: (d: AcpDecision, req: AcpPermissionRequest) => void;
}

type Json = Record<string, unknown>;

function parseLine(line: string): Json | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

const idKey = (id: unknown): string => JSON.stringify(id);

/**
 * Forward line-delimited JSON-RPC both ways. Session cwds are learned from `session/new` (request
 * `cwd` + response `sessionId`) and `session/load` (`sessionId` + `cwd`). Agent → client lines are
 * handled in order, so a permission answer can never be overtaken by a later message. Resolves
 * when both inbound streams have ended.
 */
export async function runAcpProxy(opts: AcpProxyOptions): Promise<void> {
  const sessionCwd = new Map<string, string>();
  const pendingNew = new Map<string, string>();
  const decide =
    opts.decide ??
    ((req: AcpPermissionRequest, cwd: string) =>
      acpPermissionDecision(req, { cwd, ...(opts.gate === undefined ? {} : { gate: opts.gate }) }));
  const send = (w: Writable, msg: string) => {
    w.write(`${msg}\n`);
  };

  const fromClient = (async () => {
    for await (const line of createInterface({ input: opts.clientIn, crlfDelay: Infinity })) {
      const msg = parseLine(line);
      const params = asRecord(msg?.params);
      if (
        msg?.method === "session/new" &&
        msg.id !== undefined &&
        typeof params?.cwd === "string"
      ) {
        pendingNew.set(idKey(msg.id), params.cwd);
      } else if (
        msg?.method === "session/load" &&
        typeof params?.sessionId === "string" &&
        typeof params.cwd === "string"
      ) {
        sessionCwd.set(params.sessionId, params.cwd);
      }
      send(opts.agentOut, line);
    }
    opts.agentOut.end();
  })();

  const fromAgent = (async () => {
    for await (const line of createInterface({ input: opts.agentIn, crlfDelay: Infinity })) {
      const msg = parseLine(line);
      if (msg !== undefined && msg.method === undefined && msg.id !== undefined) {
        const cwd = pendingNew.get(idKey(msg.id));
        const sid = asRecord(msg.result)?.sessionId;
        if (cwd !== undefined) {
          pendingNew.delete(idKey(msg.id));
          if (typeof sid === "string") sessionCwd.set(sid, cwd);
        }
      }
      const params = asRecord(msg?.params);
      if (msg?.method === "session/request_permission" && msg.id !== undefined && params) {
        const req = params as unknown as AcpPermissionRequest;
        const cwd =
          (typeof req.sessionId === "string" ? sessionCwd.get(req.sessionId) : undefined) ??
          opts.root;
        let d: AcpDecision;
        try {
          d = await decide(req, cwd);
        } catch (err) {
          d = {
            outcome: { outcome: "cancelled" },
            decision: "deny",
            reason: `AXIOM GATE DENY ERR_INTERNAL: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (d.decision === "deny") {
          opts.onDeny?.(d, req);
          send(
            opts.agentOut,
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: d.outcome } }),
          );
          continue;
        }
      }
      send(opts.clientOut, line);
    }
    opts.clientOut.end();
  })();

  await Promise.all([fromClient, fromAgent]);
}

/**
 * `axiom acp-proxy --root <dir> -- <agent> [args…]`: spawn the agent (args array, no shell) and
 * proxy the given client streams to it. Resolves with the agent's exit code.
 */
export async function runAcpProxyWithAgent(
  argv: readonly string[],
  io: {
    clientIn: Readable;
    clientOut: Writable;
    root: string;
    gate?: GateOptions;
    onDeny?: AcpProxyOptions["onDeny"];
  },
  spawnAgent: (argv: readonly string[]) => ChildProcess = (a) =>
    spawn(a[0] ?? "", a.slice(1), { stdio: ["pipe", "pipe", "inherit"], windowsHide: true }),
): Promise<number> {
  if (argv.length === 0) throw new Error("acp-proxy needs the agent command after --");
  const child = spawnAgent(argv);
  if (child.stdin === null || child.stdout === null) throw new Error("agent stdio is not piped");
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
  await runAcpProxy({
    clientIn: io.clientIn,
    clientOut: io.clientOut,
    agentIn: child.stdout,
    agentOut: child.stdin,
    root: io.root,
    ...(io.gate === undefined ? {} : { gate: io.gate }),
    ...(io.onDeny === undefined ? {} : { onDeny: io.onDeny }),
  });
  return exited;
}
