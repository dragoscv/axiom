import { describe, expect, it } from "vitest";
import { CheckRefSchema, CheckReportSchema, FindingSchema } from "./check.js";
import { REF_A, REF_B } from "./fixtures.test-helpers.js";

describe("CheckRefSchema", () => {
  it("applies severity default and accepts any JSON params", () => {
    const r = CheckRefSchema.parse({ id: "deny-env", predicate: "path.deny", params: ["**/.env"] });
    expect(r.severity).toBe("error");
    expect(CheckRefSchema.safeParse({ id: "n", predicate: "deps.max", params: 20 }).success).toBe(
      true,
    );
    expect(CheckRefSchema.safeParse({ id: "n", predicate: "x.y", params: null }).success).toBe(
      true,
    );
  });

  it("rejects bad predicate ids, missing params, unknown severity", () => {
    expect(CheckRefSchema.safeParse({ id: "n", predicate: "nodot", params: {} }).success).toBe(
      false,
    );
    expect(CheckRefSchema.safeParse({ id: "n", predicate: "path.deny" }).success).toBe(false);
    expect(
      CheckRefSchema.safeParse({ id: "n", predicate: "path.deny", params: {}, severity: "fatal" })
        .success,
    ).toBe(false);
    expect(CheckRefSchema.safeParse({ id: "", predicate: "path.deny", params: {} }).success).toBe(
      false,
    );
  });
});

describe("FindingSchema", () => {
  it("facts default to {} and path is a RelPath", () => {
    const f = FindingSchema.parse({
      id: "deny-env",
      severity: "error",
      predicate: "path.deny",
      message: "denied",
    });
    expect(f.facts).toEqual({});
    expect(FindingSchema.safeParse({ ...f, path: "../x" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...f, path: "src/.env" }).success).toBe(true);
  });
});

describe("CheckReportSchema", () => {
  const valid = {
    apiVersion: "axiom.dev/v2",
    kind: "CheckReport",
    manifestDigest: REF_A,
    profile: "default",
    verdict: "pass",
    findings: [],
    factsDigest: REF_B,
    durationMs: 12,
    providers: [{ name: "manifest", status: "ok", ms: 3 }],
  };

  it("accepts a passing report", () => {
    expect(CheckReportSchema.safeParse(valid).success).toBe(true);
  });

  it("verdict is a closed enum incl. error", () => {
    expect(CheckReportSchema.safeParse({ ...valid, verdict: "error" }).success).toBe(true);
    expect(CheckReportSchema.safeParse({ ...valid, verdict: "ok" }).success).toBe(false);
  });

  it("rejects negative/float durations and bad provider status", () => {
    expect(CheckReportSchema.safeParse({ ...valid, durationMs: -1 }).success).toBe(false);
    expect(CheckReportSchema.safeParse({ ...valid, durationMs: 1.5 }).success).toBe(false);
    expect(
      CheckReportSchema.safeParse({ ...valid, providers: [{ name: "x", status: "meh", ms: 1 }] })
        .success,
    ).toBe(false);
  });

  it("is strict", () => {
    expect(CheckReportSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
