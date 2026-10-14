/**
 * `axiom gate --stdin --post` — PostToolUse check of what a tool ACTUALLY changed (S-1205).
 *
 * The PreToolUse gate judges what a tool says it will write; a shell command can still write
 * somewhere the scan did not see. After the tool ran, the harness hands us its result:
 *   - Claude Code `Bash`: `tool_response.bashEditDiff` (v2.1.269+, public beta — "best effort",
 *     `changedFiles[]` absolute paths, `files[]` diffs with `created`/`deleted`);
 *   - Claude `Write`/`Edit`: `tool_response.filePath`;
 *   - everything else (Codex `tool_response`, VS Code `tool_response`, Copilot CLI `toolResult`,
 *     no diff field): the write targets of `tool_input` — file tools by path key, shell tools by
 *     the gate's write-primitive scan (`extractShellWriteTargets`).
 * Those paths run through the same predicates as the gate (`path.deny`, `path.allow`,
 * `content.noSecrets`, `content.maxBytes`). Clean → allow, nothing on stdout. A protected path
 * changed → a "block" document in the harness's PostToolUse shape telling the agent to revert:
 * a post hook cannot undo the write, and the reason says so.
 *
 * Fail-closed is meaningless after the fact: any internal error → allow + one stderr warning.
 * Never throws; never writes to stdout/stderr itself (`check-no-stdout`).
 */
import { realpath as realpathCb } from "node:fs";
import * as path from "node:path";
import { parseArgs, promisify } from "node:util";
import { appendDecision, hashArgs, principalSubject } from "./decisions.js";
import {
  discoverRoot,
  extractTargets,
  GateDeny,
  type GateProfile,
  type GateResult,
  type GateTarget,
  loadGateProfile,
  type NormalizedPayload,
  normalizePayload,
  type ResolvedGateTarget,
  resolveGateTarget,
  runGatePredicates,
  sameRepoWorktreeRoot,
  type ToolClass,
} from "./gate.js";
import { type GateFormat, isGateFormat } from "./gate-fast.js";

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
const IS_WIN32 = process.platform === "win32";

export interface PostIo {
  read: { text: string | undefined; timedOut: boolean; tooLarge: boolean };
  cwdFallback?: () => string;
  home?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** The tool's result object, whichever harness sent it (a JSON string is parsed). */
export function toolResponse(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const k of ["tool_response", "toolResponse", "toolResult", "tool_result", "tool_output"]) {
    const v = raw[k];
    if (typeof v === "string") {
      try {
        const parsed = asRecord(JSON.parse(v));
        if (parsed !== undefined) return parsed;
      } catch {
        // plain-text result: nothing structured to read
      }
      continue;
    }
    const rec = asRecord(v);
    if (rec !== undefined) return rec;
  }
  return undefined;
}

/**
 * Paths the tool reports it changed: Claude `bashEditDiff.changedFiles[]` / `files[]` and
 * `filePath` of Write/Edit results. Empty when the harness reports nothing structured.
 */
export function reportedChanges(response: Record<string, unknown> | undefined): GateTarget[] {
  if (response === undefined) return [];
  const out = new Map<string, GateTarget>();
  const add = (rawPath: unknown, op: "write" | "delete") => {
    if (typeof rawPath !== "string" || rawPath.length === 0) return;
    const prev = out.get(rawPath);
    if (prev === undefined || op === "delete")
      out.set(rawPath, { rawPath, op, content: undefined });
  };
  const diff = asRecord(response.bashEditDiff);
  if (diff !== undefined) {
    if (Array.isArray(diff.changedFiles)) for (const p of diff.changedFiles) add(p, "write");
    if (Array.isArray(diff.files)) {
      for (const f of diff.files) {
        const rec = asRecord(f);
        if (rec !== undefined) add(rec.filePath, rec.deleted === true ? "delete" : "write");
      }
    }
  }
  add(response.filePath, "write");
  return [...out.values()];
}

/** Reported changes first, then the targets inferred from the tool input (content kept). */
function changedTargets(
  payload: NormalizedPayload,
  response: Record<string, unknown> | undefined,
  noShellScan: boolean,
): { cls: ToolClass; targets: GateTarget[] } {
  const extracted = extractTargets(payload);
  const inferred = extracted.cls === "shell" && noShellScan ? [] : extracted.targets;
  const byPath = new Map<string, GateTarget>();
  for (const t of reportedChanges(response)) byPath.set(t.rawPath, t);
  for (const t of inferred) {
    const prev = byPath.get(t.rawPath);
    // The input carries the new content (secret scan); the report carries the real op.
    byPath.set(t.rawPath, prev === undefined ? t : { ...prev, content: t.content });
  }
  return { cls: extracted.cls, targets: [...byPath.values()] };
}

