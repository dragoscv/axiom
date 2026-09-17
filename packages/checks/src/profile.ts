import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  API_VERSION,
  AxiomError,
  type CheckRef,
  type Profile,
  type ProfileInput,
  ProfileNameSchema,
  ProfileSchema,
} from "@codai/axiom-schema";

const MiB = 1024 * 1024;

export const BUILTIN_PROFILE_INPUTS: Readonly<Record<string, ProfileInput>> = {
  default: {
    apiVersion: API_VERSION,
    kind: "Profile",
    name: "default",
    checks: [
      { id: "path.reservedNames", predicate: "path.reservedNames", params: {} },
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
 * Load `name`, resolving its `extends` chain (parent first). The result has
 * `extends` removed and the merged checks/limits/facts; `name` is the requested one.
 * Cycles and missing parents → ERR_INVALID_PROFILE.
 */
export async function loadProfile(name: string, opts: LoadProfileOptions = {}): Promise<Profile> {
  const builtins = opts.builtins ?? builtinProfiles();
  const resolved: LoadProfileOptions = { builtins };
  if (opts.searchDirs !== undefined) resolved.searchDirs = opts.searchDirs;

  const chain: Profile[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = name;
  while (cur !== undefined) {
    if (seen.has(cur)) {
      throw new AxiomError("ERR_INVALID_PROFILE", `profile extends cycle at "${cur}"`, {
        details: { chain: [...seen, cur] },
      });
    }
    seen.add(cur);
    const p: Profile = await readOne(cur, resolved);
    chain.unshift(p);
    cur = p.extends;
  }

  let checks: CheckRef[] = [];
  let limits: Profile["limits"] = {};
  let facts: Profile["facts"] = { allowRepo: true, allowGuards: false };
  for (const p of chain) {
    checks = mergeChecks(checks, p.checks);
    limits = { ...limits, ...p.limits };
    facts = { ...facts, ...p.facts };
  }
  const leaf = chain[chain.length - 1];
  return {
    apiVersion: API_VERSION,
    kind: "Profile",
    name: leaf?.name ?? name,
    checks,
    limits,
    facts,
  };
}
