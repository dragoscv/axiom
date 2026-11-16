/**
 * ONE policy resolver for every consumer of the repository policy (4.0, D-50 / S-1407).
 *
 * Reality check #2 found that the gate, the post hook, `doctor`, `stats`, `explain`, `fleet`
 * and `check`/`apply` each read a different subset of `.axiom/axiom.json`, `.axiom/gate-profile.json`
 * and `.axiom/profiles/*.json`, so a repo could be judged by one file and reported on by another
 * (an `axiom.json` without a `gate` section switched the gate off while doctor stayed green).
 *
 * Contract (every module reads the policy through this file, nothing else re-implements it):
 *   - `resolvePolicy(root, opts)` → the effective gate policy, the raw merged `checks` section,
 *     every source layer in merge order, and a digest of the effective policy
 *     (`policyDigest`, journaled and attested so "which policy decided" is a fact, not a path).
 *   - An `axiom.json` WITHOUT a `gate` key (or with `gate: {}`) never yields an empty gate policy:
 *     the gate section falls through to `.axiom/gate-profile.json`, then to the built-in default
 *     (never "allow all").
 *   - A linked worktree inherits the main clone's policy as a FLOOR; a nested root takes its
 *     nearest ancestor repository's policy as a FLOOR. Both read the ancestor's file CONTENT -
 *     mtime is never consulted (A2-12).
 *   - Layers, weakest first: (inherited floor) < repo < user (`~/.axiom/...`) < org
 *     (`AXIOM_ORG_POLICY`, or the platform's system path). The merge is STRICTER-WINS, so no layer
 *     can weaken another: `deny`/`ask`/`hard` union, `allow` and `noSecretsExclude` intersect,
 *     `mode enforce` beats `warn`, `outside deny > warn > allow`, `override` false beats true,
 *     `maxBytes` min, and so on (`GATE_SPEC` is the table).
 *   - A key NO layer names takes its schema default - except `deny`, which falls back to
 *     `DEFAULT_GATE_PROFILE.deny` so a `gate` section without a deny list can never switch the
 *     gate off (A2-1). Only when NO layer names a gate at all is `DEFAULT_GATE_PROFILE` the whole
 *     policy (its `steer: "hint"` included). `--profile <file>` is applied STRICTLY on top of that
 *     effective policy, so it may only tighten.
 *   - `locked` freezes keys: a layer's `locked` list is honoured against every WEAKER layer.
 *   - Unknown keys at ANY depth, and unknown enum values, are stripped with a warning; an unknown
 *     enum value takes the stricter reading (`mode: "banana"` -> `enforce`).
 *   - `minAxiomVersion` above the running bin -> `ERR_PROFILE_VERSION` (never covered by
 *     `--fail-open`), like a policy `version` newer than the binary.
 *   - Legacy files (`.axiom/gate-profile.json`, `~/.axiom/gate-profile.json`) keep working and
 *     produce exactly ONE deprecation warning per resolution.
 *
 * Fail-closed: every error here is a `GateProfileError` (`ERR_INVALID_PROFILE` /
 * `ERR_PROFILE_VERSION`) - the gate denies and never silently falls back to the built-in default.
 */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { canonicalize } from "@codai/axiom-canon";
import { AXIOM_CONFIG_PATH, isAxiomError } from "@codai/axiom-schema";
import {
  DEFAULT_GATE_PROFILE,
  GATE_PROFILE_VERSION,
  type GateProfile,
  GateProfileError,
  GateProfileSchema,
  readGateProfileDoc,
} from "./gate-profile.js";
import { AXIOM_REPO_MARKERS, gitCommonDir, samePath } from "./gate-roots.js";
import {
  type AxiomConfig,
  loadAxiomConfig,
  loadAxiomConfigFile,
  mergeConfig,
  readPolicyJson,
} from "./profile-v3.js";
import { PACKAGE_VERSION } from "./version.js";

export interface ResolvedPolicy {
  /** Effective gate policy (schema defaults applied). */
  gate: GateProfile;
  /** Raw merged `checks` section of `axiom.json`, or `undefined` when no v3 file exists. Pass as `loadProfile(name, { config })`. */
  checks: unknown;
  /** Source that decided the gate section (file path, `axiom:<pack>` or `npm:<pkg>`). */
  source: string;
  /** Every layer read, in merge order (weakest first; the repo file is last within the repo layer). */
  sources: string[];
  /** Warnings produced while resolving (unknown keys, deprecations, locked keys). */
  warnings: string[];
  /** `sha256:<hex>` over the JCS form of the effective policy (gate + checks). */
  policyDigest: string;
}

