import type { Finding, Severity } from "@codai/axiom-schema";
import { AxiomError } from "@codai/axiom-schema";
import picomatch from "picomatch";
import { z } from "zod";
import { CASE_INSENSITIVE_FS } from "../facts/contained.js";
import type { PredicateId } from "../types.js";

export type Matcher = (path: string) => boolean;

/**
 * Next.js route groups `(app)` / `(marketing)` are literal directory names, but to
 * picomatch an unescaped `(...)` is an extglob/regex group, so `app/(app)/x.tsx` would
 * never match `app/(app)/**`. S-408: escape a parenthesised segment when it contains
 * no glob metacharacters and is not a real extglob (`@(`, `!(`, `?(`, `*(`, `+(`, `|`).
 * Explicitly escaped `\(` is left alone.
 */
export function escapeRouteGroups(glob: string): string {
  return glob.replace(/(^|[^\\@!?*+])\(([^()|*?[\]{}\\]+)\)/g, (_m, pre: string, inner: string) => {
    return `${pre}\\(${inner}\\)`;
  });
}

export interface GlobMatcherOptions {
  /**
   * Case-insensitive matching. Defaults to `true` on win32/darwin, whose default filesystems
   * are case-insensitive: there `.ENV` IS `.env`, so a `.env` deny glob must catch it.
   */
  nocase?: boolean;
  /** Platform whose filesystem default applies when `nocase` is absent (default: this one). */
  platform?: NodeJS.Platform;
}

/** win32 and darwin default filesystems are case-insensitive. */
export function caseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Default `nocase` for path globs on this platform. */
export const DEFAULT_GLOB_NOCASE: boolean = CASE_INSENSITIVE_FS;

/**
 * Caps that keep a plan-supplied glob from hanging the process (A1-4). picomatch compiles a
 * glob to a regex; a pattern with many `*` separated by literals (`*a*a*a*a*a*b`) backtracks
 * catastrophically — 6 wildcard groups took 1.4 s on a 64-character path, 7 took 12.8 s and
 * 8 never returned. Every glob therefore has a bounded length and a bounded number of wildcard
 * groups, and a plan-level `!` (negation) is refused outright (A1-21: `["src/**","!src/secret/**"]`
 * in `path.allow` admitted everything else).
 */
export const GLOB_MAX_CHARS = 512;
export const GLOB_MAX_WILDCARD_RUNS = 5;

/** Why a glob is refused; empty for an acceptable pattern. */
export function globIssues(glob: string): string[] {
  const out: string[] = [];
  if (glob.startsWith("!")) {
    out.push('must not start with "!" (negated globs are not supported)');
  }
  if (glob.length > GLOB_MAX_CHARS) {
    out.push(`is ${glob.length} characters, at most ${GLOB_MAX_CHARS}`);
  }
  const runs = glob.match(/[*?]+/g)?.length ?? 0;
  if (runs > GLOB_MAX_WILDCARD_RUNS) {
    out.push(`has ${runs} wildcard groups, at most ${GLOB_MAX_WILDCARD_RUNS}`);
  }
  return out;
}

/** A single glob parameter: non-empty, no negation, bounded length and wildcard count. */
export const GlobPatternSchema = z
  .string()
  .min(1)
  .superRefine((g, ctx) => {
    for (const issue of globIssues(g))
      ctx.addIssue({ code: "custom", message: `glob "${g}" ${issue}` });
  });

/** A list of glob parameters (`.min(1)` is added by the predicates that need it). */
export const GlobListSchema = z.array(GlobPatternSchema);

/**
 * Path-glob matcher used by every path predicate (`dot: true`, Next route groups literal).
 * Empty / absent `globs` → constant `whenEmpty`. A glob that fails {@link globIssues} throws
 * `ERR_PREDICATE_PARAMS` (the runner records it as a provider failure, never a pass).
 */
export function globMatcher(
  globs: readonly string[] | undefined,
  whenEmpty: boolean,
  opts: GlobMatcherOptions = {},
): Matcher {
  if (globs === undefined || globs.length === 0) return () => whenEmpty;
  for (const g of globs) {
    const issues = globIssues(g);
    if (issues.length > 0) {
      throw new AxiomError("ERR_PREDICATE_PARAMS", `unsafe glob "${g}": ${issues.join("; ")}`, {
        details: { glob: g, issues },
      });
    }
  }
  const m = picomatch(globs.map(escapeRouteGroups), {
    dot: true,
    nocase:
      opts.nocase ??
      (opts.platform === undefined ? DEFAULT_GLOB_NOCASE : caseInsensitivePlatform(opts.platform)),
  });
  return (p) => m(p);
}

export interface FindingInput {
  id: string;
  predicate: PredicateId;
  message: string;
  path?: string;
  severity?: Severity;
  facts?: Record<string, unknown>;
}

/**
 * Predicates emit findings with the severity they judge appropriate; the runner
 * re-labels them with the CheckRef severity unless the finding is `error` from a
 * provider failure. Default here is `error`.
 */
export function finding(f: FindingInput): Finding {
  const out: Finding = {
    id: f.id,
    severity: f.severity ?? "error",
    predicate: f.predicate,
    message: f.message,
    facts: (f.facts ?? {}) as Finding["facts"],
  };
  if (f.path !== undefined) out.path = f.path;
  return out;
}

/**
 * A1-9: an artifact a content predicate must read whose bytes are not available (no inline
 * blob, no CAS entry) is a provider failure, never a silent pass. `__provider` makes the
 * runner report it as a provider error, so the verdict is `error` (invariant 7).
 */
export function unreadableContent(predicate: PredicateId, path: string): Finding {
  return finding({
    id: `${predicate}.unreadable`,
    predicate,
    path,
    message: "artifact content is not available to this check (no inline blob and no CAS entry)",
    facts: { code: "ERR_BLOB_MISSING", __provider: true },
  });
}

export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
