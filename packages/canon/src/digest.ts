import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.js";

/**
 * Codes canon can raise. Each is a member of `ERROR_CODES` in `@codai/axiom-schema` (canon
 * cannot depend on schema, so the subset is restated here; callers map `code` 1:1 onto
 * `AxiomError`).
 */
export type CanonErrorCode = "ERR_DIGEST_FORMAT" | "ERR_SIGNATURE_INVALID";

/**
 * Typed failure from canon. Extends `TypeError` so pre-existing `instanceof TypeError`
 * handling keeps working.
 */
export class CanonError extends TypeError {
  readonly code: CanonErrorCode;
  constructor(code: CanonErrorCode, message: string) {
    super(message);
    this.name = "CanonError";
    this.code = code;
  }
}

/** `sha256:<64 lowercase hex>` — the content-address form used across AXIOM. */
export type DigestRef = `sha256:${string}`;

/** in-toto DigestSet subset. */
export interface Sha256Digest {
  sha256: string;
}

const HEX64: RegExp = /^[0-9a-f]{64}$/;
const REF: RegExp = /^sha256:([0-9a-f]{64})$/;

/** Lowercase hex sha256 of a UTF-8 string or raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 as an in-toto DigestSet. */
export function sha256Digest(data: string | Uint8Array): Sha256Digest {
  return { sha256: sha256Hex(data) };
}

/** Wrap a hex digest as `sha256:<hex>`. Throws on malformed hex. */
export function digestRef(hex: string): DigestRef {
  if (!HEX64.test(hex)) throw new CanonError("ERR_DIGEST_FORMAT", `invalid sha256 hex: ${hex}`);
  return `sha256:${hex}`;
}

/** Extract the hex from a `sha256:<hex>` ref. Throws on bad format. */
export function parseDigestRef(ref: string): string {
  const m = REF.exec(ref);
  const hex = m?.[1];
  if (hex === undefined) throw new CanonError("ERR_DIGEST_FORMAT", `invalid digest ref: ${ref}`);
  return hex;
}

/** sha256 of the JCS form — the hash used for manifests, plans and facts. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** `sha256:` ref of the JCS form. */
export function canonicalDigestRef(value: unknown): DigestRef {
  return digestRef(canonicalHash(value));
}

/**
 * True iff `text` is already in canonical form, i.e.
 * `canonicalize(JSON.parse(text)) === text`. Returns false (never throws)
 * on invalid JSON or non-canonicalizable content.
 */
export function verifyCanonical(text: string): boolean {
  try {
    return canonicalize(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}
