import { describe, expect, it } from "vitest";
import { AppliedFileSchema, ApplyResultSchema, JournalSchema } from "./apply.js";
import { HEX_A, REF_A } from "./fixtures.test-helpers.js";

const validResult = {
  apiVersion: "axiom.dev/v2",
  kind: "ApplyResult",
  manifestDigest: REF_A,
  mode: "fs",
  status: "applied",
  root: "E:\\gh\\proj",
  files: [{ path: "src/a.ts", op: "create", digest: { sha256: HEX_A }, status: "written" }],
  journal: ".axiom/journal/x.json",
};

describe("ApplyResultSchema", () => {
  it("accepts applied / noop / dry-run results", () => {
    expect(ApplyResultSchema.safeParse(validResult).success).toBe(true);
    expect(ApplyResultSchema.safeParse({ ...validResult, status: "noop", files: [] }).success).toBe(
      true,
    );
    expect(
      ApplyResultSchema.safeParse({ ...validResult, mode: "dry-run", diff: "--- a\n+++ b\n" })
        .success,
    ).toBe(true);
  });

  it("failed requires an error with a known code", () => {
    expect(ApplyResultSchema.safeParse({ ...validResult, status: "failed" }).success).toBe(false);
    expect(
      ApplyResultSchema.safeParse({
        ...validResult,
        status: "failed",
        error: { code: "ERR_CONTAINMENT", message: "escapes root", path: "a/b" },
      }).success,
    ).toBe(true);
    expect(
      ApplyResultSchema.safeParse({
        ...validResult,
        status: "failed",
        error: { code: "ERR_MADE_UP", message: "x" },
      }).success,
    ).toBe(false);
  });

  it("git block validates commit sha and compareUrl", () => {
    const git = { branch: "axiom/hello/abcdef123456", commit: "0".repeat(40) };
    expect(ApplyResultSchema.safeParse({ ...validResult, mode: "pr", git }).success).toBe(true);
    expect(
      ApplyResultSchema.safeParse({ ...validResult, git: { ...git, commit: "abc" } }).success,
    ).toBe(false);
    expect(
      ApplyResultSchema.safeParse({ ...validResult, git: { ...git, compareUrl: "nope" } }).success,
    ).toBe(false);
  });

  it("is strict and mode/status are closed enums", () => {
    expect(ApplyResultSchema.safeParse({ ...validResult, mode: "yolo" }).success).toBe(false);
    expect(ApplyResultSchema.safeParse({ ...validResult, status: "partial" }).success).toBe(false);
    expect(ApplyResultSchema.safeParse({ ...validResult, extra: 1 }).success).toBe(false);
  });
});

describe("AppliedFileSchema", () => {
  it("validates status enum and RelPath", () => {
    expect(
      AppliedFileSchema.safeParse({ path: "a", op: "delete", status: "deleted" }).success,
    ).toBe(true);
    expect(AppliedFileSchema.safeParse({ path: "a", op: "delete", status: "gone" }).success).toBe(
      false,
    );
    expect(
      AppliedFileSchema.safeParse({ path: "/a", op: "create", status: "written" }).success,
    ).toBe(false);
  });
});

describe("JournalSchema", () => {
  const valid = {
    manifestDigest: REF_A,
    phase: "staged",
    steps: [
      { path: "src/a.ts", op: "create", done: false },
      { path: "src/b.ts", op: "overwrite", backup: ".axiom/backup/x/src/b.ts", done: true },
    ],
    startedAt: "2026-09-18T10:00:00Z",
    pid: 4242,
  };

  it("accepts a valid journal in every phase", () => {
    for (const phase of ["staged", "committing", "committed", "rolling-back", "rolled-back"]) {
      expect(JournalSchema.safeParse({ ...valid, phase }).success).toBe(true);
    }
  });

  it("rejects bad phase, non-ISO startedAt, non-positive pid, extra keys", () => {
    expect(JournalSchema.safeParse({ ...valid, phase: "done" }).success).toBe(false);
    expect(JournalSchema.safeParse({ ...valid, startedAt: "yesterday" }).success).toBe(false);
    expect(JournalSchema.safeParse({ ...valid, startedAt: 1700000000 }).success).toBe(false);
    expect(JournalSchema.safeParse({ ...valid, pid: 0 }).success).toBe(false);
    expect(JournalSchema.safeParse({ ...valid, hostname: "x" }).success).toBe(false);
  });

  it("steps require done boolean and valid op", () => {
    expect(
      JournalSchema.safeParse({ ...valid, steps: [{ path: "a", op: "create" }] }).success,
    ).toBe(false);
    expect(
      JournalSchema.safeParse({ ...valid, steps: [{ path: "a", op: "move", done: true }] }).success,
    ).toBe(false);
  });
});
