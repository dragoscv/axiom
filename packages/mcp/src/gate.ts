/**
 * `axiom gate --stdin` — PreToolUse hook mode (v2-architecture §5.6, S-203).
 *
 * Reads ONE harness payload from stdin, extracts the write target(s) of the tool call and
 * runs only the fast path/content predicates from `@codai/axiom-checks` against a small
 * gate profile. No repo index, no guards, no git — budget < 120 ms in-process.
 *
 * Contract (verified against Claude Code + Copilot CLI docs, see docs/hooks.md) — Gate v2 (S-404, D-18):
 *   allow → exit 0, nothing on stdout.
 *   deny  → exit 2, one stderr line `AXIOM GATE DENY <code>: <reason> (<relpath>)` and ONE JSON
 *           object on stdout carrying both the Claude `hookSpecificOutput` shape and the flat
 *           Copilot `{permissionDecision, permissionDecisionReason}` shape, plus an OWASP Agent
 *           Control Standard `verdict` (`allow|deny|modify|ask|defer`; the gate only emits
 *           `allow`/`deny`).
 *   FAIL-CLOSED by default: an internal error, malformed payload, stdin timeout, or a
 *           write-class tool whose target cannot be determined → deny with a reason.
 *           `--fail-open` restores the 2.1 behaviour (exit 0 + stderr warn) for those cases.
 *   Shell tools (`Bash`, `run_in_terminal`, …) are scanned for write primitives
 *           (`>`, `>>`, `tee`, `rm`, `mv`, `cp`, `sed -i`, `git checkout|reset|clean`, …); a
 *           protected path among their operands → deny. Heuristic, documented as such.
 *   Root: payload `cwd` → walk up to the nearest ancestor holding `.axiom/` or `.git/`
 *           (so a sub-directory cwd still sees `.git/**` in the profile) → `--root` → cwd.
 *
 * This module never writes to stdout/stderr itself: it returns a `GateResult` and the CLI
 * entries (`cli.ts`, `cli-main.ts`) do the writing (`check-no-stdout`).
 */
import { realpath as realpathCb } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
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

/** Tools that execute a shell command; matched case-insensitively by substring. */
const SHELL_TOOL_HINTS = [
  "bash",
  "shell",
  "run_in_terminal",
  "terminal",
  "execute_command",
  "exec_command",
  "run_command",
  "powershell",
  "cmd",
] as const;
const SHELL_COMMAND_KEYS = ["command", "cmd", "script", "commandLine", "command_line"] as const;

export function isShellTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return SHELL_TOOL_HINTS.some((h) => n.includes(h));
}

export type ToolClass = "write" | "shell" | "other";

export function classifyTool(toolName: string): ToolClass {
  if (isWriteTool(toolName)) return "write";
  if (isShellTool(toolName)) return "shell";
  return "other";
}

// ------------------------------------------------------------ shell scan --

/**
 * Write primitives a shell command may contain. Each rule names the operand positions that
 * are *paths being written*. This is a documented heuristic (D-18), not a shell parser: it
 * catches the common agent idioms (`echo x > .env`, `rm -rf .git`, `sed -i … file`,
 * `git checkout -- file`) and is bypassable by construction; the full Plan→apply path is the
 * guarantee, the gate is the seatbelt.
 */
