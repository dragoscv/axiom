import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "@codai/axiom-canon";
import {
  API_VERSION,
  AxiomError,
  type CheckRef,
  type Profile,
  type ProfileInput,
  ProfileNameSchema,
  ProfileSchema,
} from "@codai/axiom-schema";
import { SELF_PROTECT_HARD_GLOBS } from "./self-protect-globs.js";

const MiB = 1024 * 1024;

export const BUILTIN_PROFILE_INPUTS: Readonly<Record<string, ProfileInput>> = {
  default: {
    apiVersion: API_VERSION,
    kind: "Profile",
    name: "default",
    checks: [
      { id: "path.reservedNames", predicate: "path.reservedNames", params: {} },
      // S-1410 / A1-29: the self-protection set is denied by the built-in profile too, so a
      // plan cannot create the hooks or the policy file that decide what AXIOM enforces
      // (the gate applies the same set in-process; this covers `check` / `apply`). The id is
      // `self.protect` (the gate's rule id for the same list) so that a profile which adds its
      // own `path.deny` — the built-in `strict` does — cannot replace this check by id.
      {
        id: "self.protect",
        predicate: "path.deny",
        params: { globs: [".git/**", ...SELF_PROTECT_HARD_GLOBS] },
      },
      { id: "content.noSecrets", predicate: "content.noSecrets", params: {} },
      { id: "manifest.maxArtifacts", predicate: "manifest.maxArtifacts", params: { max: 2000 } },
      {
        id: "manifest.maxTotalBytes",
        predicate: "manifest.maxTotalBytes",
        params: { max: 64 * MiB },
      },
      {
        id: "repo.noOverwriteOf",
        predicate: "repo.noOverwriteOf",
        params: { globs: [".git/**", ".axiom/**", "**/*.lock", "pnpm-lock.yaml", ".env*"] },
      },
    ],
    limits: { maxArtifacts: 2000, maxTotalBytes: 64 * MiB },
  },
  strict: {
    apiVersion: API_VERSION,
    kind: "Profile",
    name: "strict",
    extends: "default",
    checks: [
      { id: "manifest.noDeletes", predicate: "manifest.noDeletes", params: {} },
      { id: "deps.max", predicate: "deps.max", params: { max: 50 } },
      { id: "path.deny", predicate: "path.deny", params: { globs: ["**/node_modules/**"] } },
    ],
  },
  permissive: {
    apiVersion: API_VERSION,
    kind: "Profile",
    name: "permissive",
    checks: [{ id: "path.reservedNames", predicate: "path.reservedNames", params: {} }],
  },
};

function parseProfile(raw: unknown, source: string): Profile {
  const r = ProfileSchema.safeParse(raw);
  if (!r.success) {
    throw new AxiomError("ERR_INVALID_PROFILE", `invalid profile ${source}`, {
      details: {
        issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }
  return r.data;
}

export function builtinProfiles(): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  for (const [name, input] of Object.entries(BUILTIN_PROFILE_INPUTS)) {
    out[name] = parseProfile(input, `builtin:${name}`);
  }
  return out;
}

export interface LoadProfileOptions {
  /** Directories searched for `<name>.json`, in order, before builtins. */
  searchDirs?: readonly string[];
  /** Defaults to the three built-in profiles. */
  builtins?: Readonly<Record<string, Profile>>;
  /**
   * The merged `checks` section of `.axiom/axiom.json` (3.0, D-42), as returned by the MCP
   * package's `loadAxiomConfig` — injected rather than read here so `checks` stays free of the
   * file/pack resolution (and of any `@codai/*` dependency beyond schema + canon). It is the
   * repo profile: `Profile` fields, `apiVersion`/`kind` optional, `name` defaulting to
   * {@link AXIOM_CONFIG_PROFILE_NAME}. It answers a request for its own `name` AND for
   * `default` (the repo policy is the repo's default); its `extends` chain resolves through
   * `searchDirs` and the builtins as usual. `undefined` = no axiom.json (legacy behaviour).
   */
  config?: unknown;
}

/** `name` of the axiom.json `checks` profile when the section does not declare one. */
export const AXIOM_CONFIG_PROFILE_NAME = "axiom";

function parseConfigProfile(raw: unknown): Profile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AxiomError("ERR_INVALID_PROFILE", "axiom.json `checks` must be an object");
  }
  const section = raw as Record<string, unknown>;
  // A section that says nothing about checks (`{}` — e.g. a gate-only axiom.json) must not
  // resolve to an EMPTY profile, which would be weaker than having no file at all.
  const implicit = !("checks" in section) && !("extends" in section) ? { extends: "default" } : {};
  return parseProfile(
    {
      apiVersion: API_VERSION,
      kind: "Profile",
      name: AXIOM_CONFIG_PROFILE_NAME,
      checks: [],
      ...implicit,
      ...section,
    },
    ".axiom/axiom.json#checks",
  );
}

