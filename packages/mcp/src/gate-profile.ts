/** Gate policy schema, built-in default and the file loaders (moved out of gate.ts in 4.0). */
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { isAxiomError } from "@codai/axiom-schema";
import { z } from "zod";
import { CommandsConfigSchema } from "./command-rules.js";
import { CoordinationSchema } from "./coord.js";
import { gitCommonDir, samePath } from "./gate-roots.js";
import { GitRulesSchema } from "./gitfacts.js";
import { loadAxiomConfig } from "./profile-v3.js";
import { SessionsConfigSchema } from "./session-guard.js";

// ---------------------------------------------------------------- profile --

export const GateProfileSchema = z
  .object({
    /**
     * Profile format major (3.0, D-42). Absent = written for 2.x. A profile declaring a major
     * newer than this binary is refused (`ERR_PROFILE_VERSION`) instead of half-understood.
     */
    version: z.int().positive().optional(),
    /** picomatch globs (dot: true) — any match denies. */
    deny: z.array(z.string().min(1)).default([]),
    /**
     * picomatch globs (dot: true), same semantics as `deny`, but a match hands the decision to
     * the human (`path.ask` → `permissionDecision: "ask"` on auto/claude/copilot/vscode; a plain
     * deny on formats without an ask prompt — fail-closed). Applies to write tools and to shell
     * operands alike. Every deny wins: `deny`, `allow`, content checks (`noSecrets`, `maxBytes`),
     * `steer: "require"` and session rules are judged first.
     */
    ask: z.array(z.string().min(1)).default([]),
    /** When present, every target must match at least one glob. */
    allow: z.array(z.string().min(1)).optional(),
    /** Run `content.noSecrets` on the new content when the payload carries it. */
    noSecrets: z.boolean().default(true),
    /** Also scan for PII (`cnp`, `email`, `phoneRo`, `card`) — `content.noSecrets { pii }`. */
    pii: z.boolean().default(false),
    /**
     * Globs where the PII-class `content.noSecrets` findings (email, phone, CNP, card,
     * credentialAssignment) are ignored — test fixtures and scratch dirs (3.0, S-1313).
     * Real keys (privateKey, awsKey, tokens) are still reported everywhere.
     */
    noSecretsExclude: z.array(z.string().min(1)).optional(),
    /** Run `content.maxBytes` on the new content when the payload carries it. */
    maxBytes: z.int().positive().optional(),
    /**
     * Steer agents towards `axiom_write` (Phase 8): `hint` adds a once-per-session context hint
     * to allowed writes; `require` also denies direct writes matching `steerGlobs`.
     */
    steer: z.enum(["off", "hint", "require"]).default("off"),
    /** picomatch globs (dot: true) a direct write must not touch under `steer: "require"`. */
    steerGlobs: z.array(z.string().min(1)).default([]),
    /** Append every judged write/shell decision to `.axiom/decisions.jsonl`. */
    record: z.boolean().default(false),
    /** Command rules for shell tools (S-1208): own `deny` list + optional built-in `house` pack. */
    commands: CommandsConfigSchema.optional(),
    /** Cross-session overwrite / blind overwrite / stale-script rules (S-1209, S-1215). */
    sessions: SessionsConfigSchema.optional(),
    /** Capture the pre-image of every allowed write into CAS for `axiom undo --session` (S-1210). */
    undo: z.boolean().default(false),
    /** File-protocol coordination: marks, leases, queue-required commands (S-1212). */
    coordination: CoordinationSchema.optional(),
    /** Git-state rules read from `.git` without spawning git (S-1213). */
    git: GitRulesSchema.optional(),
    /**
     * Shadow mode (S-1216): never deny; record what the gate WOULD have decided (and the shell
     * command text) into `.axiom/decisions.jsonl` for a parity replay before a cutover.
     */
    shadow: z.boolean().default(false),
    /**
     * `warn` (2.7): a deny becomes an allow carrying the reason as a warning to the agent (and a
     * journal line with `relaxed: "warn"`). Codes in `hard` keep denying; profile `ask` globs
     * keep asking. Default `enforce`.
     */
    mode: z.enum(["enforce", "warn"]).default("enforce"),
    /** Codes that always deny, in every mode, and cannot be overridden: exact or `prefix.*`. */
    hard: z.array(z.string().min(1)).default([]),
    /**
     * Let the agent pass a non-hard deny by stating why: `axiom-override: <reason>` (≥ 8 chars)
     * in the tool's explanation / goal / description / reason / command text. Journaled as
     * `relaxed: "override"` with the reason. Default off.
     */
    override: z.boolean().default(false),
    /**
     * Targets outside the root (and outside every worktree of the same repository): `deny`
     * (ERR_CONTAINMENT, default), `warn` (allow + warning), `allow` (allow; a warning only for
     * operating-system directories).
     */
    outside: z.enum(["deny", "warn", "allow"]).default("deny"),
    // ---- 4.0 contract keys (names frozen; D-54). Absent = the documented default. ----------
    /** Decision journal: retention of rotated months, in days (default 90). */
    journal: z.strictObject({ retentionDays: z.int().positive().optional() }).optional(),
    /**
     * Override governance (replaces the bare `override: true` meaning "any reason passes"):
     * `bindCode` = the override must name the rule it lifts (`axiom-override(<code>): reason`);
     * budgets are counted per session and per rolling hour; `allowOnce` enables one-time codes
     * typed by the human (`axiom allow-once`). Only read when `override` is true.
     */
    overrides: z
      .strictObject({
        bindCode: z.boolean().optional(),
        perSession: z.int().min(0).optional(),
        perHour: z.int().min(0).optional(),
        allowOnce: z.boolean().optional(),
      })
      .optional(),
    /** Lowest axiom version that may judge with this policy (older bin → `ERR_PROFILE_VERSION`). */
    minAxiomVersion: z.string().min(1).optional(),
    /** Keys a lower layer (user < org, repo < user) may not weaken; meaningful in org/user layers. */
    locked: z.array(z.string().min(1)).optional(),
  })
  // Unknown keys are ignored with a warning (3.0, D-42): a newer profile read by an older bin
  // must neither deny every write nor (with --fail-open) switch the gate off.
  .strip();