/** Harnesses whose PostToolUse output can carry feedback to the model. */
export function renderPostBlock(
  format: GateFormat,
  d: GateDeny,
  reason: string,
): string | undefined {
  const ctx = { hookEventName: "PostToolUse", additionalContext: reason };
  const axiom = {
    verdict: "deny",
    phase: "post",
    code: d.code,
    ...(d.relPath === undefined ? {} : { path: d.relPath }),
    standard: "owasp-acs/0.1",
  };
  switch (format) {
    case "claude":
    case "codex":
      return JSON.stringify({ decision: "block", reason, hookSpecificOutput: ctx });
    case "gemini":
      return JSON.stringify({ decision: "deny", reason, hookSpecificOutput: ctx });
    case "cursor":
      return JSON.stringify({ additional_context: reason });
    case "windsurf":
    case "junie":
    case "cline":
      // No PostToolUse feedback channel: the stderr line and the decision journal carry it.
      return undefined;
    default:
      // VS Code reads decision/reason + hookSpecificOutput; Copilot CLI reads additionalContext.
      return JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: ctx,
        additionalContext: reason,
        axiom,
      });
  }
}

async function realOrResolved(p: string): Promise<string> {
  try {
    let r = await realpathNative(path.resolve(p));
    if (IS_WIN32 && r.startsWith("\\\\?\\")) r = r.slice(4);
    return r;
  } catch {
    return path.resolve(p);
  }
}

interface PostFlags {
  format: GateFormat;
  root?: string;
  profilePath?: string;
  noShellScan: boolean;
  noRootDiscovery: boolean;
  debug: boolean;
}

