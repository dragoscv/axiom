import { z } from "zod";
import { CheckRefSchema } from "./check.js";
import { DigestRefSchema, DigestSchema, Sha256HexSchema } from "./digest.js";
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
    origin: z.enum(["inline", "template", "cas", "ref", "patch"]).optional(),
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

/**
 * What compile saw on disk for one artifact path (S-402): the sha256 of the existing file
 * or `absent`. Binds a manifest — and every CheckReport/attestation over it — to the tree
 * it was produced against; `apply` refuses a different tree with `ERR_PREIMAGE_CHANGED`.
 */
export const PreImageEntrySchema = z
  .object({
    path: RelPathSchema,
    sha256: z.union([Sha256HexSchema, z.literal("absent")]),
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
    /**
     * Anti-rollback counter (D-16): monotonic per root, part of the canonical body so a
     * signature binds it. Verified by `manifest.requireSigned { antiRollback: true }`.
     */
    counter: z.int().nonnegative().optional(),
    /**
     * Pre-image of every artifact path at compile time (S-402), sorted by path, unique;
     * present when compile had a root (or a pre-image reader). Part of the canonical body:
     * the same Plan compiled against a different tree is a different manifest.
     */
    preImage: z.array(PreImageEntrySchema).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.preImage !== undefined && !isSortedUnique(m.preImage.map((p) => p.path))) {
      ctx.addIssue({
        code: "custom",
        path: ["preImage"],
        message: "preImage must be sorted by path (UTF-8 byte order) and unique",
        params: { code: "ERR_NOT_CANONICAL" },
      });
    }
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

/** DSSE envelope (secure-systems-lab/dsse v1.0.2) around an in-toto attestation. */
export const DsseEnvelopeSchema = z
  .object({
    payloadType: z.literal("application/vnd.in-toto+json"),
    payload: z.base64(),
    signatures: z.array(z.object({ keyid: z.string().optional(), sig: z.base64() }).strict()),
  })
  .strict();

/** DSSE payloadType of a signed `ManifestBody` (D-16). */
export const AXIOM_MANIFEST_PAYLOAD_TYPE = "application/vnd.axiom.manifest+json" as const;
/**
 * DSSE payloadType of a **root-bound** signature (S-409): the payload is
 * `JCS({ manifest, rootId })`, so the same key's signature over the same manifest is not
 * valid for a root whose trust store declares a different `rootId`.
 */
export const AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE =
  "application/vnd.axiom.manifest-bound+json" as const;
/** Operator-chosen root identity, e.g. `github:dragoscv/brivio` or a UUID. */
export const RootIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "rootId: letters, digits, . _ : / @ - only");

/**
 * DSSE envelope whose payload is `base64(JCS(manifest))`, signed with Ed25519 (D-16).
 * Lives outside the canonical body: `manifestDigest` is unchanged whether signed or not.
 * With `payloadType` = `AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE` the payload is
 * `base64(JCS({ manifest, rootId }))` (S-409).
 */
export const ManifestSignatureSchema = z
  .object({
    payloadType: z.union([
      z.literal(AXIOM_MANIFEST_PAYLOAD_TYPE),
      z.literal(AXIOM_MANIFEST_BOUND_PAYLOAD_TYPE),
    ]),
    payload: z.base64(),
    signatures: z
      .array(z.object({ keyid: z.string().optional(), sig: z.base64() }).strict())
      .min(1),
  })
  .strict();

/** `.axiom/trust/keys.json` — the per-root allowlist of signing keys (D-16). */
export const TrustedKeySchema = z
  .object({
    /** sha256(raw 32-byte public key), lowercase hex. */
    keyid: z.string().regex(/^[0-9a-f]{64}$/),
    alg: z.literal("ed25519"),
    /** base64 of the raw 32-byte Ed25519 public key. */
    publicKey: z.base64(),
    name: z.string().min(1).max(200).optional(),
    /** Lowest manifest `counter` this key may sign for. */
    notBefore: z.int().nonnegative().optional(),
  })
  .strict();

export const TrustStoreSchema = z
  .object({
    version: z.literal(1),
    keys: z.array(TrustedKeySchema),
    /** Floor for `counter` when no state has been recorded yet. */
    minCounter: z.int().nonnegative().optional(),
    /**
     * When set, only root-bound signatures carrying this exact id count (S-409): an
     * unbound or differently-bound envelope is `signature.unbound`. Absent → both accepted.
     */
    rootId: RootIdSchema.optional(),
  })
  .strict();

/** `.axiom/trust/state.json` — last accepted counter for this root (D-16). */
export const TrustStateSchema = z
  .object({
    version: z.literal(1),
    lastCounter: z.int().nonnegative(),
    /** Digest of the manifest that advanced `lastCounter` (informational). */
    manifestDigest: DigestRefSchema.optional(),
    /**
     * HMAC-SHA256 (hex) over `JCS(state without mac)` keyed by `.axiom/trust/state.key`
     * (S-409). Written by every `advanceTrustState`; a state with a key on disk but a
     * missing/wrong mac is `ERR_TRUST_STATE_CORRUPT`.
     */
    mac: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

/** What moves between tools. NOT hashed as a whole — only `manifest` is. */
export const ManifestBundleSchema = z
  .object({
    manifest: ManifestBodySchema,
    manifestDigest: DigestRefSchema,
    attestation: InTotoStatementLooseSchema.optional(),
    envelope: DsseEnvelopeSchema.optional(),
    /** Detached DSSE signatures over `manifest` (D-16). Not part of `manifestDigest`. */
    signatures: z.array(ManifestSignatureSchema).optional(),
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
export type PreImageEntry = z.infer<typeof PreImageEntrySchema>;
export type ManifestBody = z.infer<typeof ManifestBodySchema>;
export type Blob = z.infer<typeof BlobSchema>;
export type InTotoStatementLoose = z.infer<typeof InTotoStatementLooseSchema>;
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;
export type ManifestSignature = z.infer<typeof ManifestSignatureSchema>;
export type TrustedKey = z.infer<typeof TrustedKeySchema>;
export type TrustStore = z.infer<typeof TrustStoreSchema>;
export type TrustState = z.infer<typeof TrustStateSchema>;
export type ManifestBundle = z.infer<typeof ManifestBundleSchema>;
export type ManifestBundleInput = z.input<typeof ManifestBundleSchema>;
