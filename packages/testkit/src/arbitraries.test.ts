import { compilePlan, verifyBundle } from "@codai/axiom-plan";
import { PlanSchema, RelPathSchema } from "@codai/axiom-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planArb, relPathArb } from "./arbitraries.js";
import { makeBundle, tmpRepo } from "./fixtures.js";

describe("arbitraries", () => {
  it("relPathArb only yields schema-valid RelPaths", () => {
    fc.assert(
      fc.property(relPathArb(), (p) => {
        expect(RelPathSchema.safeParse(p).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("planArb only yields schema-valid plans that compile and verify", async () => {
    await fc.assert(
      fc.asyncProperty(planArb(), async (plan) => {
        expect(PlanSchema.safeParse(plan).success).toBe(true);
        const { bundle } = await compilePlan(plan);
        expect(verifyBundle(bundle).ok).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});

describe("fixtures", () => {
  it("makeBundle compiles a file map (string + bytes)", async () => {
    const bundle = await makeBundle({ "a.txt": "text", "b.bin": new Uint8Array([0, 1]) });
    expect(bundle.manifest.artifacts.map((a) => a.path)).toEqual(["a.txt", "b.bin"]);
    expect(
      Object.values(bundle.blobs)
        .map((b) => b.encoding)
        .sort(),
    ).toEqual(["base64", "utf8"]);
  });

  it("tmpRepo creates and cleans a directory", async () => {
    const { root, cleanup } = await tmpRepo("axiom-testkit-");
    const { stat } = await import("node:fs/promises");
    expect((await stat(root)).isDirectory()).toBe(true);
    await cleanup();
    await expect(stat(root)).rejects.toThrow();
  });
});