function parseFlags(argv: readonly string[]): PostFlags | string {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        stdin: { type: "boolean" },
        post: { type: "boolean" },
        root: { type: "string" },
        profile: { type: "string" },
        strict: { type: "boolean" },
        "fail-open": { type: "boolean" },
        "no-shell-scan": { type: "boolean" },
        "no-root-discovery": { type: "boolean" },
        "deny-exit": { type: "string" },
        format: { type: "string" },
        "log-level": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const f = values.format;
    if (f !== undefined && !isGateFormat(f)) return `--format ${f} is not a known format`;
    return {
      format: f ?? "auto",
      ...(values.root === undefined ? {} : { root: values.root }),
      ...(values.profile === undefined ? {} : { profilePath: values.profile }),
      noShellScan: values["no-shell-scan"] === true,
      noRootDiscovery: values["no-root-discovery"] === true,
      debug: values["log-level"] === "debug",
    };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Resolve each target against the root (or a sibling worktree); uncontained/invalid are skipped. */
async function resolveAll(
  rootReal: string,
  cwdReal: string,
  targets: readonly GateTarget[],
  debug: (m: string) => void,
): Promise<Map<string, ResolvedGateTarget[]>> {
  const groups = new Map<string, ResolvedGateTarget[]>();
  const add = (root: string, r: ResolvedGateTarget) => {
    const g = groups.get(root);
    if (g === undefined) groups.set(root, [r]);
    else g.push(r);
  };
  for (const t of targets) {
    try {
      add(rootReal, await resolveGateTarget(rootReal, t, cwdReal));
    } catch (err) {
      if (err instanceof GateDeny && err.code === "ERR_CONTAINMENT") {
        const wt = await sameRepoWorktreeRoot(rootReal, t.rawPath, cwdReal).catch(() => undefined);
        if (wt !== undefined) {
          try {
            add(wt, await resolveGateTarget(wt, t, cwdReal));
            continue;
          } catch {
            // fall through: skipped
          }
        }
      }
      // A changed file outside the root (a temp file, another repo) is not this gate's business.
      debug(
        `post: ${JSON.stringify(t.rawPath)} skipped (${err instanceof GateDeny ? err.code : "error"})`,
      );
    }
  }
  return groups;
}

/**
 * `axiom gate --stdin --post …` → result. The integrator routes `--post` here from `gateMain`.
 * Exit is always 0: a PostToolUse hook cannot stop a tool that already ran.
 */
export async function postMain(argv: readonly string[], io: PostIo): Promise<GateResult> {
  const t0 = performance.now();
  const stderr: string[] = [];
  let toolClass: ToolClass | undefined;
  let rootUsed: string | undefined;
  const flagsOrError = parseFlags(argv);
  const format: GateFormat = typeof flagsOrError === "string" ? "auto" : flagsOrError.format;
  const debugOn = typeof flagsOrError !== "string" && flagsOrError.debug;
  const debug = (m: string) => {
    if (debugOn) stderr.push(`AXIOM GATE DEBUG: ${m}`);
  };
  const allow = (): GateResult => ({
    decision: "allow",
    verdict: "allow",
    exitCode: 0,
    stderr,
    durationMs: performance.now() - t0,
    ...(toolClass === undefined ? {} : { toolClass }),
    ...(rootUsed === undefined ? {} : { root: rootUsed }),
  });
  const warnAllow = (why: string): GateResult => {
    stderr.push(`AXIOM GATE WARN: post-write check skipped: ${why}`);
    return allow();
  };
  if (typeof flagsOrError === "string") return warnAllow(flagsOrError);
  const flags = flagsOrError;

  try {
    if (io.read.tooLarge) return warnAllow("stdin exceeded the size limit");
    if (io.read.timedOut || io.read.text === undefined || io.read.text.trim() === "") {
      return warnAllow("no payload on stdin (timeout or empty)");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(io.read.text);
    } catch {
      return warnAllow("payload is not JSON");
    }
    const obj = asRecord(raw);
    const payload = normalizePayload(raw);
    if (obj === undefined || payload === undefined) {
      debug("post: payload carries no tool name");
      return allow();
    }
    const { cls, targets } = changedTargets(payload, toolResponse(obj), flags.noShellScan);
    toolClass = cls;
    if (cls === "other" && targets.length === 0) return allow();

    const rootArg = payload.cwd ?? flags.root ?? (io.cwdFallback ?? (() => process.cwd()))();
    const cwdReal = await realOrResolved(rootArg);
    const rootReal = flags.noRootDiscovery ? cwdReal : await discoverRoot(cwdReal, io.home);
    rootUsed = rootReal;
    const main = await loadGateProfile({
      root: rootReal,
      ...(flags.profilePath === undefined ? {} : { profilePath: flags.profilePath }),
      ...(io.home === undefined ? {} : { home: io.home }),
    });

    const groups = await resolveAll(rootReal, cwdReal, targets, debug);
    const judged: string[] = [];
    let verdict: GateDeny | undefined;
    for (const [root, resolved] of groups) {
      for (const r of resolved) judged.push(r.relPath);
      if (verdict !== undefined) continue;
      const profile: GateProfile =
        root === rootReal
          ? main.profile
          : (
              await loadGateProfile({
                root,
                ...(flags.profilePath === undefined ? {} : { profilePath: flags.profilePath }),
                ...(io.home === undefined ? {} : { home: io.home }),
              })
            ).profile;
      verdict = await runGatePredicates(resolved, profile);
    }

    let result: GateResult;
    if (verdict === undefined) {
      result = allow();
    } else {
      const where = verdict.relPath === undefined ? "" : ` (${verdict.relPath})`;
      const reason =
        `AXIOM POST-WRITE ${verdict.code}: ${payload.toolName} changed a protected path${where} — ${verdict.message}. ` +
        "A post-tool check cannot undo the change: restore the previous content (or remove the file) now, " +
        "and make a legitimate change of this path through the axiom_write MCP tool.";
      stderr.push(reason);
      const stdout = renderPostBlock(format, verdict, reason);
      result = {
        decision: "deny",
        verdict: "deny",
        exitCode: 0,
        code: verdict.code,
        reason: verdict.message,
        ...(verdict.relPath === undefined ? {} : { path: verdict.relPath }),
        ...(stdout === undefined ? {} : { stdout }),
        stderr,
        durationMs: performance.now() - t0,
        toolClass: cls,
        root: rootReal,
      };
    }

    if (main.profile.record) {
      try {
        const harness = payload.harness ?? (format === "auto" ? "unknown" : format);
        await appendDecision(rootReal, {
          v: 1,
          decided_at: new Date().toISOString(),
          agent_id: `${harness}:${payload.sessionId ?? "unknown"}`,
          principal: { subject: principalSubject() },
          tool: payload.toolName,
          ...hashArgs(payload.input),
          decision: result.decision,
          ...(result.code === undefined ? {} : { code: result.code }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          paths: [...new Set(judged)],
          profile: main.source,
          ms: Math.round(performance.now() - t0),
          phase: "post",
        });
      } catch (err) {
        debug(`decision journal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  } catch (err) {
    return warnAllow(err instanceof Error ? err.message : String(err));
  }
}
