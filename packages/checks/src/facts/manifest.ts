import {
  blobByteLength,
  INLINE_CONTENT_MAX,
  type ManifestBundle,
  type ProfileLimits,
} from "@codai/axiom-schema";
import type { ContentReader, ManifestFacts } from "../types.js";

/** File extension including the dot, lowercase; `""` when none. */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function deriveManifestFacts(bundle: ManifestBundle): ManifestFacts {
  const byExt: Record<string, number> = {};
  let totalBytes = 0;
  let hasDeletes = false;
  const paths: string[] = [];
  for (const a of bundle.manifest.artifacts) {
    paths.push(a.path);
    totalBytes += a.bytes ?? 0;
    if (a.op === "delete") hasDeletes = true;
    const ext = extOf(a.path);
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  /** Presence only — verification is the job of `manifest.requireSigned`. */
  const signed =
    (bundle.signatures !== undefined && bundle.signatures.length > 0) ||
    (bundle.envelope !== undefined && bundle.envelope.signatures.length > 0);
  return {
    artifactCount: bundle.manifest.artifacts.length,
    totalBytes,
    paths,
    byExt,
    hasDeletes,
    signed,
  };
}

/** One size/limit problem of a bundle, turned into a provider finding by `runChecks`. */
export interface SizeIssue {
  code: string;
  message: string;
  path?: string;
  facts: Record<string, unknown>;
}

/**
 * A1-8: `bytes` is mandatory for every non-delete artifact and is verified against the content
 * the bundle actually carries (the declared size used to be trusted, and `profile.limits` was
 * read by nothing), every inline blob is capped at {@link INLINE_CONTENT_MAX}, and the profile's
 * `limits` are enforced. Content that is unavailable is skipped here — the content predicates
 * report it as `ERR_BLOB_MISSING`, so a bundle without blobs still fails the run.
 */
export async function verifyContentSizes(
  bundle: ManifestBundle,
  limits: ProfileLimits,
  read: ContentReader,
): Promise<SizeIssue[]> {
  const out: SizeIssue[] = [];
  for (const [ref, blob] of Object.entries(bundle.blobs)) {
    const bytes = blobByteLength(blob);
    if (bytes > INLINE_CONTENT_MAX) {
      out.push({
        code: "ERR_BLOB_TOO_LARGE",
        message: `inline blob ${ref} is ${bytes} bytes, limit ${INLINE_CONTENT_MAX}`,
        facts: { ref, bytes, max: INLINE_CONTENT_MAX },
      });
    }
  }
  let totalBytes = 0;
  for (const a of bundle.manifest.artifacts) {
    if (a.op === "delete") continue;
    if (a.bytes === undefined) {
      out.push({
        code: "ERR_INVALID_MANIFEST",
        message: `artifact "${a.path}" declares no bytes`,
        path: a.path,
        facts: { path: a.path },
      });
      continue;
    }
    totalBytes += a.bytes;
    if (limits.maxBlobBytes !== undefined && a.bytes > limits.maxBlobBytes) {
      out.push({
        code: "ERR_BLOB_TOO_LARGE",
        message: `artifact "${a.path}" is ${a.bytes} bytes, profile limit ${limits.maxBlobBytes}`,
        path: a.path,
        facts: { bytes: a.bytes, max: limits.maxBlobBytes },
      });
    }
    const content = await read(a.path);
    if (content === undefined) continue;
    if (content.length !== a.bytes) {
      out.push({
        code: "ERR_SIZE_MISMATCH",
        message: `artifact "${a.path}" declares ${a.bytes} bytes but its content is ${content.length}`,
        path: a.path,
        facts: { declared: a.bytes, actual: content.length },
      });
    }
  }
  const artifactCount = bundle.manifest.artifacts.length;
  if (limits.maxArtifacts !== undefined && artifactCount > limits.maxArtifacts) {
    out.push({
      code: "ERR_BUNDLE_TOO_LARGE",
      message: `manifest has ${artifactCount} artifacts, profile limit ${limits.maxArtifacts}`,
      facts: { artifactCount, max: limits.maxArtifacts },
    });
  }
  if (limits.maxTotalBytes !== undefined && totalBytes > limits.maxTotalBytes) {
    out.push({
      code: "ERR_BUNDLE_TOO_LARGE",
      message: `manifest totals ${totalBytes} bytes, profile limit ${limits.maxTotalBytes}`,
      facts: { totalBytes, max: limits.maxTotalBytes },
    });
  }
  return out;
}
