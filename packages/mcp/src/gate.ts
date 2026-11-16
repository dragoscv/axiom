/**
 * `axiom gate --stdin` — PreToolUse hook mode (v2-architecture §5.6, S-203).
 *
 * Reads ONE harness payload from stdin, extracts the write target(s) of the tool call and
 * runs only the fast path/content predicates from `@codai/axiom-checks` against a small
 * gate profile. No repo index, no guards, no git — budget < 120 ms in-process.
 *
 * Contract (verified against Claude Code + Copilot CLI docs, see docs/getting-started/hooks.md) — Gate v2 (S-404, D-18):
 *   allow → exit 0, nothing on stdout.
 *   deny  → exit 0 (D-35; `--deny-exit 2` for harnesses that only read the exit code), one
 *           stderr line `AXIOM GATE DENY <code>: <reason> (<relpath>)` and ONE JSON
 *           object on stdout carrying both the Claude `hookSpecificOutput` shape and the flat
 *           Copilot `{permissionDecision, permissionDecisionReason}` shape, plus an OWASP Agent
 *           Control Standard `verdict` (`allow|deny|modify|ask|defer`; the gate only emits
 *           `allow`/`deny`).
 *           Why exit 0: the npm `axiom.ps1` shim rewrites every non-zero exit to 1, and VS Code
 *           treats exit 1 as a non-blocking warning — 129 of 134 production denies (codai,
 *           2026-10-07..14) let the tool run. Every harness that has a JSON contract honours
 *           the JSON deny on exit 0.
 *   FAIL-CLOSED by default: an internal error, malformed payload, stdin timeout, or a
 *           write-class tool whose target cannot be determined → deny with a reason.
 *           `--fail-open` restores the 2.1 behaviour (exit 0 + stderr warn) for those cases.
 *   Shell tools (`Bash`, `run_in_terminal`, …) are scanned for write primitives
 *           (`>`, `>>`, `tee`, `rm`, `mv`, `cp`, `sed -i`, `git checkout|reset|clean`, …); a
 *           protected path among their operands → deny (an `ask`-glob operand → ask; deny
 *           wins). Heuristic, documented as such.
 *   Root: payload `cwd` → walk up to the nearest ancestor holding `.axiom/` or `.git/`
 *           (so a sub-directory cwd still sees `.git/**` in the profile) → `--root` → cwd.
 *           A target outside the root but inside another worktree of the SAME repository
 *           (same git common dir) is judged against that worktree's root and profile (D-35).
 *
 * This module never writes to stdout/stderr itself: it returns a `GateResult` and the CLI
 * entries (`cli.ts`, `cli-main.ts`) do the writing (`check-no-stdout`).
 */
import { realpath as realpathCb } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs, promisify } from "node:util";
import { resolveContained } from "@codai/axiom-apply";
import { sha256Hex } from "@codai/axiom-canon";
import {
  contentMaxBytes,
  contentNoSecrets,
  type FactContext,
  globMatcher,
  pathAllow,
  pathDeny,
} from "@codai/axiom-checks";
import { type ErrorCode, isAxiomError, relPathIssues } from "@codai/axiom-schema";
import { evaluateCommandRules } from "./command-rules.js";
import { evaluateCoordination } from "./coord.js";
import { appendDecision, hashArgs, principalSubject } from "./decisions.js";
import {
  allowStdout,
  classifyTool,
  formatFromArgv,
  GATE_FORMATS,
  GATE_STDIN_MAX_BYTES,
  GATE_STDIN_TIMEOUT_MS,
  type GateFormat,
  isGateFormat,
  isShellTool,
  isWriteTool,
  readStdin,
  type StdinRead,
  type ToolClass,
} from "./gate-fast.js";
import {
  ASK_FORMATS,
  allowDocument,
  GATE_EXIT_ALLOW,
  GATE_EXIT_DENY,
  GATE_FORMAT_TABLE,
  GateDeny,
  HINT_FORMATS,
  renderDeny,
  verdictDeny,
} from "./gate-format.js";
import {
  commandString,
  extractTargets,
  firstString,
  type NormalizedPayload,
  normalizePayload,
  PATH_KEYS,
} from "./gate-payload.js";
import { type GateProfile, GateProfileError } from "./gate-profile.js";
import {
  canonicalizeExisting,
  discoverRoot,
  realOrResolved,
  sameRepoWorktreeRoot,
} from "./gate-roots.js";
import type { RuleVerdict } from "./gate-verdict.js";
import { evaluateGit, type GitRules } from "./gitfacts.js";
import { resolvePolicy } from "./policy.js";
import { postMain } from "./post-write.js";
import {
  isSelfHardCode,
  SELF_ASK_CODE,
  SELF_ASK_GLOBS,
  SELF_PROTECT_CODE,
  SELF_PROTECT_GLOBS,
  SELF_TREE_DELETE_CODE,
  selfProtectHomeTier,
} from "./self-protect.js";
import {
  checkSessionWrite,
  checkStaleScript,
  recordDeniedCreate,
  recordSessionRead,
  recordSessionWrite,
  type SessionTarget,
} from "./session-guard.js";
import { findTrailingOverride } from "./shell-lex.js";
import { extractShellWriteTargets, type GateTarget } from "./shell-targets.js";
import { captureOutsideUndo, captureUndo } from "./undo.js";

export * from "./gate-format.js";
export * from "./gate-payload.js";
export * from "./gate-profile.js";
export * from "./gate-roots.js";
export {
  allowStdout,
  classifyTool,
  extractShellWriteTargets,
  formatFromArgv,
  GATE_FORMATS,
  GATE_STDIN_MAX_BYTES,
  GATE_STDIN_TIMEOUT_MS,
  type GateFormat,
  type GateTarget,
  isShellTool,
  isWriteTool,
  readStdin,
  type StdinRead,
  type ToolClass,
};

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
const IS_WIN32 = process.platform === "win32";

// ---------------------------------------------------------------- resolve --

export interface ResolvedGateTarget {
  relPath: string;
  target: GateTarget;
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
  // Windows 8.3 short names (`VERYLO~1`) alias a long name the globs were written for (P0-5).
  if (IS_WIN32 && relPosix.split("/").some((s) => /~\d+(\.[^.]*)?$/.test(s))) {
    throw new GateDeny(
      "ERR_PATH_SEGMENT",
      "8.3 short-name path segment: use the long name",
      relPosix,
    );
  }
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
    apiVersion: "axiom.codai.ro/v3",
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
  return (await gatePredicateDenies(targets, profile))[0];
}

