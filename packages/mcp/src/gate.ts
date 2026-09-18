/**
 * `axiom gate --stdin` — PreToolUse hook mode (v2-architecture §5.6, S-203).
 *
 * Reads ONE harness payload from stdin, extracts the write target(s) of the tool call and
 * runs only the fast path/content predicates from `@codai/axiom-checks` against a small
 * gate profile. No repo index, no guards, no git — budget < 120 ms in-process.
 *
 * Contract (verified against Claude Code + Copilot CLI docs, see docs/hooks.md):
 *   allow → exit 0, nothing on stdout.
 *   deny  → exit 2, one stderr line `AXIOM GATE DENY <code>: <reason> (<relpath>)` and the
 *           Claude `hookSpecificOutput` JSON on stdout.
 *   internal error / malformed payload / stdin timeout → fail OPEN (exit 0 + stderr warn);
 *           `--strict` turns internal errors into a deny.
 *
 * This module never writes to stdout/stderr itself: it returns a `GateResult` and the CLI
 * entries (`cli.ts`, `cli-main.ts`) do the writing (`check-no-stdout`).
 */
import { realpath as realpathCb } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs, promisify } from "node:util";
import { resolveContained } from "@codai/axiom-apply";
import {
  contentMaxBytes,
  contentNoSecrets,
  type FactContext,
  pathAllow,
  pathDeny,
} from "@codai/axiom-checks";
import { type ErrorCode, isAxiomError, relPathIssues } from "@codai/axiom-schema";
import { z } from "zod";

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
const IS_WIN32 = process.platform === "win32";

export const GATE_STDIN_MAX_BYTES = 4 * 1024 * 1024;
export const GATE_STDIN_TIMEOUT_MS = 2_000;
export const GATE_EXIT_ALLOW = 0;
export const GATE_EXIT_DENY = 2;

// ---------------------------------------------------------------- profile --

export const GateProfileSchema = z
  .object({
    /** picomatch globs (dot: true) — any match denies. */
    deny: z.array(z.string().min(1)).default([]),
    /** When present, every target must match at least one glob. */
    allow: z.array(z.string().min(1)).optional(),
    /** Run `content.noSecrets` on the new content when the payload carries it. */
    noSecrets: z.boolean().default(true),
    /** Run `content.maxBytes` on the new content when the payload carries it. */
    maxBytes: z.int().positive().optional(),
  })
  .strict();

export type GateProfile = z.infer<typeof GateProfileSchema>;
export type GateProfileInput = z.input<typeof GateProfileSchema>;

export const DEFAULT_GATE_PROFILE: GateProfile = {
  deny: [
    ".git/**",
    ".axiom/**",
    "**/*.lock",
    "pnpm-lock.yaml",
    ".env",
    ".env.*",
    "**/node_modules/**",
  ],
  noSecrets: true,
};

