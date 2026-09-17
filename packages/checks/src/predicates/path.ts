import { relPathIssues } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate } from "../types.js";
import { finding, globMatcher } from "./util.js";

const Globs = z.object({ globs: z.array(z.string().min(1)).min(1) }).strict();

/** Every artifact path must match at least one glob. */
export const pathAllow = definePredicate<z.infer<typeof Globs>>({
  id: "path.allow",
  params: Globs,
  requires: ["manifest"],
  async run(ctx, { globs }) {
    const allowed = globMatcher(globs, false);
    return ctx.facts.manifest.paths
      .filter((p) => !allowed(p))
      .map((p) =>
        finding({
          id: "path.allow",
          predicate: "path.allow",
          path: p,
          message: `path is outside the allowed globs`,
          facts: { globs },
        }),
      );
  },
});

/** No artifact path may match any glob. */
export const pathDeny = definePredicate<z.infer<typeof Globs>>({
  id: "path.deny",
  params: Globs,
  requires: ["manifest"],
  async run(ctx, { globs }) {
    const denied = globMatcher(globs, false);
    return ctx.facts.manifest.paths.filter(denied).map((p) =>
      finding({
        id: "path.deny",
        predicate: "path.deny",
        path: p,
        message: `path matches a denied glob`,
        facts: { globs },
      }),
    );
  },
});

/** Belt and braces: re-run the schema's path validation on every artifact. */
export const pathReservedNames = definePredicate<Record<string, never>>({
  id: "path.reservedNames",
  params: z.object({}).strict(),
  requires: ["manifest"],
  async run(ctx) {
    const out = [];
    for (const p of ctx.facts.manifest.paths) {
      const issues = relPathIssues(p);
      if (issues.length === 0) continue;
      // A path that failed the schema would not survive as a RelPath, so drop it
      // from the finding rather than emit an invalid Finding.
      out.push(
        finding({
          id: "path.reservedNames",
          predicate: "path.reservedNames",
          message: `path violates relative-POSIX rules: ${issues.join(", ")}`,
          facts: { path: p, issues },
        }),
      );
    }
    return out;
  },
});
