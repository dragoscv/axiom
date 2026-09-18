import { describe, expect, it } from "vitest";
import { ErrorCodeSchema } from "./apply.js";
import { AxiomError, ERROR_CODES, isAxiomError, isErrorCode } from "./errors.js";

const REQUIRED = [
  "ERR_PATH_NOT_RELATIVE_POSIX",
  "ERR_PATH_SEGMENT",
  "ERR_PATH_NOT_NFC",
  "ERR_PATH_RESERVED_NAME",
  "ERR_PATH_INVALID_CHAR",
  "ERR_PATH_CASE_COLLISION",
  "ERR_SYMLINK_IN_PATH",
  "ERR_CONTAINMENT",
  "ERR_TARGET_TYPE",
  "ERR_EXISTS",
  "ERR_NOT_FOUND",
  "ERR_BLOB_MISSING",
  "ERR_DIGEST_MISMATCH",
  "ERR_SIZE_MISMATCH",
  "ERR_BLOB_TOO_LARGE",
  "ERR_BUNDLE_TOO_LARGE",
  "ERR_LOCKED",
  "ERR_ROOT_NOT_ALLOWED",
  "ERR_ROOT_REQUIRED",
  "ERR_ROOT_NOT_DIR",
  "ERR_CONFIRM_DIGEST_MISMATCH",
  "ERR_CHECKS_FAILED",
  "ERR_PREIMAGE_CHANGED",
  "ERR_JOURNAL_CORRUPT",
  "ERR_EBUSY",
  "ERR_INVALID_PLAN",
  "ERR_INVALID_MANIFEST",
  "ERR_INVALID_PROFILE",
  "ERR_PREDICATE_UNKNOWN",
  "ERR_PREDICATE_PARAMS",
  "ERR_PROVIDER_FAILED",
  "ERR_GUARD_TIMEOUT",
  "ERR_GUARD_OUTPUT",
  "ERR_SIGNATURE_MISSING",
  "ERR_SIGNATURE_INVALID",
  "ERR_ROLLBACK",
  "ERR_EMITTER_UNKNOWN",
  "ERR_TEMPLATE_UNKNOWN",
  "ERR_TEMPLATE_PARAMS",
  "ERR_REF_OFFLINE",
  "ERR_NET_DISABLED",
  "ERR_NET_DENIED",
  "ERR_NET_FAILED",
  "ERR_NOT_CANONICAL",
  "ERR_UNSUPPORTED_OP",
  "ERR_INTERNAL",
] as const;

describe("ERROR_CODES", () => {
  it("contains every required code", () => {
    for (const code of REQUIRED) expect(ERROR_CODES).toContain(code);
  });

  it("codes are unique and well-formed", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^ERR_[A-Z0-9_]+$/);
  });

  it("isErrorCode guards the closed set", () => {
    expect(isErrorCode("ERR_LOCKED")).toBe(true);
    expect(isErrorCode("ERR_NOPE")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });

  it("ErrorCodeSchema mirrors the tuple", () => {
    expect(ErrorCodeSchema.options).toEqual([...ERROR_CODES]);
  });
});

describe("AxiomError", () => {
  it("carries code, path, details and default message", () => {
    const e = new AxiomError("ERR_CONTAINMENT", undefined, {
      path: "a/b",
      details: { root: "/r" },
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AxiomError");
    expect(e.code).toBe("ERR_CONTAINMENT");
    expect(e.message).toBe("ERR_CONTAINMENT");
    expect(e.path).toBe("a/b");
    expect(e.details).toEqual({ root: "/r" });
    expect(e.toJSON()).toEqual({
      code: "ERR_CONTAINMENT",
      message: "ERR_CONTAINMENT",
      path: "a/b",
      details: { root: "/r" },
    });
  });

  it("preserves cause and omits absent optionals in toJSON", () => {
    const cause = new Error("boom");
    const e = new AxiomError("ERR_INTERNAL", "wrapped", { cause });
    expect(e.cause).toBe(cause);
    expect(e.toJSON()).toEqual({ code: "ERR_INTERNAL", message: "wrapped" });
  });

  it("isAxiomError accepts instances and structural clones", () => {
    expect(isAxiomError(new AxiomError("ERR_EBUSY"))).toBe(true);
    expect(isAxiomError({ name: "AxiomError", code: "ERR_EBUSY", message: "x" })).toBe(true);
    expect(isAxiomError({ name: "AxiomError", code: "ERR_FAKE" })).toBe(false);
    expect(isAxiomError(new Error("plain"))).toBe(false);
    expect(isAxiomError(null)).toBe(false);
  });
});
