import type { Finding } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate } from "../types.js";
import { finding, globMatcher } from "./util.js";

const NoOverwriteParams = z.object({ globs: z.array(z.string().min(1)).min(1) }).strict();

/** Fails when an overwrite/delete targets a protected path that exists in the repo. */
export const repoNoOverwriteOf = definePredicate<z.infer<typeof NoOverwriteParams>>({
  id: "repo.noOverwriteOf",
  params: NoOverwriteParams,
  requires: ["manifest", "repo"],
  async run(ctx, { globs }) {
    const repo = ctx.facts.repo;
    if (repo === undefined) return [];
    const protectedPath = globMatcher(globs, false);
    const out: Finding[] = [];
    for (const a of ctx.manifest.artifacts) {
      if (a.op === "create" || !protectedPath(a.path)) continue;
      if (!(await repo.exists(a.path))) continue;
      out.push(
        finding({
          id: "repo.noOverwriteOf",
          predicate: "repo.noOverwriteOf",
          path: a.path,
          message: `${a.op} of protected existing file`,
          facts: { op: a.op, globs },
        }),
      );
    }
    return out;
  },
});

const CompanionParams = z
  .object({
    rules: z
      .array(
        z
          .object({
            when: z.string().min(1),
            expect: z
              .array(z.object({ name: z.string().min(1), match: z.string().min(1) }).strict())
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/**
 * brivio `check-ripple` shape: when any artifact matches `when`, every `expect`
 * must be satisfied by at least one artifact path OR one existing repo file.
 */
export const repoRequireCompanion = definePredicate<z.infer<typeof CompanionParams>>({
  id: "repo.requireCompanion",
  params: CompanionParams,
  requires: ["manifest", "repo"],
  async run(ctx, { rules }) {
    const paths = ctx.facts.manifest.paths;
    const out: Finding[] = [];
    for (const rule of rules) {
      const when = globMatcher([rule.when], false);
      const triggers = paths.filter(when);
      if (triggers.length === 0) continue;
      for (const exp of rule.expect) {
        const match = globMatcher([exp.match], false);
        if (paths.some(match)) continue;
        const inRepo = ctx.facts.repo ? await ctx.facts.repo.glob(exp.match) : [];
        if (inRepo.length > 0) continue;
        out.push(
          finding({
            id: `repo.requireCompanion.${exp.name}`,
            predicate: "repo.requireCompanion",
            message: `"${rule.when}" changed but no companion matches "${exp.match}" (${exp.name})`,
            facts: { when: rule.when, expect: exp.match, name: exp.name, triggers },
          }),
        );
      }
    }
    return out;
  },
});
