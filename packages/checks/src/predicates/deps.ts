import type { Finding } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import {
  finding,
  GlobListSchema,
  globMatcher,
  parseJsonObject,
  unreadableContent,
} from "./util.js";

const DEFAULT_FILES = ["**/package.json"];

/** Every dependency map npm reads (A1-22: optional/peer deps and `npm:` aliases were invisible). */
const DEP_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** The target of an `npm:` alias (`"alias": "npm:real-pkg@^1"`), including scoped names. */
export function aliasTarget(spec: unknown): string | undefined {
  if (typeof spec !== "string") return undefined;
  const m = /^npm:(@[^@\s/]+\/[^@\s]+|[^@\s]+)(?:@|$)/.exec(spec.trim());
  return m?.[1];
}

function depNames(pkg: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of DEP_MAPS) {
    const v = pkg[key];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) names.push(...Object.keys(v));
  }
  return names;
}

/** Aliased names hidden behind `npm:` specs, so `deps.deny` can name the real package. */
function aliasedNames(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of DEP_MAPS) {
    const v = pkg[key];
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    for (const spec of Object.values(v as Record<string, unknown>)) {
      const target = aliasTarget(spec);
      if (target !== undefined) out.push(target);
    }
  }
  return out;
}

type PackageJsonRead =
  | { path: string; readable: true; deps: string[]; aliased: string[] }
  | { path: string; readable: false };

async function* packageJsons(
  ctx: FactContext,
  files: readonly string[],
): AsyncGenerator<PackageJsonRead> {
  const applies = globMatcher(files, false);
  for (const a of ctx.manifest.artifacts) {
    if (a.op === "delete" || !applies(a.path)) continue;
    const bytes = await ctx.facts.content(a.path);
    // A1-9: a package.json this check must read whose content is unavailable is a provider
    // failure; a file that is simply not JSON is skipped.
    if (bytes === undefined) {
      yield { path: a.path, readable: false };
      continue;
    }
    const pkg = parseJsonObject(bytes);
    if (pkg === undefined) continue;
    yield { path: a.path, readable: true, deps: depNames(pkg), aliased: aliasedNames(pkg) };
  }
}

const MaxParams = z
  .object({
    max: z.int().nonnegative(),
    files: GlobListSchema.default(DEFAULT_FILES),
  })
  .strict();

export const depsMax = definePredicate<z.infer<typeof MaxParams>>({
  id: "deps.max",
  params: MaxParams,
  requires: ["manifest", "content"],
  async run(ctx, { max, files }) {
    const out: Finding[] = [];
    for await (const pkg of packageJsons(ctx, files)) {
      if (!pkg.readable) {
        out.push(unreadableContent("deps.max", pkg.path));
        continue;
      }
      if (pkg.deps.length <= max) continue;
      out.push(
        finding({
          id: "deps.max",
          predicate: "deps.max",
          path: pkg.path,
          message: `${pkg.deps.length} dependencies declared, limit ${max}`,
          facts: { count: pkg.deps.length, max },
        }),
      );
    }
    return out;
  },
});

const DenyParams = z
  .object({
    packages: z.array(z.string().min(1)).min(1),
    files: GlobListSchema.default(DEFAULT_FILES),
  })
  .strict();

export const depsDeny = definePredicate<z.infer<typeof DenyParams>>({
  id: "deps.deny",
  params: DenyParams,
  requires: ["manifest", "content"],
  async run(ctx, { packages, files }) {
    const denied = new Set(packages);
    const out: Finding[] = [];
    for await (const pkg of packageJsons(ctx, files)) {
      if (!pkg.readable) {
        out.push(unreadableContent("deps.deny", pkg.path));
        continue;
      }
      // A1-22: the alias target counts as the package too (`"left-pad": "npm:left-pad@1"`).
      for (const d of [...pkg.deps, ...pkg.aliased]) {
        if (!denied.has(d)) continue;
        out.push(
          finding({
            id: `deps.deny.${d}`,
            predicate: "deps.deny",
            path: pkg.path,
            message: `dependency "${d}" is denied`,
            facts: { package: d },
          }),
        );
      }
    }
    return out;
  },
});