export interface ResolvePolicyOptions {
  /** Extra layer that may only tighten (`axiom gate --profile <file>`); accepts the flat 2.x shape. */
  profilePath?: string;
  /** Test seam for `~/.axiom` (default `os.homedir()`). */
  home?: string;
}

/** `sha256:<hex>` of the JCS form of `value`. */
export function policyDigestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

// ------------------------------------------------------------------ gate shape --

type Kind = "bool" | "int" | "version" | "str" | "strs" | "enum" | "obj" | "rules";

interface Spec {
  kind: Kind;
  /** Arrays: `union` = more is stricter, `intersect` = fewer is stricter. */
  array?: "union" | "intersect";
  /** `bool`: true = true is the stricter reading; false = false is (a relaxation switch). */
  trueStrict?: boolean;
  /** `int`: which bound is the stricter one. */
  intStrict?: "min" | "max";
  /** `enum` members, weakest first; the last one is the stricter reading. */
  values?: readonly string[];
  /** `obj`/`rules`: the known keys of a member. */
  fields?: Readonly<Record<string, Spec>>;
}

/** Keys of one command rule (`CommandRuleSchema`); unknown keys are stripped like any other. */
const RULE_KEYS: Readonly<Record<string, Spec>> = {
  id: { kind: "str" },
  pattern: { kind: "str" },
  argv: { kind: "strs", array: "union" },
  unless: { kind: "str" },
  reason: { kind: "str" },
  fix: { kind: "str" },
  decision: { kind: "enum", values: ["ask", "deny"] },
  caseSensitive: { kind: "bool", trueStrict: true },
  // 4.0 (contract 4): advice that never blocks, shown once per (root, session, rule). Without
  // these two entries the resolver stripped them and a user rule could never be advisory. Both
  // LOOSEN a rule, so the stricter merge reading is `false` (same as `override` / `shadow`).
  advisory: { kind: "bool", trueStrict: false },
  oncePerSession: { kind: "bool", trueStrict: false },
};

/** Keys of one `coordination.queueRequired` entry. */
const QUEUE_KEYS: Readonly<Record<string, Spec>> = {
  class: { kind: "str" },
  via: { kind: "str" },
  fix: { kind: "str" },
};

/**
 * The strictness table of every gate key. It drives BOTH the sanitisation (unknown keys and
 * unknown enum values) and the merge, so the two can never drift apart.
 */
