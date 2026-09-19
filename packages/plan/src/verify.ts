import { canonicalDigestRef, sha256Hex } from "@codai/axiom-canon";
import {
  type DigestRef,
  type ErrorCode,
  isErrorCode,
  ManifestBundleSchema,
} from "@codai/axiom-schema";
import { decodeBlob } from "./blob.js";

export interface VerifyError {
  code: ErrorCode;
  message: string;
  path?: string;
}

export interface VerifyResult {
  ok: boolean;
  manifestDigest?: DigestRef;
  /** Manifest is sorted/unique per §2.4 and `manifestDigest` equals sha256(JCS(manifest)). */
  canonical: boolean;
  /**
   * Always `false` here: structural verification has no trust store. Signature
   * verification needs a root (`.axiom/trust/keys.json`) and is layered on top by
   * `axiom verify --root` / `axiom_manifest_verify` (mcp `keys.ts`) and by the
   * `signature.*` predicates in `@codai/axiom-checks`.
   */
  signed: false;
  /** Artifacts whose digest has no inline blob. Not an error — apply resolves via CAS/ref. */
  missing: string[];
  errors: VerifyError[];
}

function issueCode(params: unknown): ErrorCode {
  const code = (params as { code?: unknown } | undefined)?.code;
  return isErrorCode(code) ? code : "ERR_INVALID_MANIFEST";
}

/**
 * Structural + content-address verification of a bundle. Never throws.
 * Checks: schema, recomputed manifest digest, every blob hashes to its key,
 * attestation subject names the manifest.
 */
export function verifyBundle(input: unknown): VerifyResult {
  const errors: VerifyError[] = [];
  const parsed = ManifestBundleSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: issueCode((issue as { params?: unknown }).params),
        message: issue.message,
        path: issue.path.map(String).join("."),
      });
    }
    return { ok: false, canonical: false, signed: false, missing: [], errors };
  }
  const bundle = parsed.data;

  const recomputed = canonicalDigestRef(bundle.manifest);
  const canonical = recomputed === bundle.manifestDigest;
  if (!canonical) {
    errors.push({
      code: "ERR_DIGEST_MISMATCH",
      message: `manifestDigest ${bundle.manifestDigest} does not match sha256(JCS(manifest)) ${recomputed}`,
      path: "manifestDigest",
    });
  }

  for (const [key, blob] of Object.entries(bundle.blobs)) {
    let actual: string;
    try {
      actual = `sha256:${sha256Hex(decodeBlob(blob))}`;
    } catch (err) {
      errors.push({
        code: "ERR_INVALID_MANIFEST",
        message: `blob ${key} cannot be decoded: ${(err as Error).message}`,
        path: `blobs.${key}`,
      });
      continue;
    }
    if (actual !== key) {
      errors.push({
        code: "ERR_DIGEST_MISMATCH",
        message: `blob ${key} hashes to ${actual}`,
        path: `blobs.${key}`,
      });
    }
  }

  const missing: string[] = [];
  for (const a of bundle.manifest.artifacts) {
    if (a.digest === undefined) continue;
    if (!(`sha256:${a.digest.sha256}` in bundle.blobs)) missing.push(a.path);
  }

  const subject = bundle.attestation?.subject[0];
  if (subject !== undefined && `sha256:${subject.digest.sha256}` !== bundle.manifestDigest) {
    errors.push({
      code: "ERR_DIGEST_MISMATCH",
      message: "attestation subject does not name this manifest",
      path: "attestation.subject.0",
    });
  }

  return {
    ok: errors.length === 0,
    manifestDigest: bundle.manifestDigest,
    canonical,
    signed: false,
    missing,
    errors,
  };
}
