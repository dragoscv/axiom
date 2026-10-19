/**
 * `.axiom/axiom.json` loader (3.0, D-42): ONE policy file holding the gate policy (`gate`) and the
 * check profile (`checks`), composable with `extends`.
 *
 * `extends` entries, resolved in order (later wins, the file itself last):
 *   - `./base.json` / `../x.json` — relative to the declaring file; must stay inside the repo root
 *     or the user's `~/.axiom` (realpath'd, so a symlink cannot smuggle a file in);
 *   - `axiom:default` / `axiom:strict` / `axiom:permissive` — built-in packs: the matching
 *     built-in check profile (by `extends`, resolved by `@codai/axiom-checks`) + a gate pack;
 *   - `@codai/axiom-pack-<name>` (or any npm name when `allowNpmPacks`) — resolved with
 *     `createRequire` from the repo root; the package must already be in node_modules (nothing is
 *     ever installed) and ship `axiom-pack.json` (via `exports["./axiom-pack.json"]` or
 *     `package.json#axiomPack`).
 *
 * Merge: objects deep-merge, scalars are replaced, the policy arrays `deny`/`ask`/`hard`/`allow`
 * are UNIONED (a pack can never silently drop a deny), other arrays are replaced. Cycles and a
 * depth over {@link MAX_EXTENDS_DEPTH} → `ERR_INVALID_PROFILE`; `version` above
 * {@link AXIOM_CONFIG_VERSION} → `ERR_PROFILE_VERSION`; unknown keys → a warning, ignored.
 *
 * Validation of `gate` (GateProfileSchema) and `checks` (ProfileSchema) is the caller's job:
 * this module only resolves and merges, so it stays free of the gate and checks engines.
 */
import { readFile, realpath as realpathFs } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  AXIOM_CONFIG_PATH,
  AXIOM_CONFIG_VERSION,
  AxiomConfigFileSchema,
  AxiomError,
} from "@codai/axiom-schema";

/** Repo-relative path of the v3 policy file. */
export const AXIOM_CONFIG_FILE: typeof AXIOM_CONFIG_PATH = AXIOM_CONFIG_PATH;
/** Maximum nesting of `extends` (the root file is depth 0). */
export const MAX_EXTENDS_DEPTH = 8;
/** npm packs resolvable without `allowNpmPacks`. */
export const TRUSTED_PACK_SCOPE = "@codai/";
/** Policy arrays merged by union instead of replacement. */
export const UNION_KEYS: ReadonlySet<string> = new Set(["deny", "ask", "hard", "allow"]);

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "version",
  "extends",
  "allowNpmPacks",
  "gate",
  "checks",
]);

/**
 * The builtin gate deny list (`DEFAULT_GATE_PROFILE.deny` in gate.ts — copied, not imported, so
 * this loader does not pull the gate engine in; profile-v3.test.ts asserts they stay equal).
 */
export const BUILTIN_GATE_DENY: readonly string[] = [
  ".git/**",
  ".axiom/**",
  "**/*.lock",
  "pnpm-lock.yaml",
  ".env",
  ".env.*",
  "**/node_modules/**",
];

/** `axiom:<name>` → the check profile it extends and the gate fields it contributes. */
export const BUILTIN_PACKS: Readonly<
  Record<string, { checks: Record<string, unknown>; gate: Record<string, unknown> }>
> = {
  default: {
    checks: { name: "default", extends: "default" },
    gate: { deny: [...BUILTIN_GATE_DENY], steer: "hint" },
  },
  strict: {
    checks: { name: "strict", extends: "strict" },
    gate: {
      deny: [...BUILTIN_GATE_DENY, ".github/workflows/**"],
      steer: "hint",
      outside: "deny",
      noSecrets: true,
      pii: true,
      commands: { pack: "house" },
    },
  },
  permissive: {
    checks: { name: "permissive", extends: "permissive" },
    gate: { deny: [".git/**", ".axiom/**"], outside: "warn" },
  },
};

