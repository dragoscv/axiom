import { realpath as realpathCb } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { AxiomError } from "@codai/axiom-schema";

const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
const IS_WIN32 = process.platform === "win32";

/** Frozen allowlist of realpath'd root directories (§5.3). */
export interface RootsPolicy {
  readonly roots: ReadonlySet<string>;
}

export interface ResolvedRoot {
  /** realpath of the requested directory (or the single allowlisted root). */
  rootReal: string;
  /** The allowlisted root that contains `rootReal` (equal to it in the common case). */
  effectiveRoot: string;
}

async function realDir(
  p: string,
  code: "ERR_ROOT_NOT_DIR" | "ERR_ROOT_NOT_ALLOWED",
): Promise<string> {
  let real: string;
  try {
    real = await realpathNative(p);
  } catch (cause) {
    throw new AxiomError(code, `root does not exist: ${p}`, { cause, details: { root: p } });
  }
  if (IS_WIN32 && real.startsWith("\\\\?\\")) real = real.slice(4);
  const st = await stat(real);
  if (!st.isDirectory()) {
    throw new AxiomError(code, `root is not a directory: ${p}`, { details: { root: p } });
  }
  return real;
}

function norm(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return IS_WIN32 ? n.toLowerCase() : n;
}

/** True iff `child` equals `parent` or lies inside it (case-insensitive on win32). */
export function isSameOrInside(parent: string, child: string): boolean {
  const p = norm(parent);
  const c = norm(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Build the policy from `--root <abs>` arguments. Each must exist and be a directory. */
export async function createRootsPolicy(rootArgs: readonly string[]): Promise<RootsPolicy> {
  const roots = new Set<string>();
  for (const r of rootArgs) {
    if (!path.isAbsolute(r)) {
      throw new AxiomError("ERR_ROOT_NOT_DIR", `--root must be absolute: ${r}`, {
        details: { root: r },
      });
    }
    roots.add(await realDir(r, "ERR_ROOT_NOT_DIR"));
  }
  return Object.freeze({ roots: Object.freeze(roots) as ReadonlySet<string> });
}

/**
 * Resolve a tool's `root` argument against the allowlist. No env fallback, no cwd:
 * none requested + one root → that root; none + many → ERR_ROOT_REQUIRED;
 * requested → realpath, must equal or be inside an allowlisted root → else ERR_ROOT_NOT_ALLOWED.
 */
export async function resolveRoot(policy: RootsPolicy, requested?: string): Promise<ResolvedRoot> {
  if (requested === undefined || requested === "") {
    if (policy.roots.size === 1) {
      const only = [...policy.roots][0] as string;
      return { rootReal: only, effectiveRoot: only };
    }
    throw new AxiomError(
      "ERR_ROOT_REQUIRED",
      policy.roots.size === 0
        ? "server has no allowlisted roots (start with --root <dir>)"
        : "root is required when more than one root is allowlisted",
      { details: { roots: [...policy.roots] } },
    );
  }
  if (!path.isAbsolute(requested)) {
    throw new AxiomError("ERR_ROOT_NOT_ALLOWED", `root must be absolute: ${requested}`, {
      details: { root: requested },
    });
  }
  const real = await realDir(requested, "ERR_ROOT_NOT_ALLOWED");
  for (const allowed of policy.roots) {
    if (isSameOrInside(allowed, real)) return { rootReal: real, effectiveRoot: allowed };
  }
  throw new AxiomError("ERR_ROOT_NOT_ALLOWED", `root is outside the allowlist: ${requested}`, {
    details: { root: requested, real, roots: [...policy.roots] },
  });
}