/** `--profile`, then `<root>/.axiom/gate-profile.json`, then `~/.axiom/gate-profile.json`, then default. */
export async function loadGateProfile(opts: {
  root: string;
  profilePath?: string;
  home?: string;
}): Promise<{ profile: GateProfile; source: string }> {
  const candidates: string[] = [];
  if (opts.profilePath !== undefined) candidates.push(path.resolve(opts.profilePath));
  candidates.push(path.join(opts.root, ".axiom", "gate-profile.json"));
  candidates.push(path.join(opts.home ?? homedir(), ".axiom", "gate-profile.json"));
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") {
        // An explicit --profile that does not exist is a configuration error, not a fallback.
        if (file === candidates[0] && opts.profilePath !== undefined)
          throw new Error(`gate profile not found: ${file}`);
        continue;
      }
      throw err;
    }
    const parsed = GateProfileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(
        `invalid gate profile ${file}: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return { profile: parsed.data, source: file };
  }
  return { profile: DEFAULT_GATE_PROFILE, source: "builtin" };
}

function errno(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- payload --

export interface NormalizedPayload {
  toolName: string;
  cwd: string | undefined;
  input: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Accept Claude Code (`{session_id, tool_name, tool_input, cwd}`), Copilot CLI camelCase
 * (`{sessionId, toolName, toolArgs, cwd}` — `toolArgs` arrives as a JSON *string*) and the
 * VS Code shape (`tool_input` object). Returns undefined when no tool name is present.
 */
export function normalizePayload(raw: unknown): NormalizedPayload | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;
  const toolName = firstString(obj, ["tool_name", "toolName", "tool", "name"]);
  if (toolName === undefined) return undefined;
  let input: Record<string, unknown> = {};
  for (const k of ["tool_input", "toolInput", "toolArgs", "tool_args", "args", "input"]) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      try {
        const parsed = asRecord(JSON.parse(v));
        if (parsed !== undefined) {
          input = parsed;
          break;
        }
      } catch {
        // a bare string argument (e.g. a shell command) carries no write target
      }
      continue;
    }
    const rec = asRecord(v);
    if (rec !== undefined) {
      input = rec;
      break;
    }
  }
  const cwd = firstString(obj, ["cwd", "workingDirectory", "working_directory"]);
  return { toolName, cwd, input };
}

// ---------------------------------------------------------------- targets --

export interface GateTarget {
  /** Path as the agent supplied it (absolute or relative to cwd). */
  rawPath: string;
  /** New content when the payload carries it (full file, replacement string or `+` lines). */
  content: string | undefined;
  op: "write" | "delete";
}

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
  "file",
  "uri",
] as const;
const CONTENT_KEYS = [
  "content",
  "new_string",
  "newString",
  "new_str",
  "newStr",
  "code",
  "newCode",
  "new_source",
  "newSource",
  "file_text",
  "fileText",
  "text",
] as const;

/** Tools that write files, matched case-insensitively by substring. */
const WRITE_TOOL_HINTS = [
  "write",
  "edit",
  "create_file",
  "create",
  "replace_string",
  "insert_edit",
  "apply_patch",
  "notebook",
] as const;
/** Substrings that mark a tool as read-only even when a write hint also matches (`create_directory`, …). */
const NON_WRITE_HINTS = ["read", "list", "search", "grep", "glob", "view", "directory", "dir"];

export function isWriteTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  if (!WRITE_TOOL_HINTS.some((h) => n.includes(h))) return false;
  if (n.includes("apply_patch") || n.includes("multi_replace")) return true;
  return !NON_WRITE_HINTS.some((h) => n.includes(h));
}

const PATCH_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+?)\s*$/;

/** `apply_patch` V4A format: `*** Update|Add|Delete File: <path>` headers, `+` lines are new content. */
export function parseApplyPatch(patch: string): GateTarget[] {
  const out: GateTarget[] = [];
  let cur: { rawPath: string; op: "write" | "delete"; lines: string[] } | undefined;
  const flush = () => {
    if (cur === undefined) return;
    out.push({
      rawPath: cur.rawPath,
      op: cur.op,
      content: cur.op === "delete" ? undefined : cur.lines.join("\n"),
    });
    cur = undefined;
  };
  for (const line of patch.split(/\r?\n/)) {
    const h = PATCH_HEADER.exec(line);
    if (h !== null) {
      flush();
      cur = {
        rawPath: h[2] ?? "",
        op: h[1] === "Delete" ? "delete" : "write",
        lines: [],
      };
      continue;
    }
    const mv = PATCH_MOVE.exec(line);
    if (mv !== null) {
      // The destination is a second write target of the same hunk.
      out.push({ rawPath: mv[1] ?? "", op: "write", content: undefined });
      continue;
    }
    if (cur !== undefined && line.startsWith("+")) cur.lines.push(line.slice(1));
  }
  flush();
  return out.filter((t) => t.rawPath.length > 0);
}

function joinContent(parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => typeof p === "string");
  return present.length === 0 ? undefined : present.join("\n");
}

/** Extract every write target (+ new content) from a normalised payload. Unknown tool → `[]`. */
export function extractTargets(p: NormalizedPayload): GateTarget[] {
  if (!isWriteTool(p.toolName)) return [];
  const n = p.toolName.toLowerCase();
  const input = p.input;

  if (n.includes("apply_patch")) {
    const patch = firstString(input, ["input", "patch", "diff"]);
    return patch === undefined ? [] : parseApplyPatch(patch);
  }

  if (n.includes("multi_replace") && Array.isArray(input.replacements)) {
    const byPath = new Map<string, (string | undefined)[]>();
    for (const r of input.replacements) {
      const rec = asRecord(r);
      if (rec === undefined) continue;
      const fp = firstString(rec, PATH_KEYS);
      if (fp === undefined) continue;
      const list = byPath.get(fp) ?? [];
      list.push(firstString(rec, CONTENT_KEYS));
      byPath.set(fp, list);
    }
    return [...byPath].map(([rawPath, parts]) => ({
      rawPath,
      op: "write",
      content: joinContent(parts),
    }));
  }

  const rawPath = firstString(input, PATH_KEYS);
  if (rawPath === undefined) return [];
  let content = firstString(input, CONTENT_KEYS);
  if (Array.isArray(input.edits)) {
    // Claude MultiEdit: `{ file_path, edits: [{ old_string, new_string }] }`.
    content = joinContent([
      content,
      ...input.edits.map((e) => {
        const rec = asRecord(e);
        return rec === undefined ? undefined : firstString(rec, CONTENT_KEYS);
      }),
    ]);
  }
  return [{ rawPath, op: "write", content }];
}

// ---------------------------------------------------------------- resolve --

export interface ResolvedGateTarget {
  relPath: string;
  target: GateTarget;
}

export class GateDeny extends Error {
  readonly code: string;
  readonly relPath: string | undefined;
  constructor(code: string, message: string, relPath?: string) {
    super(message);
    this.name = "GateDeny";
    this.code = code;
    this.relPath = relPath;
  }
}

const PATH_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "ERR_PATH_NOT_RELATIVE_POSIX",
  "ERR_PATH_SEGMENT",
  "ERR_PATH_NOT_NFC",
  "ERR_PATH_RESERVED_NAME",
  "ERR_PATH_INVALID_CHAR",
]);

/**
 * Containment + RelPath validation. Backslashes in the agent-supplied path are treated as
 * separators on every OS (a literal `\` in a POSIX file name is not worth a fail-open hole:
 * `..\\..\\x` must land on ERR_CONTAINMENT everywhere).
 */
export async function resolveGateTarget(
  rootReal: string,
  target: GateTarget,
): Promise<ResolvedGateTarget> {
  const supplied = target.rawPath.replace(/\\/g, "/");
  const abs = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(rootReal, supplied);
  const rel = path.relative(rootReal, abs);
  if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new GateDeny("ERR_CONTAINMENT", "target escapes root", supplied);
  }
  const relPosix = rel.split(path.sep).join("/");
  const issues = relPathIssues(relPosix);
  const first = issues[0];
  if (first !== undefined) {
    const code = PATH_CODES.has(first) ? first : "ERR_PATH_SEGMENT";
    throw new GateDeny(code, `invalid relative path: ${issues.join(",")}`, relPosix);
  }
  try {
    await resolveContained(rootReal, relPosix);
  } catch (err) {
    if (isAxiomError(err)) throw new GateDeny(err.code, err.message, relPosix);
    throw err;
  }
  return { relPath: relPosix, target };
}

// ------------------------------------------------------------- predicates --

/**
 * Hand-built `FactContext`: a real `ManifestBundle` would need digests, JCS and a validated
 * body — none of which the four gate predicates read. They touch `manifest.artifacts[].{path,op,bytes}`,
 * `facts.manifest.paths` and `facts.content(path)` only, so a synthetic bundle keeps the gate
 * inside its latency budget without forking the predicate code.
 */
export function buildGateContext(targets: readonly ResolvedGateTarget[]): FactContext {
  const enc = new TextEncoder();
  const contents = new Map<string, Uint8Array>();
  const artifacts = targets.map(({ relPath, target }) => {
    const bytes = target.content === undefined ? undefined : enc.encode(target.content);
    if (bytes !== undefined) contents.set(relPath, bytes);
    return {
      path: relPath,
      op: target.op === "delete" ? "delete" : "overwrite",
      mode: "0644",
      ...(bytes === undefined ? {} : { bytes: bytes.length }),
    };
  });
  const manifest = {
    apiVersion: "axiom.dev/v2",
    kind: "Manifest",
    name: "gate",
    profile: "gate",
    planDigest: "sha256:gate",
    artifacts,
    checks: [],
    toolchain: { axiom: "gate", emitters: {} },
  };
  const bundle = { manifest, manifestDigest: "sha256:gate", blobs: {} };
  const ctx = {
    manifest,
    bundle,
    facts: {
      manifest: {
        artifactCount: artifacts.length,
        totalBytes: [...contents.values()].reduce((n, b) => n + b.length, 0),
        paths: artifacts.map((a) => a.path),
        byExt: {},
        hasDeletes: artifacts.some((a) => a.op === "delete"),
        signed: false,
      },
      content: async (p: string) => contents.get(p),
      profile: { allowRepo: false, allowGuards: false },
    },
  };
  return ctx as unknown as FactContext;
}

export async function runGatePredicates(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny | undefined> {
  const ctx = buildGateContext(targets);
  const findings = [];
  if (profile.deny.length > 0) findings.push(...(await pathDeny.run(ctx, { globs: profile.deny })));
  if (profile.allow !== undefined && profile.allow.length > 0)
    findings.push(...(await pathAllow.run(ctx, { globs: profile.allow })));
  const hasContent = targets.some((t) => t.target.content !== undefined);
  if (hasContent && profile.noSecrets)
    findings.push(...(await contentNoSecrets.run(ctx, { disable: [], allowPaths: [] })));
  if (hasContent && profile.maxBytes !== undefined)
    findings.push(...(await contentMaxBytes.run(ctx, { max: profile.maxBytes })));
  const f = findings[0];
  if (f === undefined) return undefined;
  return new GateDeny(f.id, f.message, f.path);
}

// ------------------------------------------------------------------- run --

export const GATE_LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type GateLogLevel = (typeof GATE_LOG_LEVELS)[number];
const RANK: Record<GateLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface GateOptions {
  /** Fallback root when the payload has no `cwd`. */
  root?: string;
  /** Explicit profile file (overrides the search path). */
  profilePath?: string;
  /** Internal errors deny instead of failing open. */
  strict?: boolean;
  logLevel?: GateLogLevel;
  /** Test hook for `~/.axiom/gate-profile.json`. */
  home?: string;
  /**
   * Last-resort cwd. The hook is the ONE place where the harness's cwd is acceptable:
   * both Claude Code and Copilot CLI spawn the hook in the project directory and put the
   * same value in the payload's `cwd`, so there is no ambiguity about who owns it.
   */
  cwdFallback?: () => string;
}

export interface GateResult {
  decision: "allow" | "deny";
  exitCode: typeof GATE_EXIT_ALLOW | typeof GATE_EXIT_DENY;
  code?: string;
  reason?: string;
  path?: string;
  /** Claude `hookSpecificOutput` JSON, deny only. */
  stdout?: string;
  stderr: string[];
  durationMs: number;
}

function denyResult(d: GateDeny, stderr: string[], t0: number): GateResult {
  const where = d.relPath === undefined ? "" : ` (${d.relPath})`;
  const reason = `AXIOM GATE DENY ${d.code}: ${d.message}${where}`;
  stderr.push(reason);
  return {
    decision: "deny",
    exitCode: GATE_EXIT_DENY,
    code: d.code,
    reason: d.message,
    ...(d.relPath === undefined ? {} : { path: d.relPath }),
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    stderr,
    durationMs: performance.now() - t0,
  };
}

/**
 * Evaluate one payload (already read from stdin). Never throws.
 * `payloadText === undefined` means stdin timed out / was empty → fail open.
 */
export async function runGate(
  payloadText: string | undefined,
  opts: GateOptions = {},
): Promise<GateResult> {
  const t0 = performance.now();
  const level: GateLogLevel = opts.logLevel ?? "warn";
  const stderr: string[] = [];
  const log = (lvl: GateLogLevel, msg: string) => {
    if (RANK[lvl] <= RANK[level]) stderr.push(`AXIOM GATE ${lvl.toUpperCase()}: ${msg}`);
  };
  const allow = (why: string): GateResult => {
    log("debug", `allow: ${why}`);
    return {
      decision: "allow",
      exitCode: GATE_EXIT_ALLOW,
      stderr,
      durationMs: performance.now() - t0,
    };
  };
  const internal = (why: string): GateResult => {
    if (opts.strict === true) {
      return denyResult(new GateDeny("ERR_INTERNAL", `${why} (--strict)`), stderr, t0);
    }
    log("warn", `${why} — failing open`);
    return allow("internal error");
  };

  if (payloadText === undefined) return internal("no payload on stdin (timeout or empty)");
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch (err) {
    return internal(`payload is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const payload = normalizePayload(raw);
  if (payload === undefined) return allow("payload carries no tool name");
  const targets = extractTargets(payload);
  if (targets.length === 0) return allow(`tool ${payload.toolName} has no write target`);

  try {
    const rootArg = payload.cwd ?? opts.root ?? (opts.cwdFallback ?? (() => process.cwd()))();
    let rootReal = await realpathNative(path.resolve(rootArg));
    if (IS_WIN32 && rootReal.startsWith("\\\\?\\")) rootReal = rootReal.slice(4);
    const { profile, source } = await loadGateProfile({
      root: rootReal,
      ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
      ...(opts.home === undefined ? {} : { home: opts.home }),
    });
    log("debug", `root=${rootReal} profile=${source} targets=${targets.length}`);
    const resolved: ResolvedGateTarget[] = [];
    for (const t of targets) resolved.push(await resolveGateTarget(rootReal, t));
    const deny = await runGatePredicates(resolved, profile);
    if (deny !== undefined) return denyResult(deny, stderr, t0);
    return allow(`${resolved.length} target(s) passed`);
  } catch (err) {
    if (err instanceof GateDeny) return denyResult(err, stderr, t0);
    return internal(err instanceof Error ? err.message : String(err));
  }
}