async function readOne(name: string, opts: LoadProfileOptions): Promise<Profile> {
  if (!ProfileNameSchema.safeParse(name).success) {
    throw new AxiomError("ERR_INVALID_PROFILE", `invalid profile name: ${name}`);
  }
  for (const dir of opts.searchDirs ?? []) {
    const file = join(dir, `${name}.json`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw new AxiomError("ERR_INVALID_PROFILE", `profile ${file} is not JSON`, { cause });
    }
    const p = parseProfile(raw, file);
    if (p.name !== name) {
      throw new AxiomError("ERR_INVALID_PROFILE", `profile ${file} declares name "${p.name}"`);
    }
    return p;
  }
  const builtin = (opts.builtins ?? builtinProfiles())[name];
  if (builtin === undefined) {
    throw new AxiomError("ERR_INVALID_PROFILE", `profile not found: ${name}`, {
      details: { profile: name },
    });
  }
  return builtin;
}

/** Merge child over parent: child checks replace parent checks with the same id. */
export function mergeChecks(parent: readonly CheckRef[], child: readonly CheckRef[]): CheckRef[] {
  const byId = new Map<string, CheckRef>();
  for (const c of parent) byId.set(c.id, c);
  for (const c of child) byId.set(c.id, c);
  return [...byId.values()];
}

/**
 * JCS identity of a check — the fields that decide what it does (4.0, D-50, A1-6). Two checks
 * with the same id but a different identity are a policy-floor violation, never a replace.
 */
export function checkIdentity(c: CheckRef): string {
  const body = {
    id: c.id,
    predicate: c.predicate,
    params: c.params ?? null,
    severity: c.severity ?? "error",
  };
  try {
    return canonicalize(body);
  } catch {
    // A param value JCS refuses (a lone surrogate, a cycle) is still comparable, and unequal
    // to anything that canonicalises: the fallback keeps the comparison total.
    return JSON.stringify(body);
  }
}

/** Structural identity: same id, predicate, params and severity. */
export function checksIdentical(a: CheckRef, b: CheckRef): boolean {
  return a.id === b.id && checkIdentity(a) === checkIdentity(b);
}

function profileFacts(profiles: readonly Profile[], floor: Profile["facts"] | undefined) {
  let facts: Profile["facts"] = { allowRepo: true, allowGuards: false };
  for (const p of profiles) facts = { ...facts, ...p.facts };
  if (floor === undefined) return facts;
  // 4.0 (D-50): a profile named by the caller/plan may tighten the repository facts, never
  // relax them — `allowGuards` / `allowPlanGuards` are AND-ed, `allowRepo` is OR-ed.
  const merged: Profile["facts"] = {
    allowRepo: floor.allowRepo || facts.allowRepo,
    allowGuards: floor.allowGuards && facts.allowGuards,
  };
  if (floor.allowPlanGuards === true && facts.allowPlanGuards === true) {
    merged.allowPlanGuards = true;
  }
  return merged;
}