const GATE_SPEC: Readonly<Record<string, Spec>> = {
  deny: { kind: "strs", array: "union" },
  ask: { kind: "strs", array: "union" },
  allow: { kind: "strs", array: "intersect" },
  noSecrets: { kind: "bool", trueStrict: true },
  pii: { kind: "bool", trueStrict: true },
  noSecretsExclude: { kind: "strs", array: "intersect" },
  maxBytes: { kind: "int", intStrict: "min" },
  steer: { kind: "enum", values: ["off", "hint", "require"] },
  steerGlobs: { kind: "strs", array: "union" },
  record: { kind: "bool", trueStrict: true },
  commands: {
    kind: "obj",
    fields: {
      deny: { kind: "rules", fields: RULE_KEYS },
      pack: { kind: "enum", values: ["none", "core", "shared-clone", "house"] },
      packs: { kind: "strs", array: "union" },
    },
  },
  sessions: {
    kind: "obj",
    fields: {
      foreignWrite: { kind: "enum", values: ["off", "ask", "deny"] },
      windowMin: { kind: "int", intStrict: "max" },
      blindOverwrite: { kind: "enum", values: ["off", "ask", "deny"] },
      trackReads: { kind: "bool", trueStrict: true },
      staleScript: { kind: "bool", trueStrict: true },
      budget: {
        kind: "obj",
        fields: {
          maxFiles: { kind: "int", intStrict: "min" },
          maxDeletes: { kind: "int", intStrict: "min" },
          windowMin: { kind: "int", intStrict: "max" },
          decision: { kind: "enum", values: ["ask", "deny"] },
        },
      },
    },
  },
  undo: { kind: "bool", trueStrict: true },
  coordination: {
    kind: "obj",
    fields: {
      marksDir: { kind: "str" },
      leasesDir: { kind: "str" },
      slotsRoot: { kind: "str" },
      exemptVia: { kind: "strs", array: "union" },
      queueRequired: { kind: "rules", fields: QUEUE_KEYS },
      repo: { kind: "str" },
    },
  },
  git: {
    kind: "obj",
    fields: {
      cleanTreeFor: { kind: "strs", array: "union" },
      untracked: { kind: "bool", trueStrict: true },
      requirePathspec: { kind: "bool", trueStrict: true },
      branch: {
        kind: "obj",
        fields: {
          is: { kind: "str" },
          for: { kind: "strs", array: "union" },
          reason: { kind: "str" },
        },
      },
    },
  },
  shadow: { kind: "bool", trueStrict: false },
  mode: { kind: "enum", values: ["warn", "enforce"] },
  hard: { kind: "strs", array: "union" },
  override: { kind: "bool", trueStrict: false },
  outside: { kind: "enum", values: ["allow", "warn", "deny"] },
  journal: { kind: "obj", fields: { retentionDays: { kind: "int", intStrict: "max" } } },
  overrides: {
    kind: "obj",
    fields: {
      bindCode: { kind: "bool", trueStrict: true },
      perSession: { kind: "int", intStrict: "min" },
      perHour: { kind: "int", intStrict: "min" },
      allowOnce: { kind: "bool", trueStrict: false },
    },
  },
  minAxiomVersion: { kind: "version" },
  locked: { kind: "strs", array: "union" },
};

