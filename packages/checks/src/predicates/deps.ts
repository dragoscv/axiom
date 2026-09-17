import type { Finding } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import { finding, globMatcher, parseJsonObject } from "./util.js";

const DEFAULT_FILES = ["**/package.json"];

function depNames(pkg: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    const v = pkg[key];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) names.push(...Object.keys(v));
  }
  return names;
}

async function* packageJsons(
  ctx: FactContext,
  files: readonly string[],
): AsyncGenerator<{ path: string; deps: string[] }> {
  const applies = globMatcher(files, false);
  for (const a of ctx.manifest.artifacts) {
    if (a.op === "delete" || !applies(a.path)) continue;
    const bytes = await ctx.facts.content(a.path);
    if (bytes === undefined) continue;
    const pkg = parseJsonObject(bytes);
    if (pkg === undefined) continue;
    yield { path: a.path, deps: depNames(pkg) };
  }
}

const MaxParams = z
  .object({
    max: z.int().nonnegative(),
    files: z.array(z.string().min(1)).default(DEFAULT_FILES),
  })
  .strict();

export const depsMax = definePredicate<z.infer<typeof MaxParams>>({
  id: "deps.max",
  params: MaxParams,
  requires: ["manifest", "content"],
  async run(ctx, { max, files }) {
    const out: Finding[] = [];
    for await (const { path, deps } of packageJsons(ctx, files)) {
      if (deps.length <= max) continue;
      out.push(
        finding({
          id: "deps.max",
          predicate: "deps.max",
          path,
          message: `${deps.length} dependencies declared, limit ${max}`,
          facts: { count: deps.length, max },
        }),
      );
    }
    return out;
  },
});

const DenyParams = z
  .object({
    packages: z.array(z.string().min(1)).min(1),
    files: z.array(z.string().min(1)).default(DEFAULT_FILES),
  })
  .strict();

export const depsDeny = definePredicate<z.infer<typeof DenyParams>>({
  id: "deps.deny",
  params: DenyParams,
  requires: ["manifest", "content"],
  async run(ctx, { packages, files }) {
    const denied = new Set(packages);
    const out: Finding[] = [];
    for await (const { path, deps } of packageJsons(ctx, files)) {
      for (const d of deps) {
        if (!denied.has(d)) continue;
        out.push(
          finding({
            id: `deps.deny.${d}`,
            predicate: "deps.deny",
            path,
            message: `dependency "${d}" is denied`,
            facts: { package: d },
          }),
        );
      }
    }
    return out;
  },
});
