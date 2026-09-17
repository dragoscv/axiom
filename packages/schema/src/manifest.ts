import { z } from "zod";
import { CheckRefSchema } from "./check.js";
import { DigestRefSchema, DigestSchema } from "./digest.js";
import { RelPathSchema } from "./path.js";
import { ApiVersionSchema, ArtifactModeSchema, ArtifactOpSchema, PlanNameSchema } from "./plan.js";

/** Whole-bundle inline blob budget (§2.5). */
export const BUNDLE_BLOB_BYTES_MAX = 4 * 1024 * 1024;

/**
 * Compare two strings by UTF-8 byte order. Code-point order equals UTF-8 byte
 * order, whereas plain `<` compares UTF-16 code units (wrong around surrogates).
 */
export function compareUtf8(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done && nb.done) return 0;
    if (na.done) return -1;
    if (nb.done) return 1;
    const ca = na.value.codePointAt(0) ?? 0;
    const cb = nb.value.codePointAt(0) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

function isSortedUnique(keys: readonly string[]): boolean {
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1];
    const cur = keys[i];
    if (prev === undefined || cur === undefined) return false;
    if (compareUtf8(prev, cur) >= 0) return false;
  }
  return true;
}

export const ManifestArtifactSchema = z
  .object({
    path: RelPathSchema,
    op: ArtifactOpSchema,
    mode: ArtifactModeSchema,
    /** Absent only for `delete`. */
    digest: DigestSchema.optional(),
    bytes: z.int().nonnegative().optional(),
    origin: z.enum(["inline", "template", "cas", "ref"]).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.op !== "delete" && a.digest === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "digest is required unless op is delete",
        params: { code: "ERR_INVALID_MANIFEST" },
      });
    }
  });

export const ToolchainSchema = z
  .object({
    axiom: z.string().min(1),
    emitters: z.record(z.string(), z.string()),
  })
  .strict();

/** The exact object that is JCS-canonicalised and sha256-hashed into `manifestDigest`. */
export const ManifestBodySchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal("Manifest"),
    name: PlanNameSchema,
    profile: z.string().min(1),
    /** sha256(JCS(Plan with sources replaced by digests)). */
    planDigest: DigestRefSchema,
    /** Sorted by path in UTF-8 byte order, unique. */
    artifacts: z.array(ManifestArtifactSchema).min(1).max(2000),
    /** Sorted by id, unique (§2.4 determinism). */
    checks: z.array(CheckRefSchema),
    toolchain: ToolchainSchema,
  })
  .strict()
  .superRefine((m, ctx) => {
    if (!isSortedUnique(m.artifacts.map((a) => a.path))) {
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "artifacts must be sorted by path (UTF-8 byte order) and unique",
        params: { code: "ERR_NOT_CANONICAL" },
      });
    }
    if (!isSortedUnique(m.checks.map((c) => c.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["checks"],
        message: "checks must be sorted by id (UTF-8 byte order) and unique",
        params: { code: "ERR_NOT_CANONICAL" },
      });
    }
  });

export const BlobSchema = z
  .object({
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
  })
  .strict();

/** Decoded byte size of a blob without allocating the decoded buffer. */
export function blobByteLength(blob: { encoding: "utf8" | "base64"; data: string }): number {
  if (blob.encoding === "utf8") return new TextEncoder().encode(blob.data).length;
  // Strip whitespace and padding; each 4 base64 chars encode 3 bytes.
  const unpadded = blob.data.replace(/\s+/g, "").replace(/=+$/, "");
  return Math.floor((unpadded.length * 3) / 4);
}

/** in-toto Statement is loosely typed here; `@codai/axiom-canon` owns the strict builder. */
export const InTotoStatementLooseSchema = z
  .object({
    _type: z.literal("https://in-toto.io/Statement/v1"),
    subject: z.array(z.object({ name: z.string(), digest: DigestSchema }).strict()).min(1),
    predicateType: z.url(),
    predicate: z.record(z.string(), z.unknown()),
  })
  .strict();

/** DSSE envelope (secure-systems-lab/dsse v1.0.2). */
export const DsseEnvelopeSchema = z
  .object({
    payloadType: z.literal("application/vnd.in-toto+json"),
    payload: z.base64(),
    signatures: z.array(z.object({ keyid: z.string().optional(), sig: z.base64() }).strict()),
  })
  .strict();

/** What moves between tools. NOT hashed as a whole — only `manifest` is. */
export const ManifestBundleSchema = z
  .object({
    manifest: ManifestBodySchema,
    manifestDigest: DigestRefSchema,
    attestation: InTotoStatementLooseSchema.optional(),
    envelope: DsseEnvelopeSchema.optional(),
    /** Inline side-channel keyed by `sha256:<hex>`. */
    blobs: z.record(DigestRefSchema, BlobSchema).default({}),
  })
  .strict()
  .superRefine((b, ctx) => {
    let total = 0;
    for (const blob of Object.values(b.blobs)) total += blobByteLength(blob);
    if (total > BUNDLE_BLOB_BYTES_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["blobs"],
        message: `bundle blobs total ${total} bytes exceeds ${BUNDLE_BLOB_BYTES_MAX}`,
        params: { code: "ERR_BUNDLE_TOO_LARGE", total, max: BUNDLE_BLOB_BYTES_MAX },
      });
    }
  });

export type ManifestArtifact = z.infer<typeof ManifestArtifactSchema>;
export type Toolchain = z.infer<typeof ToolchainSchema>;
export type ManifestBody = z.infer<typeof ManifestBodySchema>;
export type Blob = z.infer<typeof BlobSchema>;
export type InTotoStatementLoose = z.infer<typeof InTotoStatementLooseSchema>;
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;
export type ManifestBundle = z.infer<typeof ManifestBundleSchema>;
export type ManifestBundleInput = z.input<typeof ManifestBundleSchema>;