// ----------------------------------------------------------------- stdin --

export interface StdinRead {
  text: string | undefined;
  timedOut: boolean;
  tooLarge: boolean;
}

/** Read all of `stream` (≤ maxBytes) or give up after `timeoutMs` — a hook must never hang. */
export function readStdin(
  stream: NodeJS.ReadableStream,
  { timeoutMs = GATE_STDIN_TIMEOUT_MS, maxBytes = GATE_STDIN_MAX_BYTES } = {},
): Promise<StdinRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: StdinRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ text: undefined, timedOut: true, tooLarge: false }),
      timeoutMs,
    );
    timer.unref?.();
    stream.on("data", (chunk: Buffer | string) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += b.length;
      if (size > maxBytes) {
        finish({ text: undefined, timedOut: false, tooLarge: true });
        return;
      }
      chunks.push(b);
    });
    stream.on("end", () =>
      finish({ text: Buffer.concat(chunks).toString("utf8"), timedOut: false, tooLarge: false }),
    );
    stream.on("error", () => finish({ text: undefined, timedOut: false, tooLarge: false }));
    stream.resume();
  });
}

// ------------------------------------------------------------------- cli --

export const GATE_USAGE =
  "usage: axiom gate --stdin [--root <dir>] [--profile <file>] [--strict] [--log-level error|warn|info|debug]";

