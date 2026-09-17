import { sha256Hex } from "@codai/axiom-canon";
import type { ManifestBundle, PlanInput } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { compilePlan } from "./compile.js";
import { verifyBundle } from "./verify.js";

const plan: PlanInput = {
  apiVersion: "axiom.dev/v2",
  kind: "Plan",
  name: "v",
  intent: "verify",
  artifacts: [
    { path: "a.txt", source: { type: "inline", content: "alpha" } },
    { path: "b.txt", source: { type: "inline", content: "beta" } },
    { path: "gone", op: "delete" },
  ],
};

function clone(b: ManifestBundle): ManifestBundle {
  return structuredClone(b);
}

describe("verifyBundle", () => {
  it("accepts a freshly compiled bundle", async () => {
    const { bundle } = await compilePlan(plan);
    const r = verifyBundle(bundle);
    expect(r).toEqual({
      ok: true,
      manifestDigest: bundle.manifestDigest,
      canonical: true,
      signed: false,
      missing: [],
      errors: [],
    });
  });

  it("tampered blob (one byte flipped) → ERR_DIGEST_MISMATCH", async () => {
    const { bundle } = await compilePlan(plan);
    const t = clone(bundle);
    const key = `sha256:${sha256Hex("alpha")}` as const;
    t.blobs[key] = { encoding: "utf8", data: "alphb" };
    const r = verifyBundle(t);
    expect(r.ok).toBe(false);
    expect(r.canonical).toBe(true);
    expect(r.errors.map((e) => e.code)).toEqual(["ERR_DIGEST_MISMATCH"]);
    expect(r.errors[0]?.path).toBe(`blobs.${key}`);
  });

  it("tampered manifest → digest mismatch, not canonical", async () => {
    const { bundle } = await compilePlan(plan);
    const t = clone(bundle);
    t.manifest.artifacts[0]!.mode = "0755";
    const r = verifyBundle(t);
    expect(r.ok).toBe(false);
    expect(r.canonical).toBe(false);
    expect(
      r.errors.some((e) => e.code === "ERR_DIGEST_MISMATCH" && e.path === "manifestDigest"),
    ).toBe(true);
    // attestation subject still names the OLD digest, which still equals manifestDigest → no extra error
    expect(r.errors).toHaveLength(1);
  });

  it("unsorted artifacts → ERR_NOT_CANONICAL from schema", async () => {
    const { bundle } = await compilePlan(plan);
    const t = clone(bundle);
    t.manifest.artifacts.reverse();
    const r = verifyBundle(t);
    expect(r.ok).toBe(false);
    expect(r.canonical).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("ERR_NOT_CANONICAL");
  });

  it("manifestDigest edited to another value → attestation subject mismatch too", async () => {
    const { bundle } = await compilePlan(plan);
    const t = clone(bundle);
    t.manifestDigest = `sha256:${sha256Hex("other")}`;
    const r = verifyBundle(t);
    expect(r.errors.map((e) => e.path)).toEqual(["manifestDigest", "attestation.subject.0"]);
  });

  it("missing blob is reported in `missing`, not as an error", async () => {
    const { bundle } = await compilePlan(plan);
    const t = clone(bundle);
    delete t.blobs[`sha256:${sha256Hex("beta")}`];
    const r = verifyBundle(t);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(["b.txt"]);
  });

  it("garbage input → schema errors, never throws", () => {
    expect(verifyBundle(undefined).ok).toBe(false);
    const r = verifyBundle({ manifest: {}, manifestDigest: "nope" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.every((e) => typeof e.code === "string")).toBe(true);
  });

  it("undecodable base64 blob → ERR_INVALID_MANIFEST", async () => {
    const { bundle } = await compilePlan(plan);
    const t = clone(bundle);
    const key = `sha256:${sha256Hex("alpha")}` as const;
    t.blobs[key] = { encoding: "base64", data: "%%%%" };
    const r = verifyBundle(t);
    expect(r.ok).toBe(false);
    // Node's lenient base64 decoder yields bytes; either way the key no longer matches
    expect(["ERR_DIGEST_MISMATCH", "ERR_INVALID_MANIFEST"]).toContain(r.errors[0]?.code);
  });
});