const REDIRECT_RE = /(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*("([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
const SHELL_SPLIT_RE = /(?:^|[;&|]+|\|\||&&)\s*/;
const WRITE_CMDS: Record<string, { skipFlags: boolean; operands: "all" | "last" | "afterI" }> = {
  tee: { skipFlags: true, operands: "all" },
  rm: { skipFlags: true, operands: "all" },
  rmdir: { skipFlags: true, operands: "all" },
  mv: { skipFlags: true, operands: "last" },
  cp: { skipFlags: true, operands: "last" },
  touch: { skipFlags: true, operands: "all" },
  truncate: { skipFlags: true, operands: "all" },
  mkdir: { skipFlags: true, operands: "all" },
  ln: { skipFlags: true, operands: "last" },
  chmod: { skipFlags: true, operands: "all" },
  unlink: { skipFlags: true, operands: "all" },
  install: { skipFlags: true, operands: "last" },
  dd: { skipFlags: false, operands: "all" },
  sed: { skipFlags: true, operands: "afterI" },
  "remove-item": { skipFlags: true, operands: "all" },
  "set-content": { skipFlags: true, operands: "all" },
  "add-content": { skipFlags: true, operands: "all" },
  "out-file": { skipFlags: true, operands: "all" },
  "move-item": { skipFlags: true, operands: "all" },
  "copy-item": { skipFlags: true, operands: "all" },
  "new-item": { skipFlags: true, operands: "all" },
  del: { skipFlags: true, operands: "all" },
  erase: { skipFlags: true, operands: "all" },
  move: { skipFlags: true, operands: "all" },
  copy: { skipFlags: true, operands: "all" },
};
const GIT_WRITE_SUBCMDS = new Set(["checkout", "reset", "clean", "restore", "rm", "mv", "stash"]);

function shellWords(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

function looksLikePath(word: string): boolean {
  if (word === "" || word === "-" || word === "--") return false;
  if (word.startsWith("-") && !word.startsWith("./") && !word.startsWith("../")) return false;
  if (/^\$\(|^`|^\$[A-Za-z_{]/.test(word)) return false; // substitutions: unknown target
  return true;
}

/**
 * Paths a shell command would write/delete, as written. Empty when the command has no
 * recognised write primitive. Substitutions (`$(…)`, `$VAR`) are opaque and not returned.
 */
export function extractShellWriteTargets(command: string): GateTarget[] {
  const out: GateTarget[] = [];
  const seen = new Set<string>();
  const push = (rawPath: string, op: "write" | "delete") => {
    if (!looksLikePath(rawPath) || seen.has(rawPath)) return;
    seen.add(rawPath);
    out.push({ rawPath, op, content: undefined });
  };
  for (let m = REDIRECT_RE.exec(command); m !== null; m = REDIRECT_RE.exec(command)) {
    const target = m[2] ?? m[3] ?? m[4] ?? "";
    if (target !== "" && !/^&\d$/.test(target) && !/^\/dev\//.test(target)) push(target, "write");
  }
  REDIRECT_RE.lastIndex = 0;
  for (const seg of command.split(SHELL_SPLIT_RE)) {
    const words = shellWords(seg);
    // skip env assignments and sudo/exec prefixes
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
    while (
      i < words.length &&
      ["sudo", "exec", "command", "nohup", "time"].includes(words[i] ?? "")
    )
      i++;
    const cmd = (words[i] ?? "").toLowerCase().replace(/^.*[\\/]/, "");
    const rest = words.slice(i + 1);
    if (cmd === "git") {
      const sub = rest.find((w) => !w.startsWith("-"));
      if (sub !== undefined && GIT_WRITE_SUBCMDS.has(sub)) {
        const afterSub = rest.slice(rest.indexOf(sub) + 1);
        const dd = afterSub.indexOf("--");
        const operands =
          dd === -1 ? afterSub.filter((w) => !w.startsWith("-")) : afterSub.slice(dd + 1);
        if (sub === "clean" || (sub === "reset" && afterSub.includes("--hard")))
          push(".", "delete");
        for (const p of operands) push(p, sub === "rm" || sub === "clean" ? "delete" : "write");
      }
      continue;
    }
    const rule = WRITE_CMDS[cmd];
    if (rule === undefined) continue;
    if (cmd === "sed") {
      if (
        !rest.some(
          (w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place" || w.startsWith("--in-place="),
        )
      )
        continue;
      const hasScriptFlag = rest.some(
        (w) => /^-[a-zA-Z]*[ef]/.test(w) || /^--(expression|file)/.test(w),
      );
      const nonFlags: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          // `-e SCRIPT` / `-f FILE` take a value
          if (/^-[a-zA-Z]*[ef]$/.test(w) || w === "--expression" || w === "--file") k++;
          continue;
        }
        nonFlags.push(w);
      }
      // Without -e/-f the first operand is the script; everything after it is a file.
      const files = hasScriptFlag ? nonFlags : nonFlags.slice(1);
      for (const w of files) push(w, "write");
      continue;
    }
    if (cmd === "dd") {
      for (const w of rest) if (w.startsWith("of=")) push(w.slice(3), "write");
      continue;
    }
    let operands: string[];
    if (cmd.includes("-")) {
      // PowerShell cmdlet: named parameters. Path-bearing ones name the target; every other
      // `-Name value` pair is skipped so `-Value "x"` is not mistaken for a file.
      operands = [];
      const PATH_PARAMS = ["path", "literalpath", "filepath", "destination", "newname", "target"];
      const VALUE_PARAMS = new Set([
        ...PATH_PARAMS,
        "value",
        "encoding",
        "filter",
        "include",
        "exclude",
        "itemtype",
        "name",
      ]);
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? "";
        if (w.startsWith("-")) {
          const name = w.slice(1).toLowerCase();
          const val = rest[k + 1];
          if (PATH_PARAMS.includes(name) && val !== undefined) operands.push(val);
          // Only parameters known to take a value consume the next token; `-Recurse`,
          // `-Force`, `-WhatIf` are switches and the token after them is positional.
          if (VALUE_PARAMS.has(name) && val !== undefined && !val.startsWith("-")) k++;
          continue;
        }
        operands.push(w);
      }
    } else {
      operands = rule.skipFlags ? rest.filter((w) => !w.startsWith("-") || w === "-") : rest;
    }
    const op: "write" | "delete" =
      cmd === "rm" ||
      cmd === "rmdir" ||
      cmd === "unlink" ||
      cmd === "del" ||
      cmd === "erase" ||
      cmd === "remove-item"
        ? "delete"
        : "write";
    if (rule.operands === "last") {
      const last = operands[operands.length - 1];
      if (last !== undefined) push(last, op);
    } else {
      for (const w of operands) push(w, op);
    }
  }
  return out;
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

export interface Extracted {
  cls: ToolClass;
  targets: GateTarget[];
  /**
   * Write-class tool whose target could not be determined (unknown path key, V4A body
   * missing, …). Gate v2 denies this by default: an unrecognised write is exactly what the
   * gate exists to stop (D-18).
   */
  undetermined: boolean;
}

/** Extract every write target (+ new content) from a normalised payload. */
export function extractTargets(p: NormalizedPayload): Extracted {
  const cls = classifyTool(p.toolName);
  if (cls === "other") return { cls, targets: [], undetermined: false };
  if (cls === "shell") {
    const command = firstString(p.input, SHELL_COMMAND_KEYS);
    // A shell tool without a recognisable command string carries nothing we can judge; it is
    // not a write tool, so it is allowed (the scan is a heuristic seatbelt, not the gate).
    if (command === undefined) return { cls, targets: [], undetermined: false };
    return { cls, targets: extractShellWriteTargets(command), undetermined: false };
  }
  const targets = extractWriteTargets(p);
  return { cls, targets, undetermined: targets.length === 0 };
}

function extractWriteTargets(p: NormalizedPayload): GateTarget[] {
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
  /** Directory relative paths are resolved against (the harness cwd); defaults to the root. */
  cwdReal: string = rootReal,
): Promise<ResolvedGateTarget> {
  const supplied = target.rawPath.replace(/\\/g, "/");
  let abs = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(cwdReal, supplied);
  if (path.isAbsolute(supplied)) {
    // The harness hands us paths under its own cwd, which may be non-canonical
    // (macOS /var → /private/var, Windows RUNNER~1). Canonicalize the deepest
    // existing ancestor so the comparison against rootReal is apples to apples.
    abs = await canonicalizeExisting(abs);
  }
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

async function canonicalizeExisting(abs: string): Promise<string> {
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpathNative(cur);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
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
  /** @deprecated Gate v2 is fail-closed by default; kept as a no-op alias for old hook configs. */
  strict?: boolean;
  /**
   * Restore the 2.1 behaviour: internal errors, malformed payloads and undetermined write
   * targets are allowed with a stderr warning instead of denied (D-18 opt-out).
   */
  failOpen?: boolean;
  /** Do not scan shell commands for write primitives (D-18 opt-out). */
  noShellScan?: boolean;
  /** Do not walk up from `cwd` to the nearest `.axiom/`/`.git/` ancestor. */
  noRootDiscovery?: boolean;
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
  /** OWASP Agent Control Standard v0.1 Guardian vocabulary; the gate emits `allow` or `deny`. */
  verdict: "allow" | "deny" | "modify" | "ask" | "defer";
  exitCode: typeof GATE_EXIT_ALLOW | typeof GATE_EXIT_DENY;
  code?: string;
  reason?: string;
  path?: string;
  /** One JSON object (Claude `hookSpecificOutput` + Copilot flat shape + `axiom` block), deny only. */
  stdout?: string;
  stderr: string[];
  durationMs: number;
  /** Which class of tool was judged. */
  toolClass?: ToolClass;
  /** Root actually used, when one was resolved. */
  root?: string;
}

/**
 * The single stdout document for a deny. Claude reads `hookSpecificOutput.permissionDecision`;
 * Copilot CLI/VS Code read the flat `permissionDecision`/`permissionDecisionReason` and merge
 * them into their own deny; `axiom` carries the machine-readable verdict (OWASP ACS
 * vocabulary) plus code/path for log consumers. Unknown keys are ignored by both harnesses.
 */
export function denyDocument(d: GateDeny, reason: string, extra: { toolClass?: ToolClass }) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    axiom: {
      verdict: "deny",
      code: d.code,
      ...(d.relPath === undefined ? {} : { path: d.relPath }),
      ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
      standard: "owasp-acs/0.1",
    },
  };
}

function denyResult(
  d: GateDeny,
  stderr: string[],
  t0: number,
  extra: { toolClass?: ToolClass; root?: string } = {},
): GateResult {
  const where = d.relPath === undefined ? "" : ` (${d.relPath})`;
  const reason = `AXIOM GATE DENY ${d.code}: ${d.message}${where}`;
  stderr.push(reason);
  return {
    decision: "deny",
    verdict: "deny",
    exitCode: GATE_EXIT_DENY,
    code: d.code,
    reason: d.message,
    ...(d.relPath === undefined ? {} : { path: d.relPath }),
    stdout: JSON.stringify(denyDocument(d, reason, extra)),
    stderr,
    durationMs: performance.now() - t0,
    ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
    ...(extra.root === undefined ? {} : { root: extra.root }),
  };
}

const AXIOM_REPO_MARKERS = ["journal", "cas", "applied", "profiles", "trust", "lock", "backup"];

/**
 * Walk up from `start` to the nearest directory that is a repository root: it holds `.git`
 * (directory, or the file a worktree/submodule uses) or a *repo* `.axiom/` (one with
 * journal/cas/applied/profiles/trust — not `~/.axiom/`, which only holds a gate profile).
 * Never climbs to or above the home directory, and never above `stopAt` when given. A
 * harness that runs the agent in `apps/web` still has `.git/**` and `.env` at the repo root,
 * and the profile lives there too. Returns `start` when nothing is found.
 */
export async function discoverRoot(start: string, home: string = homedir()): Promise<string> {
  const homeReal = path.resolve(home);
  const isHomeOrAbove = (p: string): boolean => {
    const a = IS_WIN32 ? p.toLowerCase() : p;
    const h = IS_WIN32 ? homeReal.toLowerCase() : homeReal;
    return a === h || h.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
  };
  let cur = start;
  for (let depth = 0; depth < 64; depth++) {
    if (isHomeOrAbove(cur)) break;
    try {
      const st = await lstat(path.join(cur, ".git"));
      if (st.isDirectory() || st.isFile()) return cur;
    } catch {
      /* keep walking */
    }
    try {
      const ax = path.join(cur, ".axiom");
      if ((await lstat(ax)).isDirectory()) {
        for (const m of AXIOM_REPO_MARKERS) {
          try {
            await lstat(path.join(ax, m));
            return cur;
          } catch {
            /* next marker */
          }
        }
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/**
 * Evaluate one payload (already read from stdin). Never throws.
 * `payloadText === undefined` means stdin timed out / was empty → deny (fail closed) unless
 * `failOpen`.
 */
export async function runGate(
  payloadText: string | undefined,
  opts: GateOptions = {},
): Promise<GateResult> {
  const t0 = performance.now();
  const level: GateLogLevel = opts.logLevel ?? "warn";
  const stderr: string[] = [];
  let toolClass: ToolClass | undefined;
  let rootUsed: string | undefined;
  const log = (lvl: GateLogLevel, msg: string) => {
    if (RANK[lvl] <= RANK[level]) stderr.push(`AXIOM GATE ${lvl.toUpperCase()}: ${msg}`);
  };
  const allow = (why: string): GateResult => {
    log("debug", `allow: ${why}`);
    return {
      decision: "allow",
      verdict: "allow",
      exitCode: GATE_EXIT_ALLOW,
      stderr,
      durationMs: performance.now() - t0,
      ...(toolClass === undefined ? {} : { toolClass }),
      ...(rootUsed === undefined ? {} : { root: rootUsed }),
    };
  };
  const deny = (d: GateDeny): GateResult =>
    denyResult(d, stderr, t0, {
      ...(toolClass === undefined ? {} : { toolClass }),
      ...(rootUsed === undefined ? {} : { root: rootUsed }),
    });
  /** Fail-closed (D-18): a non-answer is a deny unless the operator opted out. */
  const internal = (why: string): GateResult => {
    if (opts.failOpen === true) {
      log("warn", `${why} — failing open (--fail-open)`);
      return allow("internal error");
    }
    return deny(new GateDeny("ERR_INTERNAL", `${why} (fail-closed; pass --fail-open to allow)`));
  };

  if (payloadText === undefined) return internal("no payload on stdin (timeout or empty)");
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch (err) {
    return internal(`payload is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const payload = normalizePayload(raw);
  // No tool name at all: not a PreToolUse payload we understand. Nothing to judge → allow
  // (a hook wired to the wrong event must not brick the editor); logged at info.
  if (payload === undefined) {
    log("info", "payload carries no tool name");
    return allow("payload carries no tool name");
  }
  const extracted = extractTargets(payload);
  toolClass = extracted.cls;
  if (extracted.cls === "other") return allow(`tool ${payload.toolName} is not a write/shell tool`);
  if (extracted.cls === "shell" && opts.noShellScan === true) {
    return allow(`tool ${payload.toolName} is a shell tool and --no-shell-scan is set`);
  }
  if (extracted.undetermined) {
    // Write-class tool, target unknown (D-18: unknown → deny with reason).
    if (opts.failOpen === true) {
      log(
        "warn",
        `write tool ${payload.toolName} has no recognised path key — allowing (--fail-open)`,
      );
      return allow("undetermined write target");
    }
    return deny(
      new GateDeny(
        "ERR_UNSUPPORTED_OP",
        `write tool "${payload.toolName}" carries no recognised path key (${PATH_KEYS.join(", ")}); add it to the gate or pass --fail-open`,
      ),
    );
  }
  const targets = extracted.targets;
  if (targets.length === 0) return allow(`tool ${payload.toolName} writes nothing recognisable`);

  try {
    const rootArg = payload.cwd ?? opts.root ?? (opts.cwdFallback ?? (() => process.cwd()))();
    let rootReal = await realpathNative(path.resolve(rootArg));
    if (IS_WIN32 && rootReal.startsWith("\\\\?\\")) rootReal = rootReal.slice(4);
    // Relative targets are relative to where the agent runs (the payload cwd), even after the
    // root is discovered above it.
    const cwdReal = rootReal;
    if (opts.noRootDiscovery !== true) {
      const discovered = await discoverRoot(rootReal, opts.home);
      if (discovered !== rootReal) {
        log("debug", `root discovered ${rootReal} → ${discovered}`);
        rootReal = discovered;
      }
    }
    rootUsed = rootReal;
    const { profile, source } = await loadGateProfile({
      root: rootReal,
      ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
      ...(opts.home === undefined ? {} : { home: opts.home }),
    });
    log(
      "debug",
      `root=${rootReal} profile=${source} class=${extracted.cls} targets=${targets.length}`,
    );
    const resolved: ResolvedGateTarget[] = [];
    for (const t of targets) {
      try {
        resolved.push(await resolveGateTarget(rootReal, t, cwdReal));
      } catch (err) {
        // Shell operands are heuristic: a token that is not a path (a URL, a glob, `.`)
        // must not deny the whole command. Real write tools keep the strict behaviour.
        if (
          extracted.cls === "shell" &&
          err instanceof GateDeny &&
          err.code !== "ERR_CONTAINMENT"
        ) {
          log("debug", `shell operand ${JSON.stringify(t.rawPath)} skipped: ${err.code}`);
          continue;
        }
        if (extracted.cls === "shell" && err instanceof GateDeny && t.rawPath === ".") {
          // `git clean` / `reset --hard` on the root itself: deny only if the profile protects
          // anything — approximate by denying when the profile has a deny list.
          if (profile.deny.length > 0) {
            throw new GateDeny("path.deny", "destructive git command on the whole tree", ".");
          }
          continue;
        }
        throw err;
      }
    }
    const verdict = await runGatePredicates(resolved, profile);
    if (verdict !== undefined) return deny(verdict);
    return allow(`${resolved.length} target(s) passed (${extracted.cls})`);
  } catch (err) {
    if (err instanceof GateDeny) return deny(err);
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
  "usage: axiom gate --stdin [--root <dir>] [--profile <file>] [--fail-open] [--no-shell-scan] [--no-root-discovery] [--log-level error|warn|info|debug]";

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
    "fail-open"?: boolean;
    "no-shell-scan"?: boolean;
    "no-root-discovery"?: boolean;
    "log-level"?: string;
  };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        stdin: { type: "boolean" },
        root: { type: "string" },
        profile: { type: "string" },
        // 2.1 flag; fail-closed is now the default so this is accepted and ignored.
        strict: { type: "boolean" },
        "fail-open": { type: "boolean" },
        "no-shell-scan": { type: "boolean" },
        "no-root-discovery": { type: "boolean" },
        "log-level": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return {
      decision: "deny",
      verdict: "deny",
      exitCode: GATE_EXIT_DENY,
      reason: err instanceof Error ? err.message : String(err),
      stderr: [`AXIOM GATE ERROR: ${err instanceof Error ? err.message : String(err)}`, GATE_USAGE],
      durationMs: performance.now() - t0,
    };
  }
  if (values.stdin !== true) {
    return {
      decision: "deny",
      verdict: "deny",
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
  if (values["fail-open"] === true) opts.failOpen = true;
  if (values["no-shell-scan"] === true) opts.noShellScan = true;
  if (values["no-root-discovery"] === true) opts.noRootDiscovery = true;
  if (io.cwdFallback !== undefined) opts.cwdFallback = io.cwdFallback;
  if (io.home !== undefined) opts.home = io.home;
  if (read.tooLarge) {
    const r = await runGate(undefined, opts);
    r.stderr.unshift(`AXIOM GATE WARN: stdin exceeded ${GATE_STDIN_MAX_BYTES} bytes`);
    return r;
  }
  return runGate(read.text, opts);
}