// ------------------------------------------------------------------ helpers --

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function describeValue(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** `"3.2.1"` -> `[3,2,1]`; unparsable -> zeros. Local, so the gate hot path never pulls `init.ts` in. */
function versionPart(v: string): number[] {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? ["0", "0", "0"]).map(Number);
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [versionPart(a), versionPart(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

/** Any policy error becomes a `GateProfileError`, which the gate denies and `--fail-open` never covers. */
function asProfileError(err: unknown): GateProfileError {
  if (err instanceof GateProfileError) return err;
  const code =
    isAxiomError(err) && err.code === "ERR_PROFILE_VERSION"
      ? "ERR_PROFILE_VERSION"
      : "ERR_INVALID_PROFILE";
  return new GateProfileError(code, err instanceof Error ? err.message : String(err));
}

// ------------------------------------------------------------ sanitise + merge --

/**
 * Strip unknown keys at any depth and take the stricter reading of an unknown enum value.
 * Returns `undefined` when nothing usable is left, so an empty `gate` never becomes a layer.
 */
function sanitize(value: unknown, spec: Spec, at: string, warnings: string[]): unknown {
  switch (spec.kind) {
    case "bool": {
      if (typeof value === "boolean") return value;
      const strict = spec.trueStrict !== false;
      warnings.push(
        `${at}: expected a boolean, got ${describeValue(value)}; reading it as ${strict}`,
      );
      return strict;
    }
    case "int": {
      if (typeof value === "number" && Number.isInteger(value)) return value;
      warnings.push(`${at}: expected an integer, got ${describeValue(value)}; ignoring it`);
      return undefined;
    }
    case "version":
    case "str": {
      if (typeof value === "string" && value.length > 0) return value;
      warnings.push(`${at}: expected a non-empty string, got ${describeValue(value)}; ignoring it`);
      return undefined;
    }
    case "strs": {
      if (!Array.isArray(value)) {
        warnings.push(
          `${at}: expected an array of strings, got ${describeValue(value)}; ignoring it`,
        );
        return undefined;
      }
      const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (out.length !== value.length) {
        warnings.push(`${at}: dropped ${value.length - out.length} non-string entry(ies)`);
      }
      return dedupe(out);
    }
    case "enum": {
      const values = spec.values ?? [];
      if (typeof value === "string" && values.includes(value)) return value;
      const strict = values.at(-1);
      warnings.push(
        `${at}: unknown value ${describeValue(value)}; taking the stricter reading ${describeValue(strict)}`,
      );
      return strict;
    }
    case "obj": {
      if (!isObject(value)) {
        warnings.push(`${at}: expected an object, got ${describeValue(value)}; ignoring it`);
        return undefined;
      }
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) {
        const child = spec.fields?.[k];
        if (child === undefined) {
          warnings.push(`ignoring unknown key "${at}.${k}" (written for a newer axiom?)`);
          continue;
        }
        const s = sanitize(v, child, `${at}.${k}`, warnings);
        if (s !== undefined) out[k] = s;
      }
      return out;
    }
    case "rules": {
      if (!Array.isArray(value)) {
        warnings.push(`${at}: expected an array, got ${describeValue(value)}; ignoring it`);
        return undefined;
      }
      const out: unknown[] = [];
      const spec0: Spec =
        spec.fields === undefined ? { kind: "obj" } : { kind: "obj", fields: spec.fields };
      value.forEach((entry, i) => {
        const s = sanitize(entry, spec0, `${at}[${i}]`, warnings);
        if (s !== undefined) out.push(s);
      });
      return out.length === 0 ? undefined : out;
    }
  }
}

/** Sanitise a raw `gate` object. `undefined` when the layer names no usable gate key. */
function sanitizeGate(raw: unknown, where: string, warnings: string[]): Json | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    warnings.push(`${where}: the gate section is not an object; ignoring it`);
    return undefined;
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(raw)) {
    // `version` and `$schema` are file metadata, not policy: they never take part in a merge.
    if (k === "version" || k === "$schema") continue;
    const spec = GATE_SPEC[k];
    if (spec === undefined) {
      warnings.push(`ignoring unknown key "gate.${k}" in ${where} (written for a newer axiom?)`);
      continue;
    }
    const s = sanitize(v, spec, `gate.${k}`, warnings);
    if (s !== undefined) out[k] = s;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Strictest-wins merge of two already-sanitised values of one spec node. */
function mergeValue(spec: Spec, base: unknown, over: unknown): unknown {
  if (base === undefined) return over;
  if (over === undefined) return base;
  switch (spec.kind) {
    case "bool": {
      const b = base as boolean;
      const o = over as boolean;
      return spec.trueStrict === false ? b && o : b || o;
    }
    case "int": {
      const b = base as number;
      const o = over as number;
      return spec.intStrict === "max" ? Math.max(b, o) : Math.min(b, o);
    }
    case "version": {
      const b = base as string;
      const o = over as string;
      return compareVersions(o, b) >= 0 ? o : b;
    }
    case "str":
      return over;
    case "enum": {
      const values = spec.values ?? [];
      const i = values.indexOf(base as string);
      const j = values.indexOf(over as string);
      return j >= i ? over : base;
    }
    case "strs": {
      const b = base as string[];
      const o = over as string[];
      if (spec.array === "intersect") return b.filter((v) => o.includes(v));
      return dedupe([...b, ...o]);
    }
    case "rules": {
      const b = base as unknown[];
      const o = over as unknown[];
      const out = [...b];
      const seen = new Set(b.map((v) => JSON.stringify(v)));
      for (const v of o) {
        const k = JSON.stringify(v);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(v);
        }
      }
      return out;
    }
    case "obj": {
      const b = base as Json;
      const o = over as Json;
      const out: Json = { ...b };
      for (const [k, v] of Object.entries(o)) {
        const child = spec.fields?.[k];
        const merged = child === undefined ? v : mergeValue(child, b[k], v);
        if (merged !== undefined) out[k] = merged;
      }
      return out;
    }
  }
}

// ------------------------------------------------------------------ layers --

interface Layer {
  label: string;
  gate?: Json;
  checks?: unknown;
}

async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    const st = await lstat(path.join(dir, ".git"));
    if (st.isDirectory() || st.isFile()) return true;
  } catch {
    /* keep looking */
  }
  try {
    const ax = path.join(dir, ".axiom");
    if ((await lstat(ax)).isDirectory()) {
      for (const m of AXIOM_REPO_MARKERS) {
        try {
          await lstat(path.join(ax, m));
          return true;
        } catch {
          /* next marker */
        }
      }
    }
  } catch {
    /* keep looking */
  }
  return false;
}