/** Every path/content predicate finding as a deny, in predicate order (path first). */
export async function gatePredicateDenies(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny[]> {
  const ctx = buildGateContext(targets);
  const findings = [];
  if (profile.deny.length > 0) findings.push(...(await pathDeny.run(ctx, { globs: profile.deny })));
  if (profile.allow !== undefined && profile.allow.length > 0)
    findings.push(...(await pathAllow.run(ctx, { globs: profile.allow })));
  const hasContent = targets.some((t) => t.target.content !== undefined);
  if (hasContent && profile.noSecrets) {
    const found = await contentNoSecrets.run(ctx, {
      disable: [],
      allowPaths: [],
      pii: profile.pii,
    });
    const excluded =
      profile.noSecretsExclude === undefined || profile.noSecretsExclude.length === 0
        ? undefined
        : globMatcher(profile.noSecretsExclude, false);
    findings.push(
      ...found.filter(
        (f) =>
          excluded === undefined ||
          f.path === undefined ||
          !PII_CLASS_IDS.has(f.id) ||
          !excluded(f.path),
      ),
    );
  }
  if (hasContent && profile.maxBytes !== undefined)
    findings.push(...(await contentMaxBytes.run(ctx, { max: profile.maxBytes })));
  return findings.map((f) => new GateDeny(f.id, f.message, f.path));
}

/** `content.noSecrets` ids that `noSecretsExclude` may silence (never real credentials). */
const PII_CLASS_IDS: ReadonlySet<string> = new Set([
  "content.noSecrets.email",
  "content.noSecrets.phoneRo",
  "content.noSecrets.cnp",
  "content.noSecrets.card",
  "content.noSecrets.credentialAssignment",
]);

// ------------------------------------------------------------- relaxation --

/** `axiom-override: <reason>` — the reason runs to the end of the line. */
const OVERRIDE_RE = /axiom-override:\s*([^\r\n]{1,300})/i;
/**
 * Tool-input fields an agent writes PROSE into (never file content, never the command body:
 * 3.0, D-44). A shell command may carry the override only as a trailing `# axiom-override:`
 * comment outside quotes and heredocs — see {@link findTrailingOverride}.
 */
const OVERRIDE_KEYS = ["explanation", "goal", "description", "reason", "justification"] as const;

/** ≥ 3 words with letters and ≥ 12 letters in total: "ok ok ok" or "........" is not a reason. */
export function isOverrideReason(reason: string): boolean {
  const words = reason.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = (reason.match(/\p{L}/gu) ?? []).length;
  return words.length >= 3 && letters >= 12;
}

/**
 * The override reason the agent stated in the tool call, or `undefined`. `command` is the
 * shell command of a shell-class tool (only its trailing comment counts); pass `undefined`
 * for every other tool so an apply_patch body or file content can never unlock a deny.
 */
export function findOverrideReason(
  input: Record<string, unknown>,
  command?: string,
): string | undefined {
  for (const k of OVERRIDE_KEYS) {
    const v = input[k];
    if (typeof v !== "string") continue;
    const m = OVERRIDE_RE.exec(v);
    const reason = m?.[1]?.replace(/["'`]+\s*$/, "").trim();
    if (reason !== undefined && isOverrideReason(reason)) return reason;
  }
  if (command !== undefined) return findTrailingOverride(command);
  return undefined;
}

/** True when `code` is listed in `hard` exactly, or under a `prefix.*` / `*` entry. */
export function isHardCode(hard: readonly string[], code: string): boolean {
  return hard.some((h) =>
    h === "*" ? true : h.endsWith(".*") ? code.startsWith(h.slice(0, -1)) : h === code,
  );
}

const SYSTEM_DIRS_WIN = [
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata",
];
const SYSTEM_DIRS_POSIX = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/lib",
  "/lib64",
  "/proc",
  "/sys",
  "/dev",
  "/System",
  "/Library",
];

/** Operating-system directories: `outside: "allow"` still warns for these. */
export function isSystemPath(abs: string, win32: boolean = IS_WIN32): boolean {
  const p = abs.replace(/\\/g, "/").replace(/^\/\/[?.]\/|^\/\?\?\//, "");
  const under = (dir: string, s: string) => s === dir || s.startsWith(`${dir}/`);
  if (win32) {
    const l = p.toLowerCase();
    return SYSTEM_DIRS_WIN.some((d) => under(d, l));
  }
  return SYSTEM_DIRS_POSIX.some((d) => under(d, p));
}

/** Ask id of a target matching the profile's `ask` globs (predicate-style, like `path.deny`). */
export const PATH_ASK_CODE = "path.ask";

function askDeny(relPath: string | undefined): GateDeny {
  return new GateDeny(
    PATH_ASK_CODE,
    `"${relPath ?? "."}" is a sensitive path (gate profile "ask"): confirm before the agent edits it`,
    relPath,
    { ask: true },
  );
}

/**
 * Profile `ask` globs: a target matching one → an `ask` verdict (the human confirms). Same glob
 * semantics as `path.deny` (it IS `path.deny` over the ask globs). Callers run it only after
 * every deny-class check passed, so a deny always wins.
 */
export async function runAskGlobs(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny | undefined> {
  if (profile.ask.length === 0) return undefined;
  const findings = await pathDeny.run(buildGateContext(targets), { globs: profile.ask });
  const f = findings[0];
  if (f === undefined) return undefined;
  return askDeny(f.path);
}

// ------------------------------------------ built-in self-protection (S-1410) --

/** Root-relative HARD set (`dot: true`, case-insensitive on Windows/macOS) — see `self-protect.ts`. */
const selfHardGlobs: (p: string) => boolean = globMatcher([...SELF_PROTECT_GLOBS], false);
/** Root-relative ASK set. */
const selfAskGlobs: (p: string) => boolean = globMatcher([...SELF_ASK_GLOBS], false);

function selfProtectDeny(relPath: string): GateDeny {
  return new GateDeny(
    SELF_PROTECT_CODE,
    `"${relPath}" decides whether AXIOM runs and what it enforces (policy, trust store, hook wiring or pins): only the human changes it, from the CLI`,
    relPath,
  );
}

function selfAskDeny(relPath: string): GateDeny {
  return new GateDeny(
    SELF_ASK_CODE,
    `"${relPath}" is harness configuration AXIOM shares with other tools: confirm before the agent edits it`,
    relPath,
    { ask: true },
  );
}

/** Absolute path of a root-relative POSIX target. */
function rootRelativeAbs(root: string, relPath: string): string {
  return path.join(root, ...relPath.split("/"));
}

/**
 * S-1410: the built-in set judged WITHOUT the profile. A profile must not be able to weaken it
 * (reality check #2: warn mode plus one allowed write rewrote the policy file), and `--profile`
 * may only tighten. Hard tier → deny; ask tier → the human confirms.
 */
export function selfProtectionDenies(
  targets: readonly ResolvedGateTarget[],
  root: string,
  home: string | undefined,
): { hard: GateDeny[]; ask: GateDeny[] } {
  const hard: GateDeny[] = [];
  const ask: GateDeny[] = [];
  for (const t of targets) {
    const rel = t.relPath;
    const abs = rootRelativeAbs(root, rel);
    const tree = selfTreeDeleteDeny(abs, root, home, t.target.recursive, rel);
    if (tree !== undefined) {
      hard.push(tree);
      continue;
    }
    const tier = home === undefined ? undefined : selfProtectHomeTier(abs, home);
    if (selfHardGlobs(rel) || tier === "hard") hard.push(selfProtectDeny(rel));
    else if (selfAskGlobs(rel) || tier === "ask") ask.push(selfAskDeny(rel));
  }
  return { hard, ask };
}

/**
 * S-1410: tier of an ABSOLUTE target that escaped the repository root. `outside: allow|warn` used
 * to let `~/.axiom/**` through (EN-3/A3-1) — a policy or daemon file planted in the home
 * directory is still AXIOM's, whatever `outside` says. `undefined` means "not ours".
 */
export function selfOutsideDeny(abs: string, home: string | undefined): GateDeny | undefined {
  if (home === undefined) return undefined;
  const shown = abs.replace(/\\/g, "/");
  const tier = selfProtectHomeTier(abs, home);
  if (tier === "hard") return selfProtectDeny(shown);
  if (tier === "ask") return selfAskDeny(shown);
  return undefined;
}

/** True when `abs` is `dir`, an ancestor of `dir`, or the repository's own `dir/.git`. */
function isDirOrAncestorOrGit(abs: string, dir: string, win32: boolean): boolean {
  const strip = (p: string): string => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return win32 ? s.toLowerCase() : s;
  };
  const a = strip(abs);
  const d = strip(dir);
  if (a === "" || d === "") return false;
  if (a === `${d}/.git`) return true;
  if (a.endsWith("/.git")) return false; // a nested .git belongs to another repository
  if (a === d) return true;
  return d.startsWith(`${a}/`); // `abs` is an ancestor of `dir`
}

/**
 * S-1410: a RECURSIVE delete that would take the home directory, the repository root (or one of
 * its ancestors), a filesystem root or the repository's `.git` with it is a hard deny in every
 * mode (`self.treeDelete`) — no profile, override or `--fail-open` may allow it.
 */
export function selfTreeDeleteDeny(
  abs: string,
  root: string,
  home: string | undefined,
  recursive: boolean | undefined,
  /** What the verdict names the target by: the root-relative path when there is one. */
  shown: string = abs.replace(/\\/g, "/"),
): GateDeny | undefined {
  if (recursive !== true) return undefined;
  const p = abs.replace(/\\/g, "/").replace(/\/+$/, "");
  const isFsRoot = p === "" || /^[A-Za-z]:$/.test(p);
  const win32 = process.platform === "win32";
  const hits = [root, home].some(
    (d) => d !== undefined && d !== "" && isDirOrAncestorOrGit(abs, d, win32),
  );
  if (!isFsRoot && !hits) return undefined;
  return new GateDeny(
    SELF_TREE_DELETE_CODE,
    `recursive delete of ${shown === "" ? "a filesystem root" : `"${shown}"`} would take the repository, the home directory or AXIOM's own state with it`,
    shown,
  );
}

/** Deny id of `steer: "require"` (predicate-style, like `path.deny`). */
export const STEER_REQUIRE_CODE = "steer.requireApply";

/** Whole-file write tools: a create/overwrite, as opposed to a targeted edit. */
const WHOLE_FILE_TOOL_RE = /^(create_file|createfile|write_file|writefile|write|create_new_file)$/i;

export function isWholeFileTool(toolName: string): boolean {
  return WHOLE_FILE_TOOL_RE.test(toolName.replace(/^.*[.:/]/, ""));
}

function toSessionTargets(
  resolved: readonly ResolvedGateTarget[],
  toolName: string,
): SessionTarget[] {
  const whole = isWholeFileTool(toolName);
  return resolved.map((r) => ({ relPath: r.relPath, op: r.target.op, whole }));
}

/** A denied whole-file create leaves a marker so re-running that script is refused (S-1215). */
async function noteDeniedCreate(
  rootReal: string,
  cls: ToolClass,
  toolName: string,
  resolved: readonly ResolvedGateTarget[],
  targetRoot: string,
  profile: GateProfile,
  dryRun = false,
): Promise<void> {
  if (dryRun || cls !== "write" || !isWholeFileTool(toolName)) return;
  if (profile.sessions !== undefined && !profile.sessions.staleScript) return;
  for (const r of resolved) await recordDeniedCreate(rootReal, path.join(targetRoot, r.relPath));
}

/**
 * Shell-command rules of the v2.6 profile, in order: stale script (S-1215) → command rules
 * (S-1208) → coordination (S-1212) → git state (S-1213). Every command rule is evaluated
 * (3.0): the returned list keeps that order, so callers pick a hard verdict before the first.
 */
export async function runCommandRules(
  command: string,
  profile: GateProfile,
  rootReal: string,
  home?: string,
): Promise<RuleVerdict[]> {
  const out: RuleVerdict[] = [];
  if (profile.sessions === undefined || profile.sessions.staleScript) {
    const v = await checkStaleScript(rootReal, command);
    if (v !== undefined) out.push(v);
  }
  if (profile.commands !== undefined) out.push(...evaluateCommandRules(command, profile.commands));
  if (profile.coordination !== undefined) {
    const v = await evaluateCoordination(command, profile.coordination, {
      root: rootReal,
      ...(home === undefined ? {} : { home }),
    });
    if (v !== undefined) out.push(v);
  }
  if (profile.git !== undefined) {
    const v = await evaluateGit(command, profile.git as GitRules, rootReal);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * `steer: "require"`: a direct write touching `steerGlobs` is denied — the agent must go through
 * `axiom_write`. Same glob semantics as `path.deny` (it IS `path.deny` over the steer globs).
 */
export async function runSteerRequire(
  targets: readonly ResolvedGateTarget[],
  profile: GateProfile,
): Promise<GateDeny | undefined> {
  if (profile.steer !== "require" || profile.steerGlobs.length === 0) return undefined;
  const findings = await pathDeny.run(buildGateContext(targets), { globs: profile.steerGlobs });
  const f = findings[0];
  if (f === undefined) return undefined;
  return new GateDeny(
    STEER_REQUIRE_CODE,
    "this path must be changed through the axiom_write MCP tool (preview, then apply with confirmDigest), not a direct write",
    f.path,
  );
}

/** Once-per-session context hint for allowed writes (`steer: "hint" | "require"`). */
export const GATE_STEER_HINT =
  "This repository is guarded by AXIOM. For multi-file or sensitive changes prefer the axiom_write MCP tool (preview → apply with confirmDigest): atomic, checked, journaled, one-step rollback.";

/**
 * True exactly once per (root, session): creates `<root>/.axiom/hints/<sha256(session)[:16]>`
 * exclusively. Any fs error → false (a hint is never worth a failure).
 */
export async function claimSessionHint(root: string, sessionId: string): Promise<boolean> {
  const dir = path.join(root, ".axiom", "hints");
  try {
    await mkdir(dir, { recursive: true });
    const fh = await open(path.join(dir, sha256Hex(sessionId).slice(0, 16)), "wx");
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- run --

export const GATE_LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type GateLogLevel = (typeof GATE_LOG_LEVELS)[number];
const RANK: Record<GateLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface GateOptions {
  /** Fallback root when the payload has no `cwd`. */
  root?: string;
  /** stdin exceeded the size cap: an agent action, judged fail-closed (unlike an empty stdin). */
  stdinTooLarge?: boolean;
  /**
   * 4.0 (A2-17/A3-18): bytes received before the read gave up. A timeout that received NOTHING is
   * a harness hiccup (allow + warn); a timeout after bytes arrived truncated a write (fail closed).
   */
  stdinBytes?: number;
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
  /**
   * `--track-reads` (S-1215): read tools reach the full gate (the `cli.ts` fast path is skipped)
   * so a profile with `sessions.trackReads` can record what each session has seen.
   */
  trackReads?: boolean;
  /**
   * Exit code for a deny (D-35). Default 0: the JSON document on stdout carries the decision,
   * which survives the npm `.ps1` shim. 2 for harnesses that only read the exit code (Windsurf).
   */
  denyExit?: 0 | 2;
  /** Harness output contract (`--format`); default `auto` = combined Claude + Copilot document. */
  format?: GateFormat;
  logLevel?: GateLogLevel;
  /**
   * 4.0 contract: judge only. No decision-journal line, no session / undo / hint / stale-script
   * state is written. Used by `axiom explain '<command or path>'`, `axiom try` and the doctor
   * probes, so a question about the gate never shows up as an agent action.
   */
  dryRun?: boolean;
  /** Test hook for `~/.axiom/gate-profile.json`. */
  home?: string;
  /**
   * Last-resort cwd. The hook is the ONE place where the harness's cwd is acceptable:
   * both Claude Code and Copilot CLI spawn the hook in the project directory and put the
   * same value in the payload's `cwd`, so there is no ambiguity about who owns it.
   */
  cwdFallback?: () => string;
}
/** Read keys of read-only file tools (`read_file`, Claude `Read`, …). */
const READ_TOOL_RE = /(^|[_.:-])(read|view)([_-]?file|[_-]?notebook)?$|^read/i;

/** Record a read for `sessions.trackReads` (advisory; never fails the call). */
async function trackRead(
  payload: NormalizedPayload,
  opts: GateOptions,
  log: (lvl: GateLogLevel, msg: string) => void,
): Promise<void> {
  try {
    if (payload.sessionId === undefined || !READ_TOOL_RE.test(payload.toolName)) return;
    const rawPath = firstString(payload.input, PATH_KEYS);
    if (rawPath === undefined) return;
    const rootArg = payload.cwd ?? opts.root ?? (opts.cwdFallback ?? (() => process.cwd()))();
    const cwdReal = await realOrResolved(path.resolve(rootArg));
    const rootReal =
      opts.noRootDiscovery === true ? cwdReal : await discoverRoot(cwdReal, opts.home);
    const { gate: profile } = await resolvePolicy(rootReal, {
      ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
      ...(opts.home === undefined ? {} : { home: opts.home }),
    });
    if (profile.sessions?.trackReads !== true) return;
    const r = await resolveGateTarget(
      rootReal,
      { rawPath, op: "write", content: undefined },
      cwdReal,
    );
    await recordSessionRead(rootReal, payload.sessionId, "", [r.relPath]);
  } catch (err) {
    log("debug", `track read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface GateResult {
  decision: "allow" | "deny";
  /** OWASP Agent Control Standard v0.1 Guardian vocabulary; the gate emits `allow` or `deny`. */
  verdict: "allow" | "deny" | "modify" | "ask" | "defer";
  exitCode: 0 | 2;
  code?: string;
  reason?: string;
  path?: string;
  /**
   * The stdout document for the chosen format: on deny the format's deny shape (`auto` = Claude
   * `hookSpecificOutput` + Copilot flat shape + `axiom` block); on allow a hint or Cursor's
   * explicit allow, otherwise absent.
   */
  stdout?: string;
  /** Steering hint attached to an allowed write (once per session). */
  hint?: string;
  stderr: string[];
  durationMs: number;
  /** Which class of tool was judged. */
  toolClass?: ToolClass;
  /** Root actually used, when one was resolved. */
  root?: string;
}

function denyResult(
  d: GateDeny,
  stderr: string[],
  t0: number,
  extra: { toolClass?: ToolClass; root?: string; denyExit?: 0 | 2; format?: GateFormat } = {},
): GateResult {
  const where = d.relPath === undefined ? "" : ` (${d.relPath})`;
  const fix = d.fix === undefined ? "" : ` — fix: ${d.fix}`;
  const reason = `AXIOM GATE ${d.ask ? "ASK" : "DENY"} ${d.code}: ${d.message}${where}${fix}`;
  stderr.push(reason);
  const out = renderDeny(extra.format ?? "auto", d, reason, {
    ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
    ...(extra.denyExit === undefined ? {} : { denyExit: extra.denyExit }),
  });
  const asked = d.ask && ASK_FORMATS.has(extra.format ?? "auto");
  return {
    decision: "deny",
    verdict: asked ? "ask" : "deny",
    exitCode: out.exitCode,
    code: d.code,
    reason: d.message,
    ...(d.relPath === undefined ? {} : { path: d.relPath }),
    ...(out.stdout === undefined ? {} : { stdout: out.stdout }),
    stderr,
    durationMs: performance.now() - t0,
    ...(extra.toolClass === undefined ? {} : { toolClass: extra.toolClass }),
    ...(extra.root === undefined ? {} : { root: extra.root }),
  };
}

/** Deny id for `git clean` / `git reset --hard` on the whole tree (3.0, P0-6). */
export const DESTRUCTIVE_TREE_CODE = "git.destructiveTree";

/** `git.destructiveTree` is hard whenever the profile hardens reset --hard or clean -f. */
export function destructiveTreeIsHard(hard: readonly string[]): boolean {
  return (
    isHardCode(hard, DESTRUCTIVE_TREE_CODE) ||
    isHardCode(hard, "house.resetHard") ||
    isHardCode(hard, "house.cleanForce")
  );
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
  const format: GateFormat = opts.format ?? "auto";
  const stderr: string[] = [];
  let toolClass: ToolClass | undefined;
  let rootUsed: string | undefined;
  const log = (lvl: GateLogLevel, msg: string) => {
    if (RANK[lvl] <= RANK[level]) stderr.push(`AXIOM GATE ${lvl.toUpperCase()}: ${msg}`);
  };
  const allow = (why: string, hint?: string): GateResult => {
    log("debug", `allow: ${why}`);
    const stdout = allowDocument(format, hint);
    return {
      decision: "allow",
      verdict: "allow",
      exitCode: GATE_EXIT_ALLOW,
      ...(stdout === undefined ? {} : { stdout }),
      ...(hint === undefined ? {} : { hint }),
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
      ...(opts.denyExit === undefined ? {} : { denyExit: opts.denyExit }),
      format,
    });
  /** Fail-closed (D-18): a non-answer is a deny unless the operator opted out. */
  const internal = (why: string): GateResult => {
    if (opts.failOpen === true) {
      log("warn", `${why} — failing open (--fail-open)`);
      return allow("internal error");
    }
    return deny(new GateDeny("ERR_INTERNAL", `${why} (fail-closed; pass --fail-open to allow)`));
  };

  // An empty / timed-out stdin is a harness or wiring hiccup, not an agent action: every
  // harness already fails open on a hook timeout, so denying here only stalls long-running
  // chats (3.0, S-1313). Unparseable JSON stays fail-closed.
  if (payloadText === undefined && opts.stdinTooLarge === true) {
    return internal(`stdin exceeded ${GATE_STDIN_MAX_BYTES} bytes`);
  }
  if (payloadText === undefined) {
    // 4.0 (A3-18): a timeout that HAD received bytes is a truncated write, not a hiccup.
    if ((opts.stdinBytes ?? 0) > 0) {
      return internal(`stdin timed out after ${opts.stdinBytes} bytes`);
    }
    log("warn", "no payload on stdin (timeout or empty) — allowing");
    return allow("no payload on stdin");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch {
    // Never echo the parse error: it quotes the payload, which may carry a secret.
    return internal(`payload is not JSON (${payloadText.length} bytes)`);
  }
  const payload = normalizePayload(raw);
  // 4.0 (A2-18): a payload that IS a hook tool call but names no tool. With an explicit --format
  // that is a wrong shape guess, not a harness hiccup: warn about it, and deny it outright for
  // the formats that do not read stdout (an empty allow would pass silently).
  if (payload !== undefined && payload.unknownTool === true) {
    const explicit = format !== "auto";
    log(explicit ? "warn" : "info", `payload names no tool (--format ${format})`);
    if (explicit && GATE_FORMAT_TABLE[format].document === "none" && opts.failOpen !== true) {
      return deny(
        new GateDeny(
          "ERR_INVALID_INPUT",
          `payload from --format ${format} names no tool; check the hook wiring`,
        ),
      );
    }
    return allow("payload carries no tool name");
  }
  // No tool name at all: not a PreToolUse payload we understand. Nothing to judge → allow
  // (a hook wired to the wrong event must not brick the editor); logged at info.
  if (payload === undefined) {
    log("info", "payload carries no tool name");
    return allow("payload carries no tool name");
  }
  const extracted = extractTargets(payload);
  toolClass = extracted.cls;
  if (extracted.cls === "other") {
    if (opts.trackReads === true && opts.dryRun !== true) await trackRead(payload, opts, log);
    return allow(`tool ${payload.toolName} is not a write/shell tool`);
  }
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
  }
  const targets = extracted.targets;
  // A shell command with no write target may still hit a command / coordination / git rule
  // (v2.6), so it needs the profile; a write tool with none was handled above.
  // 4.0 (A2-9/A2-25): prefer the command the payload extractor resolved - argv elements quoted,
  // a `run_task` id through `.vscode/tasks.json`, a tasks.json write - over the raw input.
  const command =
    extracted.command ??
    (extracted.cls === "shell"
      ? commandString(payload.input, {
          ...(payload.commandCwd === undefined ? {} : { cwd: payload.commandCwd }),
        })
      : undefined);
  // A `noTarget` write (nothing on disk to judge) must still reach the journal, so it continues
  // to the profile instead of being allowed here.
  if (
    targets.length === 0 &&
    command === undefined &&
    !extracted.undetermined &&
    extracted.noTarget !== true
  )
    return allow(`tool ${payload.toolName} writes nothing recognisable`);
  const agentId = `${payload.harness ?? (format === "auto" ? "unknown" : format)}:${payload.sessionId ?? "unknown"}`;

  /** Set once the main root and its profile are known: what the decision journal needs. */
  let rec: { root: string; profile: GateProfile; source: string } | undefined;
  /** Profile file of the root that produced the blocking finding, when not the main one. */
  let decidingProfile: string | undefined;
  const judgedPaths: string[] = [];
  /**
   * Shadow mode (S-1216): the FIRST v2.6 rule verdict (command / coordination / git / session)
   * is remembered instead of enforced; the call continues and the journal line carries what the
   * gate would have decided. Path / content predicates keep enforcing — shadow never weakens the
   * protection a profile already had.
   */
  let shadowOf: GateResult | undefined;
  /** Id of the v2.6 rule that decided (enforced or shadowed), for the journal's `rule` field. */
  let ruleOf: string | undefined;
  /**
   * 4.0: a RELAXABLE command verdict is remembered here instead of being returned at once, so the
   * hard whole-tree / self-protection checks on the targets are judged first (3.0 returned the
   * command verdict before them, which let a relaxable code shadow a hard one).
   */
  let pendingRuleVerdict: RuleVerdict | undefined;
  /** 2.7: denies let through as warnings (`mode: "warn"`, an override, or `outside`). */
  const warnings: string[] = [];
  let relaxedKind: "warn" | "override" | undefined;
  let relaxedCode: string | undefined;
  const overrideReason = findOverrideReason(payload.input, command);
  /** True when `d` is let through (and remembered as a warning); hard codes and asks never are. */
  const relax = (d: GateDeny, p: GateProfile | undefined = rec?.profile): boolean => {
    // `isSelfHardCode` (S-1410): the built-in set is hard in EVERY mode, whatever `hard` lists.
    if (p === undefined || d.ask || isHardCode(p.hard, d.code) || isSelfHardCode(d.code))
      return false;
    let kind: "warn" | "override";
    if (p.override && overrideReason !== undefined) kind = "override";
    else if (p.mode === "warn") kind = "warn";
    else return false;
    if (relaxedKind !== "override") relaxedKind = kind;
    relaxedCode ??= d.code;
    const where = d.relPath === undefined ? "" : ` (${d.relPath})`;
    const fix = d.fix === undefined ? "" : ` — fix: ${d.fix}`;
    const msg =
      kind === "override"
        ? `AXIOM GATE OVERRIDE ${d.code}: ${d.message}${where} — allowed because the agent stated: "${overrideReason}"`
        : `AXIOM GATE WARN ${d.code}: ${d.message}${where}${fix} — allowed (warn mode); if this was unintended, stop and fix it`;
    warnings.push(msg);
    if (RANK.warn <= RANK[level]) stderr.push(msg);
    return true;
  };
  const recorded = async (r: GateResult): Promise<GateResult> => {
    if (rec === undefined || opts.dryRun === true) return r;
    // Relaxed decisions (warn / override) are always journaled: they are the audit trail D-40
    // promised. Plain allow/deny lines need `record` or `shadow`.
    const relaxedHere = r.decision === "allow" && relaxedKind !== undefined;
    if (!rec.profile.record && !rec.profile.shadow && !relaxedHere) return r;
    try {
      const judged = r.decision === "allow" && shadowOf !== undefined ? shadowOf : r;
      const relaxedAllow = judged.decision === "allow" && relaxedKind !== undefined;
      await appendDecision(rec.root, {
        v: 1,
        decided_at: new Date().toISOString(),
        agent_id: agentId,
        principal: { subject: principalSubject() },
        tool: payload.toolName,
        ...hashArgs(payload.input),
        decision: judged.verdict === "ask" ? "ask" : judged.decision,
        ...(judged.code === undefined ? {} : { code: judged.code }),
        ...(relaxedAllow && relaxedCode !== undefined ? { code: relaxedCode } : {}),
        ...(relaxedAllow && relaxedKind !== undefined ? { relaxed: relaxedKind } : {}),
        ...(relaxedAllow && relaxedKind === "override" && overrideReason !== undefined
          ? { override_reason: overrideReason }
          : {}),
        ...(judged.reason === undefined ? {} : { reason: judged.reason }),
        paths: [...new Set(judgedPaths)],
        // 4.0: a write-named tool with nothing on disk to judge is allowed and marked as such.
        ...(extracted.noTarget === true ? { no_target: true as const } : {}),
        profile: rec.source,
        ...(decidingProfile !== undefined && decidingProfile !== rec.source
          ? { profile_decided: decidingProfile }
          : {}),
        ms: Math.round(judged.durationMs * 10) / 10,
        ...(rec.profile.shadow ? { shadow: true as const } : {}),
        // Shadow records carry the command so `guard-parity.mjs --replay` can diff it (S-1216).
        ...((rec.profile.shadow || relaxedAllow) && command !== undefined ? { command } : {}),
        ...(ruleOf !== undefined &&
        (judged.code === ruleOf || (relaxedAllow && relaxedCode === ruleOf))
          ? { rule: ruleOf }
          : {}),
      });
    } catch (err) {
      log("debug", `decision journal: ${err instanceof Error ? err.message : String(err)}`);
    }
    return r;
  };
  /** A v2.6 rule verdict: enforced, or (shadow mode) remembered and `undefined` returned. */
  const ruleVerdict = async (v: RuleVerdict): Promise<GateResult | undefined> => {
    if (rec?.profile.shadow === true) {
      if (shadowOf === undefined) {
        ruleOf = v.id;
        shadowOf = denyResult(verdictDeny(v), [], t0, {
          ...(toolClass === undefined ? {} : { toolClass }),
          format,
        });
      }
      log(
        "info",
        `shadow: would ${v.decision ?? "deny"} ${v.id}${v.path === undefined ? "" : ` (${v.path})`}`,
      );
      return undefined;
    }
    ruleOf = v.id;
    const d = verdictDeny(v);
    if (relax(d)) return undefined;
    return recorded(deny(d));
  };

  try {
    const rootArg = payload.cwd ?? opts.root ?? (opts.cwdFallback ?? (() => process.cwd()))();
    let rootReal = await realpathNative(path.resolve(rootArg));
    if (IS_WIN32 && rootReal.startsWith("\\\\?\\")) rootReal = rootReal.slice(4);
    // Relative targets are relative to where the agent runs (the payload cwd), even after the
    // root is discovered above it.
    const cwdReal = rootReal;
    // 4.0 (contract 3): SHELL operands resolve against the directory the tool INPUT names
    // (`commandCwd`); a file tool keeps resolving against the payload cwd.
    const operandCwd =
      extracted.cls === "shell" && payload.commandCwd !== undefined
        ? path.resolve(cwdReal, payload.commandCwd)
        : cwdReal;
    if (opts.noRootDiscovery !== true) {
      const discovered = await discoverRoot(rootReal, opts.home);
      if (discovered !== rootReal) {
        log("debug", `root discovered ${rootReal} → ${discovered}`);
        rootReal = discovered;
      }
    }
    rootUsed = rootReal;
    const profiles = new Map<string, { profile: GateProfile; source: string }>();
    const loadFor = async (root: string): Promise<{ profile: GateProfile; source: string }> => {
      const hit = profiles.get(root);
      if (hit !== undefined) return hit;
      // ONE resolver for every consumer of the policy (4.0, S-1407).
      const policy = await resolvePolicy(root, {
        ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
        ...(opts.home === undefined ? {} : { home: opts.home }),
      });
      for (const w of policy.warnings) log("warn", `${policy.source}: ${w}`);
      const loaded = { profile: policy.gate, source: policy.source };
      log("debug", `root=${root} profile=${loaded.source}`);
      profiles.set(root, loaded);
      return loaded;
    };
    const main = await loadFor(rootReal);
    const profile = main.profile;
    rec = { root: rootReal, profile, source: main.source };
    log("debug", `class=${extracted.cls} targets=${targets.length}`);
    // 4.0: nothing on disk to judge (`noTarget`): allow it here, where the profile - and with it
    // the decision journal - is known, so the call leaves a trace instead of vanishing.
    if (extracted.noTarget === true) {
      return recorded(allow(`tool ${payload.toolName} writes nothing recognisable`));
    }
    if (extracted.undetermined) {
      // Write-class tool, target unknown (D-18: unknown → deny with reason) — judged after the
      // profile loads so warn mode / an override relax it like any other deny (3.0).
      const d = new GateDeny(
        "ERR_UNSUPPORTED_OP",
        `write tool "${payload.toolName}" carries no recognised path key (${PATH_KEYS.join(", ")}); add it to the gate or pass --fail-open`,
      );
      if (!relax(d)) return recorded(deny(d));
      return recorded(allow("undetermined write target relaxed", warnings.join("\n")));
    }
    if (command !== undefined) {
      const found = await runCommandRules(command, profile, rootReal, opts.home);
      // 4.0 (contract 4): a verdict carrying `advisory: true` never blocks. The reason is attached
      // as a warning; with `oncePerSession` it is shown once per (root, session, rule), claimed
      // through the same hint file steer hints use (`D-53`: `house.typecheckUnqueued`).
      const blocking: RuleVerdict[] = [];
      for (const x of found) {
        if (x.advisory !== true) {
          blocking.push(x);
          continue;
        }
        const once =
          x.oncePerSession === true &&
          !(await claimSessionHint(rootReal, `${payload.sessionId ?? "no-session"}:${x.id}`));
        if (once) continue;
        const msg = `AXIOM GATE ADVISE ${x.id}: ${x.reason}${x.fix === undefined ? "" : ` — fix: ${x.fix}`}`;
        warnings.push(msg);
        if (RANK.warn <= RANK[level]) stderr.push(msg);
      }
      // A hard verdict anywhere wins over an earlier relaxable one (3.0: hard by code, never
      // by evaluation order).
      const v = blocking.find((x) => isHardCode(profile.hard, x.id)) ?? blocking[0];
      if (v !== undefined) {
        // 4.0: a RELAXABLE command verdict no longer short-circuits the hard target checks
        // (self-protection, whole-tree discard): it is remembered and the targets are judged
        // first, so `git -C . checkout -- .axiom/axiom.json` keeps answering the hard code. The
        // verdict is still returned when nothing hard comes out of them, which is the 3.0 order.
        if (isHardCode(profile.hard, v.id)) {
          const r = await ruleVerdict(v);
          if (r !== undefined) return r;
        } else {
          pendingRuleVerdict = v;
        }
      }
    }
    /** Targets grouped by the root they are judged against (the main root, or a sibling worktree). */
    const groups = new Map<string, ResolvedGateTarget[]>();
    /** First `ask` verdict (profile `ask` globs); returned only once every deny check passed. */
    let pendingAsk: GateDeny | undefined;
    /** Absolute out-of-root targets `outside` let through (undo snapshot, I-20). */
    const outsideAbs: string[] = [];
    const add = (root: string, r: ResolvedGateTarget) => {
      judgedPaths.push(r.relPath);
      const g = groups.get(root);
      if (g === undefined) groups.set(root, [r]);
      else g.push(r);
    };
    for (const t of targets) {
      if (extracted.cls === "shell" && t.rawPath === ".") {
        // `git clean` / `reset --hard` on the root itself — the root is not an escape, so this
        // is judged BEFORE containment/outside (3.0, P0-6). Deny when the profile protects
        // anything; code `git.destructiveTree` is hard whenever reset/clean are hard.
        judgedPaths.push(".");
        if (profile.deny.length > 0 || profile.commands !== undefined) {
          const d = new GateDeny(
            DESTRUCTIVE_TREE_CODE,
            "destructive git command on the whole tree",
            ".",
          );
          if (destructiveTreeIsHard(profile.hard)) throw d;
          if (relax(d)) continue;
          throw d;
        }
        if (profile.ask.length > 0) pendingAsk ??= askDeny(".");
        continue;
      }
      try {
        add(rootReal, await resolveGateTarget(rootReal, t, operandCwd));
      } catch (err) {
        if (err instanceof GateDeny && err.code === "ERR_CONTAINMENT") {
          const wt = await sameRepoWorktreeRoot(rootReal, t.rawPath, operandCwd);
          if (wt !== undefined) {
            log("debug", `target ${JSON.stringify(t.rawPath)} judged in worktree ${wt}`);
            add(wt, await resolveGateTarget(wt, t, operandCwd));
            continue;
          }
          const supplied = t.rawPath.replace(/\\/g, "/");
          const abs = path.isAbsolute(supplied) ? supplied : path.resolve(operandCwd, supplied);
          // S-1410: a recursive delete that would take the home directory, the repository root,
          // an ancestor or `.git` with it is hard in every mode, `outside` included.
          const tree = selfTreeDeleteDeny(abs, rootReal, opts.home, t.recursive);
          if (tree !== undefined) {
            if (relax(tree)) continue;
            throw tree;
          }
          // S-1410: `outside: allow|warn` never covers AXIOM's own home state (EN-3/A3-1).
          const selfDeny = selfOutsideDeny(abs, opts.home);
          if (selfDeny !== undefined) {
            if (selfDeny.ask === true) {
              pendingAsk ??= selfDeny;
              continue;
            }
            if (relax(selfDeny)) continue;
            throw selfDeny;
          }
          if (profile.outside !== "deny") {
            if (profile.outside === "warn" || isSystemPath(abs)) {
              const msg = `AXIOM GATE WARN ERR_CONTAINMENT: ${abs} is outside ${rootReal}${isSystemPath(abs) ? " (operating-system directory)" : ""} — allowed (outside: ${profile.outside})`;
              warnings.push(msg);
              if (RANK.warn <= RANK[level]) stderr.push(msg);
            }
            outsideAbs.push(abs);
            continue;
          }
          if (relax(err)) continue;
        }
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
        if (err instanceof GateDeny && relax(err)) continue;
        throw err;
      }
    }
    let n = 0;
    for (const [root, resolved] of groups) {
      const loadedP = await loadFor(root);
      const p = loadedP.profile;
      const steer = await runSteerRequire(resolved, p);
      // S-1410: the built-in set is judged first and independently of this profile.
      const selfDenies = selfProtectionDenies(resolved, root, opts.home);
      const found = [
        ...selfDenies.hard,
        ...(await gatePredicateDenies(resolved, p)),
        ...(steer ? [steer] : []),
      ];
      // A hard code anywhere wins over earlier relaxable findings.
      const blocking =
        found.find((d) => isSelfHardCode(d.code) || isHardCode(p.hard, d.code)) ??
        // 4.0: with a relaxable command verdict pending, a relaxable target finding does not
        // decide — that verdict is returned after the loop (the 3.0 answer), so only a HARD
        // finding can win over it.
        (pendingRuleVerdict === undefined ? found.find((d) => !relax(d, p)) : undefined);
      if (blocking !== undefined) {
        if (loadedP.source !== main.source) decidingProfile = loadedP.source;
        await noteDeniedCreate(
          rootReal,
          extracted.cls,
          payload.toolName,
          resolved,
          root,
          profile,
          opts.dryRun === true,
        );
        return recorded(deny(blocking));
      }
      pendingAsk ??= selfDenies.ask[0] ?? (await runAskGlobs(resolved, p));
      n += resolved.length;
    }
    // 4.0: the relaxable command verdict remembered above is the 3.0 answer when no HARD target
    // finding won (a hard one returned inside the loop). Shadow mode / warn / override relax it
    // here exactly as they would have at the command block.
    if (pendingRuleVerdict !== undefined) {
      const pending = pendingRuleVerdict;
      pendingRuleVerdict = undefined;
      const r = await ruleVerdict(pending);
      if (r !== undefined) return r;
    }
    const sessionTargets = toSessionTargets(groups.get(rootReal) ?? [], payload.toolName);
    if (profile.sessions !== undefined && extracted.cls === "write") {
      const v = await checkSessionWrite(
        {
          root: rootReal,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          agentId,
          tool: payload.toolName,
          targets: sessionTargets,
        },
        profile.sessions,
      );
      if (v !== undefined) {
        const r = await ruleVerdict(v);
        if (r !== undefined && v.decision !== "ask") {
          await noteDeniedCreate(
            rootReal,
            extracted.cls,
            payload.toolName,
            groups.get(rootReal) ?? [],
            rootReal,
            profile,
            opts.dryRun === true,
          );
        }
        if (r !== undefined) return r;
      }
    }
    // Every deny passed: an `ask` glob hands the decision to the human (deny on non-ask formats).
    if (pendingAsk !== undefined) return recorded(deny(pendingAsk));
    const live = opts.dryRun !== true;
    if (live && profile.undo && outsideAbs.length > 0) {
      await captureOutsideUndo(rootReal, {
        ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        agentId,
        tool: payload.toolName,
        absPaths: outsideAbs,
      });
    }
    if (live && sessionTargets.length > 0) {
      // Allowed: capture the pre-image for `axiom undo` and remember who is writing what.
      if (profile.undo) {
        await captureUndo(rootReal, {
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          agentId,
          tool: payload.toolName,
          targets: sessionTargets,
        });
      }
      if (profile.sessions !== undefined) {
        await recordSessionWrite({
          root: rootReal,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          agentId,
          tool: payload.toolName,
          targets: sessionTargets,
        });
      }
    }
    let hint: string | undefined;
    if (
      live &&
      extracted.cls === "write" &&
      profile.steer !== "off" &&
      payload.sessionId !== undefined &&
      HINT_FORMATS.has(format) &&
      (await claimSessionHint(rootReal, payload.sessionId))
    ) {
      hint = GATE_STEER_HINT;
    }
    if (warnings.length > 0) {
      const w = warnings.join("\n");
      hint = hint === undefined ? w : `${w}\n${hint}`;
    }
    return recorded(allow(`${n} target(s) passed (${extracted.cls})`, hint));
  } catch (err) {
    if (err instanceof GateDeny) return recorded(deny(err));
    if (err instanceof GateProfileError) {
      // A broken / too-new profile is never covered by --fail-open: failing open here would
      // silently switch the gate off (P0-11).
      return deny(new GateDeny(err.code, err.message));
    }
    return recorded(internal(err instanceof Error ? err.message : String(err)));
  }
}

// ------------------------------------------------------------------- cli --

export const GATE_USAGE =
  "usage: axiom gate --stdin [--post] [--root <dir>] [--profile <file>] [--fail-open] [--no-shell-scan] [--no-root-discovery] [--track-reads] [--deny-exit 0|2] [--format auto|claude|copilot|vscode|codex|cursor|windsurf|gemini|junie|cline] [--log-level error|warn|info|debug]";

function usageError(why: string, t0: number, format: GateFormat): GateResult {
  return {
    decision: "deny",
    verdict: "deny",
    exitCode: GATE_EXIT_DENY,
    reason: why,
    // Cline ignores exit codes: only a cancel document stops the tool.
    ...(format === "cline"
      ? { stdout: JSON.stringify({ cancel: true, errorMessage: `AXIOM GATE ERROR: ${why}` }) }
      : {}),
    stderr: [`AXIOM GATE ERROR: ${why}`, GATE_USAGE],
    durationMs: performance.now() - t0,
  };
}

/**
 * `axiom gate <argv>` → result. Reads stdin only when `--stdin` is given — unless `io.read`
 * carries a payload the caller already read (the `cli.ts` fast path). Never throws.
 */
export async function gateMain(
  argv: readonly string[],
  io: {
    stdin?: NodeJS.ReadableStream;
    read?: StdinRead;
    cwdFallback?: () => string;
    home?: string;
  } = {},
): Promise<GateResult> {
  const t0 = performance.now();
  // Scanned before parseArgs so even an argv error answers in the harness's own format.
  const argvFormat = formatFromArgv(argv);
  if (argv.includes("--post")) {
    // PostToolUse (S-1205): its own module, always exit 0 — a post hook cannot stop a tool.
    const read = io.read ?? (await readStdin(io.stdin ?? process.stdin));
    return postMain(argv, {
      read,
      ...(io.cwdFallback === undefined ? {} : { cwdFallback: io.cwdFallback }),
      ...(io.home === undefined ? {} : { home: io.home }),
    });
  }
  let values: {
    stdin?: boolean;
    root?: string;
    profile?: string;
    strict?: boolean;
    "fail-open"?: boolean;
    "no-shell-scan"?: boolean;
    "no-root-discovery"?: boolean;
    "track-reads"?: boolean;
    "dry-run"?: boolean;
    "deny-exit"?: string;
    format?: string;
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
        "track-reads": { type: "boolean" },
        "dry-run": { type: "boolean" },
        "deny-exit": { type: "string" },
        format: { type: "string" },
        "log-level": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err), t0, argvFormat);
  }
  const denyExitRaw = values["deny-exit"];
  const formatRaw = values.format;
  if (formatRaw !== undefined && !isGateFormat(formatRaw))
    return usageError(`--format must be one of ${GATE_FORMATS.join("|")}`, t0, argvFormat);
  const format: GateFormat = formatRaw ?? "auto";
  if (values.stdin !== true) return usageError("--stdin is required", t0, format);
  if (denyExitRaw !== undefined && !["0", "2"].includes(denyExitRaw))
    return usageError("--deny-exit must be 0 or 2", t0, format);
  const levelRaw = values["log-level"] ?? "warn";
  const logLevel: GateLogLevel = (GATE_LOG_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as GateLogLevel)
    : "warn";
  const read = io.read ?? (await readStdin(io.stdin ?? process.stdin));
  const opts: GateOptions = { logLevel, format };
  if (denyExitRaw !== undefined) opts.denyExit = denyExitRaw === "2" ? 2 : 0;
  if (values.root !== undefined) opts.root = values.root;
  if (values.profile !== undefined) opts.profilePath = values.profile;
  if (values.strict === true) opts.strict = true;
  if (values["fail-open"] === true) opts.failOpen = true;
  if (values["no-shell-scan"] === true) opts.noShellScan = true;
  if (values["no-root-discovery"] === true) opts.noRootDiscovery = true;
  if (values["track-reads"] === true) opts.trackReads = true;
  // DX-18: a probe (doctor, try, a harness self-test) must not append to the decision journal.
  // Contract §6 says the caller passes `dryRun`; this is the flag that does it.
  if (values["dry-run"] === true) opts.dryRun = true;
  if (io.cwdFallback !== undefined) opts.cwdFallback = io.cwdFallback;
  if (io.home !== undefined) opts.home = io.home;
  if (read.bytes !== undefined) opts.stdinBytes = read.bytes;
  if (read.tooLarge) {
    // An oversize payload IS an agent action (a huge write): never fail open on it unless the
    // operator asked for --fail-open.
    const r = await runGate(undefined, { ...opts, stdinTooLarge: true });
    r.stderr.unshift(`AXIOM GATE WARN: stdin exceeded ${GATE_STDIN_MAX_BYTES} bytes`);
    return r;
  }
  return runGate(read.text, opts);
}
