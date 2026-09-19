/**
 * Closed set of error codes. Tests and callers assert on codes, never on message text.
 * `erasableSyntaxOnly` forbids `enum`, so this is a readonly tuple + derived union.
 */
export const ERROR_CODES = [
  // paths
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
  // content
  "ERR_BLOB_MISSING",
  "ERR_DIGEST_FORMAT",
  "ERR_DIGEST_MISMATCH",
  "ERR_SIZE_MISMATCH",
  "ERR_BLOB_TOO_LARGE",
  "ERR_BUNDLE_TOO_LARGE",
  // apply / roots
  "ERR_LOCKED",
  "ERR_ROOT_NOT_ALLOWED",
  "ERR_ROOT_REQUIRED",
  "ERR_ROOT_NOT_DIR",
  "ERR_CONFIRM_DIGEST_MISMATCH",
  "ERR_CHECKS_FAILED",
  "ERR_PREIMAGE_CHANGED",
  "ERR_JOURNAL_CORRUPT",
  "ERR_EBUSY",
  // schema
  "ERR_INVALID_PLAN",
  "ERR_INVALID_MANIFEST",
  "ERR_INVALID_PROFILE",
  // checks
  "ERR_PREDICATE_UNKNOWN",
  "ERR_PREDICATE_PARAMS",
  "ERR_PROVIDER_FAILED",
  "ERR_GUARD_TIMEOUT",
  "ERR_GUARD_OUTPUT",
  /** A fact provider / predicate is disabled by the profile or a CLI gate (`--allow-guards`). */
  "ERR_FACT_DISABLED",
  // signing (D-16)
  "ERR_SIGNATURE_MISSING",
  "ERR_SIGNATURE_INVALID",
  /** Anti-rollback state file (`.axiom/trust/state.json`) unreadable or fails schema. */
  "ERR_TRUST_STATE_CORRUPT",
  /** Rollback of a partially committed apply itself failed; the tree may be inconsistent. */
  "ERR_ROLLBACK",
  // template sources
  "ERR_EMITTER_UNKNOWN",
  "ERR_TEMPLATE_UNKNOWN",
  "ERR_TEMPLATE_PARAMS",
  // patch sources (D-17)
  /** Patch body is not parseable in the declared format. */
  "ERR_PATCH_FORMAT",
  /** The file under the root does not hash to the declared `preImage`. */
  "ERR_PATCH_PREIMAGE",
  /** A hunk's context / search block did not match exactly once. */
  "ERR_PATCH_NO_MATCH",
  // git (PR mode)
  "ERR_GIT_NOT_FOUND",
  "ERR_GIT_NOT_REPO",
  "ERR_GIT_DIRTY",
  "ERR_GIT_BRANCH_EXISTS",
  "ERR_GIT_BRANCH_INVALID",
  "ERR_GIT_FAILED",
  // transport
  "ERR_REF_OFFLINE",
  "ERR_NET_DISABLED",
  "ERR_NET_DENIED",
  "ERR_NET_FAILED",
  "ERR_NOT_CANONICAL",
  "ERR_UNSUPPORTED_OP",
  "ERR_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

export interface AxiomErrorOptions {
  path?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AxiomError extends Error {
  readonly code: ErrorCode;
  readonly path: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, options: AxiomErrorOptions = {}) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AxiomError";
    this.code = code;
    this.path = options.path;
    this.details = options.details;
  }

  toJSON(): { code: ErrorCode; message: string; path?: string; details?: Record<string, unknown> } {
    const out: {
      code: ErrorCode;
      message: string;
      path?: string;
      details?: Record<string, unknown>;
    } = { code: this.code, message: this.message };
    if (this.path !== undefined) out.path = this.path;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function isAxiomError(value: unknown): value is AxiomError {
  return (
    value instanceof AxiomError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "AxiomError" &&
      isErrorCode((value as { code?: unknown }).code))
  );
}
