import { describe, expect, it } from "vitest";
import { ProfileSchema } from "./profile.js";

const valid = {
  apiVersion: "axiom.dev/v2",
  kind: "Profile",
  name: "default",
  checks: [{ id: "no-secrets", predicate: "content.noSecrets", params: {} }],
};

describe("ProfileSchema", () => {
  it("applies nested defaults for facts and limits", () => {
    const p = ProfileSchema.parse(valid);
    expect(p.facts).toEqual({ allowRepo: true, allowGuards: false });
    expect(p.limits).toEqual({});
    expect(p.extends).toBeUndefined();
  });

  it("applies inner defaults when facts is partially given", () => {
    const p = ProfileSchema.parse({ ...valid, facts: { allowGuards: true } });
    expect(p.facts).toEqual({ allowRepo: true, allowGuards: true });
  });

  it("limits are partial positive ints", () => {
    expect(ProfileSchema.safeParse({ ...valid, limits: { maxArtifacts: 10 } }).success).toBe(true);
    expect(ProfileSchema.safeParse({ ...valid, limits: { maxArtifacts: 0 } }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...valid, limits: { maxBlobBytes: 1.5 } }).success).toBe(
      false,
    );
    expect(ProfileSchema.safeParse({ ...valid, limits: { other: 1 } }).success).toBe(false);
  });

  it("supports extends with the same name rules", () => {
    expect(ProfileSchema.safeParse({ ...valid, name: "edge", extends: "default" }).success).toBe(
      true,
    );
    expect(ProfileSchema.safeParse({ ...valid, extends: "Bad Name" }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...valid, name: "Bad" }).success).toBe(false);
  });

  it("rejects wrong kind, missing checks and extra keys", () => {
    expect(ProfileSchema.safeParse({ ...valid, kind: "Plan" }).success).toBe(false);
    const { checks: _c, ...noChecks } = valid;
    expect(ProfileSchema.safeParse(noChecks).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...valid, guards: [] }).success).toBe(false);
  });
});
