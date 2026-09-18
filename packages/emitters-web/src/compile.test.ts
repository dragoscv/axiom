import { createEmitterRegistry } from "@codai/axiom-plan";
import type { PlanInput } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { GOLDEN_PARAMS } from "./fixtures.js";
import { webEmitter } from "./index.js";

const registry = createEmitterRegistry([webEmitter]);

const plan: PlanInput = {
  apiVersion: "axiom.dev/v2",
  kind: "Plan",
  name: "emitters-web-demo",
  intent: "three template sources on the golden stack",
  artifacts: [
    {
      path: "app/api/posts/[id]/route.ts",
      source: {
        type: "template",
        emitter: "web",
        template: "next.route-handler",
        params: GOLDEN_PARAMS["next.route-handler"],
      },
    },
    {
      path: "src/db/schema/blog-posts.ts",
      source: {
        type: "template",
        emitter: "web",
        template: "drizzle.table",
        params: GOLDEN_PARAMS["drizzle.table"],
      },
    },
    {
      path: "biome.json",
      source: { type: "template", emitter: "web", template: "biome.config", params: {} },
    },
  ],
};

// Pinned: proves the emitter output + digest are stable across machines and OSes.
const EXPECTED_DIGEST = "sha256:a88a1ecf5f08823e43dc8380b7f87b0a5e600d69ca77644a4a163b0818515a1f";

describe("compilePlan with the web emitter", () => {
  it("compiles three template sources deterministically", async () => {
    const { compilePlan } = await import("@codai/axiom-plan");
    const a = await compilePlan(plan, { emitters: registry });
    const b = await compilePlan(plan, { emitters: registry });
    expect(a.bundle.manifestDigest).toBe(b.bundle.manifestDigest);
    expect(a.bundle.manifest.toolchain.emitters).toEqual({ web: "2.0.0" });
    expect(a.bundle.manifest.artifacts.map((x) => x.origin)).toEqual([
      "template",
      "template",
      "template",
    ]);
    expect(Object.keys(a.bundle.blobs)).toHaveLength(3);
    expect(a.bundle.manifestDigest).toBe(EXPECTED_DIGEST);
  });

  it("a different emitter version changes the manifest digest, not the plan digest", async () => {
    const { compilePlan } = await import("@codai/axiom-plan");
    const base = await compilePlan(plan, { emitters: registry });
    const bumped = await compilePlan(plan, {
      emitters: createEmitterRegistry([{ ...webEmitter, version: "2.0.1" }]),
    });
    expect(bumped.bundle.manifest.toolchain.emitters).toEqual({ web: "2.0.1" });
    expect(bumped.bundle.manifestDigest).not.toBe(base.bundle.manifestDigest);
    expect(bumped.bundle.manifest.planDigest).toBe(base.bundle.manifest.planDigest);
  });

  it("an unknown template inside a known emitter fails closed", async () => {
    const { compilePlan } = await import("@codai/axiom-plan");
    await expect(
      compilePlan(
        {
          ...plan,
          artifacts: [
            {
              path: "x.ts",
              source: { type: "template", emitter: "web", template: "next.page", params: {} },
            },
          ],
        },
        { emitters: registry },
      ),
    ).rejects.toMatchObject({ code: "ERR_TEMPLATE_UNKNOWN" });
  });

  it("bad params fail with ERR_TEMPLATE_PARAMS carrying issues", async () => {
    const { compilePlan } = await import("@codai/axiom-plan");
    await expect(
      compilePlan(
        {
          ...plan,
          artifacts: [
            {
              path: "x.ts",
              source: {
                type: "template",
                emitter: "web",
                template: "drizzle.table",
                params: { name: "Bad", columns: [] },
              },
            },
          ],
        },
        { emitters: registry },
      ),
    ).rejects.toMatchObject({ code: "ERR_TEMPLATE_PARAMS" });
  });
});