/**
 * Load `name`, resolving its `extends` chain (parent first). The result has
 * `extends` removed and the merged checks/limits/facts; `name` is the requested one.
 * Cycles and missing parents → ERR_INVALID_PROFILE.
 *
 * 4.0 (D-50, A1-6/A2-6): when `config` (the repository `checks` section) is given, the
 * repository profile is ALWAYS part of the result, whatever `name` is. A name that is not the
 * repository profile's own is resolved on top and may only ADD checks: a check whose id already
 * exists in the repository policy is dropped, never allowed to replace it (the floor wins). The
 * plan-side counterpart of this rule lives in `runChecks` (`ERR_POLICY_FLOOR`).
 */
export async function loadProfile(name: string, opts: LoadProfileOptions = {}): Promise<Profile> {
  const builtins = opts.builtins ?? builtinProfiles();
  const resolved: LoadProfileOptions = { builtins };
  if (opts.searchDirs !== undefined) resolved.searchDirs = opts.searchDirs;

  const step = async (
    start: string | undefined,
    seen: Set<string>,
    into: Profile[],
  ): Promise<void> => {
    let cur = start;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        throw new AxiomError("ERR_INVALID_PROFILE", `profile extends cycle at "${cur}"`, {
          details: { chain: [...seen, cur] },
        });
      }
      seen.add(cur);
      const p: Profile = await readOne(cur, resolved);
      into.unshift(p);
      cur = p.extends;
    }
  };

  const floor = opts.config === undefined ? undefined : parseConfigProfile(opts.config);
  const nameIsFloor = floor !== undefined && (name === floor.name || name === "default");

  // The repository layer (the config leaf and its parents), parents first.
  const floorChain: Profile[] = [];
  if (floor !== undefined) {
    // The leaf is the config itself; its parents resolve normally (a parent may share the
    // leaf's name — `default` extending the builtin `default` — like a file shadowing a builtin).
    floorChain.unshift(floor);
    await step(floor.extends, new Set<string>(), floorChain);
  }

  // The named profile, when it is not the repository one, on top of the floor.
  const topChain: Profile[] = [];
  if (floor === undefined || !nameIsFloor) {
    await step(name, new Set<string>(), topChain);
  }

  const byId = new Map<string, CheckRef>();
  let limits: Profile["limits"] = {};
  for (const p of floorChain) {
    for (const c of p.checks) byId.set(c.id, c);
    limits = { ...limits, ...p.limits };
  }
  const floorIds = new Set(byId.keys());
  for (const p of topChain) {
    for (const c of p.checks) {
      if (floorIds.has(c.id)) continue; // the repository check wins; a name may only ADD
      byId.set(c.id, c);
    }
    limits = { ...limits, ...p.limits };
  }

  const leaf = topChain[topChain.length - 1] ?? floorChain[floorChain.length - 1];
  const floorLeaf = floorChain[floorChain.length - 1];
  // A1-6 / DX-6: the report must name the policy that actually judged the bundle. When a named
  // profile sits on top of the repository policy, both names are reported (`axiom.strict`), so a
  // report can never look like the repository policy had been replaced by the named one.
  const resultName =
    floorLeaf !== undefined && topChain.length > 0
      ? `${floorLeaf.name}.${leaf?.name ?? name}`.slice(0, 64)
      : (leaf?.name ?? name);
  const floorFacts = floorChain.length > 0 ? aggregateFacts(floorChain) : undefined;
  const facts =
    topChain.length > 0
      ? profileFacts(topChain, floorFacts)
      : (floorFacts ?? { allowRepo: true, allowGuards: false });
  return {
    apiVersion: API_VERSION,
    kind: "Profile",
    name: resultName,
    checks: [...byId.values()],
    limits,
    facts,
  };
}

function aggregateFacts(profiles: readonly Profile[]): Profile["facts"] {
  let facts: Profile["facts"] = { allowRepo: true, allowGuards: false };
  for (const p of profiles) facts = { ...facts, ...p.facts };
  return facts;
}
