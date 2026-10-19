import { describe, expect, it } from "vitest";
import { HEX_A, REF_A, validPlan } from "./fixtures.test-helpers.js";
import {
  API_VERSION,
  API_VERSION_V2,
  INLINE_CONTENT_MAX,
  isLegacyApiVersion,
  PlanArtifactSchema,
  PlanArtifactSourceSchema,
  PlanSchema,
} from "./plan.js";

describe("PlanSchema", () => {
  it("D-41: canonical apiVersion is axiom.codai.ro/v3 and axiom.dev/v2 still parses", () => {
    expect(API_VERSION).toBe("axiom.codai.ro/v3");
    expect(validPlan().apiVersion).toBe(API_VERSION);
    expect(PlanSchema.parse(validPlan()).apiVersion).toBe("axiom.codai.ro/v3");
    const legacy = PlanSchema.parse({ ...validPlan(), apiVersion: API_VERSION_V2 });
    expect(legacy.apiVersion).toBe("axiom.dev/v2");
    expect(isLegacyApiVersion(legacy.apiVersion)).toBe(true);
    expect(isLegacyApiVersion(API_VERSION)).toBe(false);
  });

  it("accepts a minimal plan and applies defaults", () => {
    const r = PlanSchema.parse(validPlan());
    expect(r.profile).toBe("default");
    expect(r.capabilities).toEqual([]);
    expect(r.checks).toEqual([]);
    expect(r.metadata).toEqual({});
    expect(r.artifacts[0]?.mode).toBe("0644");
    expect(r.artifacts[0]?.op).toBe("create");
    const src = r.artifacts[0]?.source;
    expect(src?.type === "inline" && src.encoding).toBe("utf8");
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(PlanSchema.safeParse({ ...validPlan(), extra: 1 }).success).toBe(false);
  });

  it("rejects wrong apiVersion / kind", () => {
    expect(PlanSchema.safeParse({ ...validPlan(), apiVersion: "axiom.dev/v1" }).success).toBe(
      false,
    );
    expect(PlanSchema.safeParse({ ...validPlan(), kind: "Manifest" }).success).toBe(false);
  });

  it.each(["Hello", "-x", "a".repeat(65), "", "a_b"])("rejects name %j", (name) => {
    expect(PlanSchema.safeParse({ ...validPlan(), name }).success).toBe(false);
  });

  it("rejects intent > 2000 chars and empty artifacts", () => {
    expect(PlanSchema.safeParse({ ...validPlan(), intent: "x".repeat(2001) }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan(), artifacts: [] }).success).toBe(false);
  });

  it("rejects > 2000 artifacts", () => {
    const artifacts = Array.from({ length: 2001 }, (_, i) => ({
      path: `f/${i}.txt`,
      source: { type: "inline" as const, content: "x" },
    }));
    expect(PlanSchema.safeParse({ ...validPlan(), artifacts }).success).toBe(false);
  });

  it("accepts every capability incl. git, rejects unknown", () => {
    const caps = ["fs", "net", "secret", "ai", "compute", "git"];
    expect(PlanSchema.safeParse({ ...validPlan(), capabilities: caps }).success).toBe(true);
    expect(PlanSchema.safeParse({ ...validPlan(), capabilities: ["shell"] }).success).toBe(false);
  });

  it("checks must be CheckRefs; severity defaults to error", () => {
    const r = PlanSchema.parse({
      ...validPlan(),
      checks: [{ id: "no-secrets", predicate: "content.noSecrets", params: {} }],
    });
    expect(r.checks[0]?.severity).toBe("error");
    expect(
      PlanSchema.safeParse({ ...validPlan(), checks: [{ id: "x", predicate: "bad" }] }).success,
    ).toBe(false);
  });

  it("metadata must be JSON", () => {
    expect(PlanSchema.safeParse({ ...validPlan(), metadata: { a: [1, "b", null] } }).success).toBe(
      true,
    );
    expect(PlanSchema.safeParse({ ...validPlan(), metadata: { f: () => 1 } }).success).toBe(false);
  });
});

describe("PlanArtifactSchema", () => {
  it("requires source unless delete, and forbids source on delete", () => {
    expect(PlanArtifactSchema.safeParse({ path: "a.ts" }).success).toBe(false);
    expect(PlanArtifactSchema.safeParse({ path: "a.ts", op: "overwrite" }).success).toBe(false);
    expect(PlanArtifactSchema.safeParse({ path: "a.ts", op: "delete" }).success).toBe(true);
    expect(
      PlanArtifactSchema.safeParse({
        path: "a.ts",
        op: "delete",
        source: { type: "inline", content: "" },
      }).success,
    ).toBe(false);
  });

  it("validates path via RelPath and mode enum", () => {
    const src = { type: "inline", content: "" };
    expect(PlanArtifactSchema.safeParse({ path: "../a", source: src }).success).toBe(false);
    expect(PlanArtifactSchema.safeParse({ path: "a", mode: "0777", source: src }).success).toBe(
      false,
    );
    expect(PlanArtifactSchema.safeParse({ path: "bin/x", mode: "0755", source: src }).success).toBe(
      true,
    );
  });
});

describe("PlanArtifactSourceSchema", () => {
  it("inline: enforces 256 KiB and encoding enum", () => {
    expect(
      PlanArtifactSourceSchema.safeParse({
        type: "inline",
        content: "x".repeat(INLINE_CONTENT_MAX),
      }).success,
    ).toBe(true);
    expect(
      PlanArtifactSourceSchema.safeParse({
        type: "inline",
        content: "x".repeat(INLINE_CONTENT_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "inline", content: "x", encoding: "hex" }).success,
    ).toBe(false);
  });

  it("cas: requires DigestRef", () => {
    expect(PlanArtifactSourceSchema.safeParse({ type: "cas", digest: REF_A }).success).toBe(true);
    expect(PlanArtifactSourceSchema.safeParse({ type: "cas", digest: HEX_A }).success).toBe(false);
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "cas", digest: `sha256:${"A".repeat(64)}` })
        .success,
    ).toBe(false);
  });

  it("ref: file/https only, digest pinned", () => {
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "ref", uri: "https://x.dev/a.bin", digest: REF_A })
        .success,
    ).toBe(true);
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "ref", uri: "file:///tmp/a", digest: REF_A })
        .success,
    ).toBe(true);
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "ref", uri: "http://x.dev/a", digest: REF_A })
        .success,
    ).toBe(false);
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "ref", uri: "https://x.dev/a" }).success,
    ).toBe(false);
  });

  it("template: reserved v2.1 variant still parses", () => {
    const r = PlanArtifactSourceSchema.parse({
      type: "template",
      emitter: "webapp",
      template: "page",
      params: { title: "x" },
    });
    expect(r.type).toBe("template");
    expect(PlanArtifactSourceSchema.safeParse({ type: "template", emitter: "w" }).success).toBe(
      false,
    );
  });

  it("rejects unknown discriminator and extra keys", () => {
    expect(PlanArtifactSourceSchema.safeParse({ type: "url", uri: "https://x" }).success).toBe(
      false,
    );
    expect(
      PlanArtifactSourceSchema.safeParse({ type: "inline", content: "", extra: 1 }).success,
    ).toBe(false);
  });
});