/** Nearest ancestor of `dir` (strictly above it, below `home`) that is a repository root. */
async function nearestAncestorRoot(dir: string, home: string): Promise<string | undefined> {
  let cur = path.dirname(dir);
  for (let depth = 0; depth < 64; depth++) {
    if (samePath(cur, home)) return undefined;
    if (await isRepoRoot(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

async function repoConfig(dir: string, home: string): Promise<AxiomConfig | undefined> {
  try {
    return await loadAxiomConfig(dir, { home });
  } catch (err) {
    throw asProfileError(err);
  }
}

function configLabel(cfg: AxiomConfig, dir: string): string {
  return cfg.sources.at(-1) ?? path.join(dir, ...AXIOM_CONFIG_PATH.split("/"));
}

/** The repo-level gate of ANY directory: `.axiom/axiom.json`, else `.axiom/gate-profile.json`. */
async function repoGateLayer(
  dir: string,
  home: string,
  warnings: string[],
): Promise<Layer | undefined> {
  const cfg = await repoConfig(dir, home);
  if (cfg !== undefined) {
    warnings.push(...cfg.warnings);
    const label = configLabel(cfg, dir);
    const gate = sanitizeGate(cfg.gate, label, warnings);
    if (gate !== undefined) return { label, gate };
  }
  const legacy = path.join(dir, ".axiom", "gate-profile.json");
  const raw = await readGateProfileDoc(legacy, { optional: true });
  const gate = sanitizeGate(raw, legacy, warnings);
  return gate === undefined ? undefined : { label: legacy, gate };
}

/**
 * The FLOOR inherited by a nested root: a linked worktree takes the main clone's policy (content,
 * never mtime - A2-12), and a nested repository takes its nearest ancestor root's policy (A2-11).
 */
async function inheritedFloor(
  rootReal: string,
  home: string,
  warnings: string[],
): Promise<Layer | undefined> {
  const common = await gitCommonDir(rootReal);
  if (common !== undefined && path.basename(common).toLowerCase() === ".git") {
    const mainRoot = path.dirname(common);
    if (!samePath(mainRoot, rootReal)) {
      const layer = await repoGateLayer(mainRoot, home, warnings);
      if (layer !== undefined) return layer;
    }
  }
  const ancestor = await nearestAncestorRoot(rootReal, home);
  return ancestor === undefined ? undefined : repoGateLayer(ancestor, home, warnings);
}

/**
 * A policy file outside the repo tree (user, org, `--profile <file>`) in EITHER shape: the
 * `axiom.json` shape (with `extends`, `checks`) or the flat 2.x gate-profile shape (EN-7).
 */
async function externalLayer(
  file: string,
  opts: { root: string; home: string; required?: boolean },
  warnings: string[],
): Promise<Layer | undefined> {
  const fileReal = await realpathOrUndefined(file);
  if (fileReal === undefined) {
    if (opts.required === true) {
      throw new GateProfileError("ERR_INVALID_PROFILE", `gate profile not found: ${file}`);
    }
    return undefined;
  }
  let raw: unknown;
  try {
    raw = await readPolicyJson(fileReal);
  } catch (err) {
    throw asProfileError(err);
  }
  const v3 =
    isObject(raw) &&
    ("gate" in raw || "checks" in raw || "extends" in raw || "$schema" in raw || "version" in raw);
  if (v3) {
    let cfg: AxiomConfig | undefined;
    try {
      cfg = await loadAxiomConfigFile(fileReal, {
        root: opts.root,
        home: opts.home,
        containRoots: [path.dirname(fileReal)],
      });
    } catch (err) {
      throw asProfileError(err);
    }
    if (cfg === undefined) return undefined;
    warnings.push(...cfg.warnings);
    const label = configLabel(cfg, path.dirname(fileReal));
    const gate = sanitizeGate(cfg.gate, label, warnings);
    return { label, ...(gate === undefined ? {} : { gate }), checks: cfg.checks };
  }
  // Flat 2.x shape: the whole document IS the gate section.
  const declared = isObject(raw) ? raw.version : undefined;
  if (typeof declared === "number" && declared > GATE_PROFILE_VERSION) {
    throw new GateProfileError(
      "ERR_PROFILE_VERSION",
      `${fileReal}: profile version ${declared} is newer than this axiom (understands <= ${GATE_PROFILE_VERSION}); upgrade the axiom bin`,
    );
  }
  const gate = sanitizeGate(raw, fileReal, warnings);
  return gate === undefined ? undefined : { label: fileReal, gate };
}

/** The ORG layer: `AXIOM_ORG_POLICY` when set, else the platform's system-wide policy file. */
function orgPolicyPath(): string | undefined {
  const env = process.env.AXIOM_ORG_POLICY;
  if (env !== undefined && env.trim().length > 0) return path.resolve(env.trim());
  return process.platform === "win32"
    ? path.join(process.env.ProgramData ?? "C:\\ProgramData", "axiom", "axiom.json")
    : path.join(path.sep, "etc", "axiom", "axiom.json");
}

function mergeInto(current: unknown, next: unknown): unknown {
  const a = emptyToUndefined(current);
  const b = emptyToUndefined(next);
  if (a === undefined) return b;
  return b === undefined ? a : mergeConfig(a, b);
}

/** An empty `checks` object means "this layer has no check profile", not an empty one. */
function emptyToUndefined(value: unknown): unknown {
  if (isObject(value) && Object.keys(value).length === 0) return undefined;
  return value;
}

function parseGate(raw: unknown, context: string): GateProfile {
  const parsed = GateProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GateProfileError(
      "ERR_INVALID_PROFILE",
      `invalid ${context}: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Schema defaults for every key no layer named, except `deny`: with no layer naming a deny list
 * the effective policy must still deny something (A2-1), so the built-in list stands in. An
 * explicit `deny: []` is honoured as written.
 */
function effectiveGate(named: Json): GateProfile {
  const gate = parseGate(named, "merged gate policy");
  if (!("deny" in named)) gate.deny = [...DEFAULT_GATE_PROFILE.deny];
  return gate;
}

// ------------------------------------------------------------------ resolver --

/**
 * Resolve the effective policy for `root`. Throws `GateProfileError` on an unusable layer
 * (invalid file, newer format version, un-met `minAxiomVersion`) - never a silent default.
 */
export async function resolvePolicy(
  root: string,
  opts: ResolvePolicyOptions = {},
): Promise<ResolvedPolicy> {
  const home = path.resolve(opts.home ?? homedir());
  const rootReal = (await realpathOrUndefined(root)) ?? path.resolve(root);
  const collected: string[] = [];
  const layers: Layer[] = [];
  const sources: string[] = [];
  const legacyUsed: string[] = [];
  let checks: unknown;
  let source = "builtin";
  /** Index in `layers` of the `--profile <file>` layer (it merges differently: see below). */
  let profileIndex = -1;
  const contribute = (layer: Layer, extraSources: readonly string[] = []): void => {
    layers.push(layer);
    sources.push(...extraSources);
    if (layer.gate !== undefined) source = layer.label;
    if (layer.checks !== undefined) checks = mergeInto(checks, layer.checks);
  };

  // 1. floor: the enclosing repository (worktree main clone, or the nearest ancestor root).
  const floor = await inheritedFloor(rootReal, home, collected);
  if (floor !== undefined) contribute(floor, [floor.label]);

  // 2. repository layer: `.axiom/axiom.json`; with no usable `gate` key, `.axiom/gate-profile.json`.
  const cfg = await repoConfig(rootReal, home);
  let repoGateFound = false;
  if (cfg !== undefined) {
    collected.push(...cfg.warnings);
    const label = configLabel(cfg, rootReal);
    const gate = sanitizeGate(cfg.gate, label, collected);
    if (gate !== undefined) {
      repoGateFound = true;
      contribute({ label, gate, checks: cfg.checks }, cfg.sources);
    } else {
      if (cfg.checks !== undefined) checks = mergeInto(checks, cfg.checks);
      sources.push(...cfg.sources);
    }
  }
  if (!repoGateFound) {
    const legacy = path.join(rootReal, ".axiom", "gate-profile.json");
    const raw = await readGateProfileDoc(legacy, { optional: true });
    const gate = sanitizeGate(raw, legacy, collected);
    if (gate !== undefined) {
      legacyUsed.push(legacy);
      contribute({ label: legacy, gate }, [legacy]);
    }
  }

  // 3. user layer: `~/.axiom/axiom.json` (4.0) on top of the legacy `~/.axiom/gate-profile.json`.
  const userLegacy = path.join(home, ".axiom", "gate-profile.json");
  const userLegacyGate = sanitizeGate(
    await readGateProfileDoc(userLegacy, { optional: true }),
    userLegacy,
    collected,
  );
  if (userLegacyGate !== undefined) {
    legacyUsed.push(userLegacy);
    contribute({ label: userLegacy, gate: userLegacyGate }, [userLegacy]);
  }
  // AXIOM_CONFIG_PATH already carries the `.axiom/` segment: never join it twice.
  const userFile = path.join(home, ...AXIOM_CONFIG_PATH.split("/"));
  const userLayer = await externalLayer(userFile, { root: home, home, required: false }, collected);
  if (userLayer !== undefined) contribute(userLayer, [userLayer.label]);

  // 4. org layer (the strongest file layer): `AXIOM_ORG_POLICY` or the platform's system path.
  const orgFile = orgPolicyPath();
  if (orgFile !== undefined) {
    const orgLayer = await externalLayer(orgFile, { root: rootReal, home }, collected);
    if (orgLayer !== undefined) contribute(orgLayer, [orgLayer.label]);
  }

  // 5. `--profile <file>`: an extra layer that may only tighten the repo policy.
  if (opts.profilePath !== undefined) {
    const profLayer = await externalLayer(
      path.resolve(opts.profilePath),
      { root: rootReal, home, required: true },
      collected,
    );
    if (profLayer !== undefined) {
      contribute(profLayer, [profLayer.label]);
      profileIndex = layers.length - 1;
    }
  }

  // `locked` freezes keys against every WEAKER layer, so walk from the strongest down.
  const lockedAbove = new Set<string>();
  const allowed: { index: number; gate: Json }[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer === undefined) continue;
    const gate: Json = {};
    for (const [k, v] of Object.entries(layer.gate ?? {})) {
      if (lockedAbove.has(k)) {
        collected.push(
          `in ${layer.label}: key "gate.${k}" is locked by a stronger policy layer; ignoring it`,
        );
        continue;
      }
      gate[k] = v;
    }
    allowed.push({ index: i, gate });
    for (const k of (layer.gate?.locked as string[] | undefined) ?? []) lockedAbove.add(k);
  }
  allowed.reverse();

  const objSpec: Spec = { kind: "obj", fields: GATE_SPEC };
  let named: Json = {};
  let profileNamed: Json | undefined;
  for (const item of allowed) {
    if (item.index === profileIndex) {
      profileNamed = item.gate;
      continue;
    }
    named = mergeValue(objSpec, named, item.gate) as Json;
  }

  const profileFilled = profileNamed !== undefined && Object.keys(profileNamed).length > 0;
  let gate: GateProfile;
  if (Object.keys(named).length === 0 && !profileFilled) {
    // No layer names a gate at all: the built-in default is the whole policy (A2-1's last leg).
    gate = structuredClone(DEFAULT_GATE_PROFILE);
  } else {
    // Otherwise the schema defaults apply to every key no layer named - EXCEPT `deny`, which
    // falls back to the built-in list when no layer names one (A2-1: a `gate` section without
    // `deny` must not switch the gate off). An EXPLICIT `deny: []` is honoured as written.
    const base = effectiveGate(named);
    // `--profile <file>` may only TIGHTEN (contract 1): it is merged strictly onto the effective
    // policy, so it can never relax the repo policy or the built-in default.
    gate =
      profileNamed === undefined
        ? base
        : parseGate(mergeValue(objSpec, base, profileNamed), "gate policy with --profile");
  }
  if (
    gate.minAxiomVersion !== undefined &&
    compareVersions(PACKAGE_VERSION, gate.minAxiomVersion) < 0
  ) {
    throw new GateProfileError(
      "ERR_PROFILE_VERSION",
      `the policy requires axiom >= ${gate.minAxiomVersion}, this is ${PACKAGE_VERSION}; upgrade the axiom bin`,
    );
  }

  const warnings = [...new Set(collected)];
  if (legacyUsed.length > 0) {
    const names = legacyUsed.map((f) => path.relative(rootReal, f).split(path.sep).join("/"));
    warnings.unshift(
      `deprecated: ${names.join(" + ")} still ${names.length === 1 ? "works" : "work"} in 4.x; run 'axiom setup migrate --profile' to fold them into ${AXIOM_CONFIG_PATH}`,
    );
  }
  return {
    gate,
    checks,
    source,
    sources,
    warnings,
    policyDigest: policyDigestOf({ gate, checks: checks ?? null }),
  };
}