export interface LoadAxiomConfigOptions {
  /** Directory whose `.axiom` may hold shared `extends` files (default `os.homedir()`). */
  home?: string;
  /** Allow npm packs outside the `@codai` scope (also enabled by `allowNpmPacks: true` in the root file). */
  allowNpmPacks?: boolean;
}

export interface AxiomConfig {
  /** Raw merged gate object — validate with `GateProfileSchema`. `{}` when no layer set one. */
  gate: unknown;
  /** Raw merged check profile — pass as `loadProfile(name, { config: checks })`. */
  checks: unknown;
  /** Every layer read, in merge order (absolute paths, `axiom:<pack>`, `npm:<pkg>`), root file last. */
  sources: string[];
  warnings: string[];
  /** Always false here; true is reserved for {@link loadLegacyAxiomConfig}. */
  legacy: boolean;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function invalid(message: string, details?: Record<string, unknown>): AxiomError {
  return new AxiomError(
    "ERR_INVALID_PROFILE",
    message,
    details === undefined ? undefined : { details },
  );
}

function isIdList(v: unknown[]): v is Array<Json & { id: string }> {
  return v.every((x) => isObject(x) && typeof x.id === "string");
}

/**
 * Deep merge `over` onto `base` (both untouched). Policy arrays union, a `checks` list of
 * `{id}` entries merges by id (later wins, like profile `extends`), other arrays replace.
 */
export function mergeConfig(base: unknown, over: unknown, key?: string): unknown {
  if (key === "checks" && Array.isArray(base) && Array.isArray(over)) {
    if (isIdList(base) && isIdList(over)) {
      const byId = new Map<string, unknown>();
      for (const c of base) byId.set(c.id, c);
      for (const c of over) byId.set(c.id, c);
      return [...byId.values()];
    }
  }
  if (Array.isArray(base) && Array.isArray(over) && key !== undefined && UNION_KEYS.has(key)) {
    const out = [...base];
    const seen = new Set(base.map((v) => JSON.stringify(v)));
    for (const v of over) {
      const k = JSON.stringify(v);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    return out;
  }
  if (isObject(base) && isObject(over)) {
    const out: Json = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = k in base ? mergeConfig(base[k], v, k) : v;
    }
    return out;
  }
  return over === undefined ? base : over;
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpathFs(p);
  } catch {
    return undefined;
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface Ctx {
  rootReal: string;
  homeAxiomReal: string | undefined;
  allowNpm: boolean;
  sources: string[];
  warnings: string[];
}

interface Layer {
  gate: unknown;
  checks: unknown;
}

async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new AxiomError("ERR_INVALID_PROFILE", `cannot read ${file}`, {
      cause,
      details: { file },
    });
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (cause) {
    throw new AxiomError("ERR_INVALID_PROFILE", `${file}: not valid JSON`, {
      cause,
      details: { file },
    });
  }
}

/** Validate one layer document; unknown keys warn. */
function parseLayer(raw: unknown, label: string, ctx: Ctx) {
  if (isObject(raw) && typeof raw.version === "number" && raw.version > AXIOM_CONFIG_VERSION) {
    throw new AxiomError(
      "ERR_PROFILE_VERSION",
      `${label}: version ${raw.version} is newer than this axiom (understands ≤ ${AXIOM_CONFIG_VERSION}); upgrade the axiom bin`,
      { details: { file: label, version: raw.version, max: AXIOM_CONFIG_VERSION } },
    );
  }
  const r = AxiomConfigFileSchema.safeParse(raw);
  if (!r.success) {
    throw invalid(`invalid ${label}`, {
      file: label,
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  for (const k of Object.keys(r.data)) {
    if (!KNOWN_KEYS.has(k)) ctx.warnings.push(`${label}: unknown key "${k}" ignored`);
  }
  return r.data;
}

async function resolveFileRef(ref: string, fromDir: string, ctx: Ctx): Promise<string> {
  const abs = path.resolve(fromDir, ref);
  const real = await realpathOrUndefined(abs);
  if (real === undefined) throw invalid(`extends: ${ref} not found (from ${fromDir})`, { ref });
  const ok =
    inside(real, ctx.rootReal) ||
    (ctx.homeAxiomReal !== undefined && inside(real, ctx.homeAxiomReal));
  if (!ok) {
    // ERR_INVALID_PROFILE (not ERR_CONTAINMENT): an unusable policy must never be covered by
    // the gate's --fail-open.
    throw invalid(`extends: ${ref} resolves outside the repository root and ~/.axiom`, {
      ref,
      resolved: real,
      reason: "containment",
    });
  }
  return real;
}

/** Directory of an installed package, found through Node's lookup paths (no exports needed). */
async function packageDir(name: string, req: NodeJS.Require): Promise<string | undefined> {
  for (const base of req.resolve.paths(name) ?? []) {
    const dir = path.join(base, ...name.split("/"));
    const real = await realpathOrUndefined(path.join(dir, "package.json"));
    if (real !== undefined) return path.dirname(real);
  }
  return undefined;
}

async function resolveNpmPack(name: string, ctx: Ctx): Promise<{ file: string; label: string }> {
  if (!name.startsWith(TRUSTED_PACK_SCOPE) && !ctx.allowNpm) {
    throw invalid(
      `extends: npm pack ${name} is outside ${TRUSTED_PACK_SCOPE}; set allowNpmPacks to use it`,
      { ref: name },
    );
  }
  const req = createRequire(path.join(ctx.rootReal, "package.json"));
  let file: string | undefined;
  try {
    // Honours package `exports` (`"./axiom-pack.json"`).
    file = req.resolve(`${name}/axiom-pack.json`);
  } catch {
    file = undefined;
  }
  if (file === undefined) {
    const dir = await packageDir(name, req);
    if (dir !== undefined) {
      const pkg = await readJsonFile(path.join(dir, "package.json"));
      const rel = isObject(pkg) && typeof pkg.axiomPack === "string" ? pkg.axiomPack : undefined;
      if (rel !== undefined) {
        const cand = path.resolve(dir, rel);
        if (!inside(cand, dir)) {
          throw invalid(`${name}: package.json#axiomPack escapes the package`, { ref: name });
        }
        file = cand;
      }
    }
  }
  if (file === undefined) {
    throw invalid(
      `extends: npm pack ${name} is not installed under ${ctx.rootReal} (axiom never installs packs) or ships no axiom-pack.json`,
      { ref: name },
    );
  }
  return { file, label: `npm:${name}` };
}

function isNpmRef(ref: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(ref);
}

function isFileRef(ref: string): boolean {
  return ref.startsWith("./") || ref.startsWith("../") || path.isAbsolute(ref);
}

async function resolveRef(
  ref: string,
  fromDir: string,
  ctx: Ctx,
): Promise<{ file: string; label?: string }> {
  if (isFileRef(ref)) return { file: await resolveFileRef(ref, fromDir, ctx) };
  if (isNpmRef(ref)) return resolveNpmPack(ref, ctx);
  throw invalid(`extends: unrecognised entry ${JSON.stringify(ref)}`, { ref });
}

async function loadLayer(
  raw: unknown,
  label: string,
  fromDir: string,
  ctx: Ctx,
  stack: readonly string[],
): Promise<Layer> {
  // stack[0] is the root file (depth 0); every extends level adds one entry.
  if (stack.length - 1 > MAX_EXTENDS_DEPTH) {
    throw invalid(`extends deeper than ${MAX_EXTENDS_DEPTH} at ${label}`, { chain: [...stack] });
  }
  const doc = parseLayer(raw, label, ctx);
  let acc: Layer = { gate: {}, checks: {} };
  for (const ref of doc.extends ?? []) {
    let child: Layer;
    if (ref.startsWith("axiom:")) {
      const pack = BUILTIN_PACKS[ref.slice("axiom:".length)];
      if (pack === undefined) throw invalid(`extends: unknown built-in pack ${ref}`, { ref });
      ctx.sources.push(ref);
      child = { gate: structuredClone(pack.gate), checks: structuredClone(pack.checks) };
    } else {
      const { file, label: childLabel } = await resolveRef(ref, fromDir, ctx);
      const id = (await realpathOrUndefined(file)) ?? file;
      if (stack.includes(id)) {
        throw invalid(`extends cycle at ${ref}`, { chain: [...stack, id] });
      }
      child = await loadLayer(await readJsonFile(id), childLabel ?? id, path.dirname(id), ctx, [
        ...stack,
        id,
      ]);
    }
    acc = {
      gate: mergeConfig(acc.gate, child.gate),
      checks: mergeConfig(acc.checks, child.checks),
    };
  }
  const own: Layer = { gate: doc.gate ?? {}, checks: doc.checks ?? {} };
  ctx.sources.push(label);
  return { gate: mergeConfig(acc.gate, own.gate), checks: mergeConfig(acc.checks, own.checks) };
}

/**
 * Load and merge `<root>/.axiom/axiom.json`. `undefined` when the file does not exist (callers
 * then fall back to {@link loadLegacyAxiomConfig} / the 2.x files). Throws `AxiomError` with
 * `ERR_INVALID_PROFILE` or `ERR_PROFILE_VERSION` on an unusable policy — never a silent default.
 */
export async function loadAxiomConfig(
  root: string,
  opts: LoadAxiomConfigOptions = {},
): Promise<AxiomConfig | undefined> {
  const rootReal = (await realpathOrUndefined(root)) ?? path.resolve(root);
  const file = path.join(rootReal, ...AXIOM_CONFIG_PATH.split("/"));
  const fileReal = await realpathOrUndefined(file);
  if (fileReal === undefined) return undefined;
  const raw = await readJsonFile(fileReal);
  const ctx: Ctx = {
    rootReal,
    homeAxiomReal: await realpathOrUndefined(path.join(opts.home ?? homedir(), ".axiom")),
    allowNpm: opts.allowNpmPacks === true || (isObject(raw) && raw.allowNpmPacks === true),
    sources: [],
    warnings: [],
  };
  const merged = await loadLayer(raw, fileReal, path.dirname(fileReal), ctx, [fileReal]);
  return {
    gate: merged.gate,
    checks: merged.checks,
    sources: ctx.sources,
    warnings: ctx.warnings,
    legacy: false,
  };
}

/** 2.x policy file locations, relative to the root. */
export const LEGACY_GATE_PROFILE = ".axiom/gate-profile.json";
export const LEGACY_PROFILES_DIR = ".axiom/profiles";

async function readIfPresent(file: string): Promise<unknown> {
  try {
    await realpathFs(file);
  } catch {
    return undefined;
  }
  return readJsonFile(file);
}

/**
 * The 2.x layout seen through the v3 shape: `gate` = `.axiom/gate-profile.json`,
 * `checks` = `.axiom/profiles/<profileName>.json` (`apiVersion`/`kind` dropped). `undefined` when
 * neither exists. Always carries a deprecation warning pointing at `axiom migrate --profile`.
 * Used by `migrateProfile` and by callers that want one code path for both layouts.
 */
export async function loadLegacyAxiomConfig(
  root: string,
  profileName: string,
): Promise<AxiomConfig | undefined> {
  const rootReal = (await realpathOrUndefined(root)) ?? path.resolve(root);
  const gateFile = path.join(rootReal, ...LEGACY_GATE_PROFILE.split("/"));
  const checksFile = path.join(rootReal, ...LEGACY_PROFILES_DIR.split("/"), `${profileName}.json`);
  const gate = await readIfPresent(gateFile);
  const checksRaw = await readIfPresent(checksFile);
  if (gate === undefined && checksRaw === undefined) return undefined;
  const sources: string[] = [];
  if (gate !== undefined) sources.push(gateFile);
  let checks: unknown = {};
  if (checksRaw !== undefined) {
    sources.push(checksFile);
    if (isObject(checksRaw)) {
      const { apiVersion: _a, kind: _k, ...rest } = checksRaw;
      checks = rest;
    } else checks = checksRaw;
  }
  return {
    gate: gate ?? {},
    checks,
    sources,
    warnings: [
      `deprecated: ${sources.map((s) => path.relative(rootReal, s).split(path.sep).join("/")).join(" + ")} — run 'axiom migrate --profile' to move to ${AXIOM_CONFIG_PATH}`,
    ],
    legacy: true,
  };
}