/** Highest profile `version` this binary understands. */
export const GATE_PROFILE_VERSION = 3;

/** A gate profile that cannot be used: never covered by `--fail-open` (S-1307). */
export class GateProfileError extends Error {
  readonly code: "ERR_INVALID_PROFILE" | "ERR_PROFILE_VERSION";
  constructor(code: "ERR_INVALID_PROFILE" | "ERR_PROFILE_VERSION", message: string) {
    super(message);
    this.name = "GateProfileError";
    this.code = code;
  }
}

export const GATE_PROFILE_KEYS: ReadonlySet<string> = new Set(Object.keys(GateProfileSchema.shape));

/** Top-level keys of a raw profile this binary does not know (reported, then ignored). */
export function unknownGateProfileKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw).filter((k) => !GATE_PROFILE_KEYS.has(k) && k !== "$schema");
}

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
  ask: [],
  noSecrets: true,
  pii: false,
  // Phase 8 decision: the builtin profile hints; an explicit profile file defaults to "off".
  steer: "hint",
  steerGlobs: [],
  record: false,
  undo: false,
  shadow: false,
  mode: "enforce",
  hard: [],
  override: false,
  outside: "deny",
};

/** `--profile`, then `<root>/.axiom/gate-profile.json`, then `~/.axiom/gate-profile.json`, then default. */
export async function loadGateProfile(opts: {
  root: string;
  profilePath?: string;
  home?: string;
}): Promise<{ profile: GateProfile; source: string; unknownKeys?: string[] }> {
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
          throw new GateProfileError("ERR_INVALID_PROFILE", `gate profile not found: ${file}`);
        continue;
      }
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new GateProfileError(
        "ERR_INVALID_PROFILE",
        `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it or run 'axiom init --force'`,
      );
    }
    const declared =
      raw !== null && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
    if (typeof declared === "number" && declared > GATE_PROFILE_VERSION) {
      throw new GateProfileError(
        "ERR_PROFILE_VERSION",
        `${file}: profile version ${declared} is newer than this axiom (understands ≤ ${GATE_PROFILE_VERSION}); upgrade the axiom bin`,
      );
    }
    const parsed = GateProfileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GateProfileError(
        "ERR_INVALID_PROFILE",
        `invalid gate profile ${file}: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const unknownKeys = unknownGateProfileKeys(raw);
    return {
      profile: parsed.data,
      source: file,
      ...(unknownKeys.length === 0 ? {} : { unknownKeys }),
    };
  }
  return { profile: DEFAULT_GATE_PROFILE, source: "builtin" };
}

export function errno(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export async function mtimeMs(file: string): Promise<number | undefined> {
  try {
    return (await lstat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The gate profile for `root` (3.0, I-2). A linked worktree (agent slot) whose own
 * `.axiom/gate-profile.json` is missing or OLDER than the main clone's inherits the main
 * clone's profile, so a policy change reaches every slot without copying files. `--profile`
 * always wins; a slot with a newer profile of its own keeps it.
 */
export async function loadGateProfileForRoot(
  root: string,
  opts: { profilePath?: string; home?: string } = {},
): Promise<{ profile: GateProfile; source: string; unknownKeys?: string[] }> {
  const base = {
    ...(opts.profilePath === undefined ? {} : { profilePath: opts.profilePath }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
  };
  if (opts.profilePath === undefined) {
    // 3.0 (D-42): `.axiom/axiom.json` wins over the legacy gate-profile.json.
    const v3 = await loadAxiomConfigAsGate(root, opts.home);
    if (v3 !== undefined) return v3;
    const common = await gitCommonDir(root);
    if (common !== undefined && path.basename(common).toLowerCase() === ".git") {
      const mainRoot = path.dirname(common);
      if (!samePath(mainRoot, root)) {
        const own = await mtimeMs(path.join(root, ".axiom", "gate-profile.json"));
        const inherited = await mtimeMs(path.join(mainRoot, ".axiom", "gate-profile.json"));
        if (inherited !== undefined && (own === undefined || own < inherited)) {
          return loadGateProfile({ root: mainRoot, ...base });
        }
      }
    }
  }
  return loadGateProfile({ root, ...base });
}

/** The `gate` section of `<root>/.axiom/axiom.json` (extends resolved), or undefined. */
export async function loadAxiomConfigAsGate(
  root: string,
  home?: string,
): Promise<{ profile: GateProfile; source: string; unknownKeys?: string[] } | undefined> {
  let cfg: Awaited<ReturnType<typeof loadAxiomConfig>>;
  try {
    cfg = await loadAxiomConfig(root, home === undefined ? {} : { home });
  } catch (err) {
    const code = isAxiomError(err) ? err.code : undefined;
    throw new GateProfileError(
      code === "ERR_PROFILE_VERSION" ? "ERR_PROFILE_VERSION" : "ERR_INVALID_PROFILE",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (cfg === undefined) return undefined;
  const raw = cfg.gate ?? {};
  const parsed = GateProfileSchema.safeParse(raw);
  const source = cfg.sources.at(-1) ?? path.join(root, ".axiom", "axiom.json");
  if (!parsed.success) {
    throw new GateProfileError(
      "ERR_INVALID_PROFILE",
      `invalid gate section in ${source}: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const unknownKeys = [...unknownGateProfileKeys(raw), ...cfg.warnings.map((w) => `(${w})`)];
  return {
    profile: parsed.data,
    source,
    ...(unknownKeys.length === 0 ? {} : { unknownKeys }),
  };
}