/** `axiom gate <argv>` → result. Reads stdin only when `--stdin` is given. Never throws. */
export async function gateMain(
  argv: readonly string[],
  io: { stdin?: NodeJS.ReadableStream; cwdFallback?: () => string; home?: string } = {},
): Promise<GateResult> {
  const t0 = performance.now();
  let values: {
    stdin?: boolean;
    root?: string;
    profile?: string;
    strict?: boolean;
    "log-level"?: string;
  };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        stdin: { type: "boolean" },
        root: { type: "string" },
        profile: { type: "string" },
        strict: { type: "boolean" },
        "log-level": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return {
      decision: "deny",
      exitCode: GATE_EXIT_DENY,
      reason: err instanceof Error ? err.message : String(err),
      stderr: [`AXIOM GATE ERROR: ${err instanceof Error ? err.message : String(err)}`, GATE_USAGE],
      durationMs: performance.now() - t0,
    };
  }
  if (values.stdin !== true) {
    return {
      decision: "deny",
      exitCode: GATE_EXIT_DENY,
      reason: "--stdin is required",
      stderr: ["AXIOM GATE ERROR: --stdin is required", GATE_USAGE],
      durationMs: performance.now() - t0,
    };
  }
  const levelRaw = values["log-level"] ?? "warn";
  const logLevel: GateLogLevel = (GATE_LOG_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as GateLogLevel)
    : "warn";
  const read = await readStdin(io.stdin ?? process.stdin);
  const opts: GateOptions = { logLevel };
  if (values.root !== undefined) opts.root = values.root;
  if (values.profile !== undefined) opts.profilePath = values.profile;
  if (values.strict === true) opts.strict = true;
  if (io.cwdFallback !== undefined) opts.cwdFallback = io.cwdFallback;
  if (io.home !== undefined) opts.home = io.home;
  if (read.tooLarge) {
    const r = await runGate(undefined, opts);
    r.stderr.unshift(`AXIOM GATE WARN: stdin exceeded ${GATE_STDIN_MAX_BYTES} bytes`);
    return r;
  }
  return runGate(read.text, opts);
}
