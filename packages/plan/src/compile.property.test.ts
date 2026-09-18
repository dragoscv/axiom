import { canonicalize } from "@codai/axiom-canon";
import type { PlanInput } from "@codai/axiom-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compilePlan } from "./compile.js";
import { verifyBundle } from "./verify.js";

// RelPathSchema rejects Windows reserved device names on every OS; keep the
// generator inside the valid domain so a rare `con`/`nul`/`com1` does not flake.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const segment = fc
  .stringMatching(/^[a-z0-9_-]{1,12}$/)
  .filter((s) => !/[.\s]$/.test(s) && !RESERVED.test(s));
const ext = fc.constantFrom("", ".ts", ".md", ".json", ".txt");
const relPath = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), ext)
  .map(([segs, e]) => segs.join("/") + e);

const utf8Content = fc.string({ minLength: 0, maxLength: 200, unit: "grapheme" });
const binaryContent = fc.uint8Array({ minLength: 0, maxLength: 200 });

const artifact = fc
  .tuple(relPath, fc.oneof(utf8Content, binaryContent))
  .map(([path, content]): PlanInput["artifacts"][number] =>
    typeof content === "string"
      ? { path, source: { type: "inline", content } }
      : {
          path,
          source: {
            type: "inline",
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          },
        },
  );

const planArb: fc.Arbitrary<PlanInput> = fc
  .uniqueArray(artifact, { minLength: 2, maxLength: 10, selector: (a) => a.path })
  .map((artifacts) => ({
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: "prop",
    intent: "property test",
    artifacts,
  }));

describe("compilePlan properties", () => {
  it("arbitrary small plans compile and verify ok", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const { bundle } = await compilePlan(plan);
        const r = verifyBundle(bundle);
        expect(r.ok).toBe(true);
        expect(r.missing).toEqual([]);
        expect(bundle.manifest.artifacts).toHaveLength(plan.artifacts.length);
      }),
      { numRuns: 60 },
    );
  });

  it("permuting artifacts keeps manifestDigest and canonical body", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, fc.infiniteStream(fc.nat()), async (plan, rnd) => {
        const shuffled = [...plan.artifacts];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (rnd.next().value ?? 0) % (i + 1);
          const tmp = shuffled[i]!;
          shuffled[i] = shuffled[j]!;
          shuffled[j] = tmp;
        }
        const a = await compilePlan(plan);
        const b = await compilePlan({ ...plan, artifacts: shuffled });
        expect(b.bundle.manifestDigest).toBe(a.bundle.manifestDigest);
        expect(canonicalize(b.bundle.manifest)).toBe(canonicalize(a.bundle.manifest));
        expect(canonicalize(b.bundle.blobs)).toBe(canonicalize(a.bundle.blobs));
      }),
      { numRuns: 40 },
    );
  });
});
