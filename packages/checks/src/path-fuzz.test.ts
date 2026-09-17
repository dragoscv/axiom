import { RelPathSchema } from "@codai/axiom-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveManifestFacts } from "./facts/manifest.js";
import { pathAllow, pathDeny, pathReservedNames } from "./predicates/path.js";
import { makeBundle, profileWith } from "./test-helpers.test-helpers.js";
import type { FactContext } from "./types.js";

const segment = fc
  .stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,11}$/)
  .filter((s) => !s.endsWith(".") && s !== "." && s !== "..");
const relPath = fc
  .array(segment, { minLength: 1, maxLength: 6 })
  .map((segs) => segs.join("/"))
  .filter((p) => RelPathSchema.safeParse(p).success);
const uniquePaths = fc.uniqueArray(relPath, { minLength: 1, maxLength: 20 });
const glob = fc.constantFrom(
  "**",
  "**/*.ts",
  "src/**",
  "*.md",
  "**/node_modules/**",
  "a/**/b",
  "{x,y}/**",
);

function ctxFor(paths: string[]): FactContext {
  const bundle = makeBundle(paths.map((p) => ({ path: p, content: "" })));
  return {
    manifest: bundle.manifest,
    bundle,
    facts: {
      manifest: deriveManifestFacts(bundle),
      content: async () => undefined,
      profile: profileWith([]).facts,
    },
  };
}

describe("path.* never crash on random RelPaths", () => {
  it("allow/deny/reservedNames return valid findings", async () => {
    await fc.assert(
      fc.asyncProperty(
        uniquePaths,
        fc.array(glob, { minLength: 1, maxLength: 3 }),
        async (paths, globs) => {
          const ctx = ctxFor(paths);
          const [a, d, r] = await Promise.all([
            pathAllow.run(ctx, { globs }),
            pathDeny.run(ctx, { globs }),
            pathReservedNames.run(ctx, {}),
          ]);
          // schema-valid paths never trip reservedNames
          expect(r).toEqual([]);
          // allow ∪ deny partition the paths for the same globs
          expect(a.length + d.length).toBe(paths.length);
          for (const f of [...a, ...d]) expect(paths).toContain(f.path);
        },
      ),
      { numRuns: 200 },
    );
  });
});
