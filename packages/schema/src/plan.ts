import { z } from "zod";
import { CheckRefSchema } from "./check.js";
import { DigestRefSchema } from "./digest.js";
import { RelPathSchema } from "./path.js";

export const API_VERSION = "axiom.dev/v2" as const;
export const ApiVersionSchema = z.literal(API_VERSION);

/** Per-blob inline limit: 256 KiB of string content (≈192 KiB decoded when base64). */
export const INLINE_CONTENT_MAX = 256 * 1024;

export const PlanNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "name must be lowercase kebab-case, ≤ 64 chars");

export const ArtifactModeSchema = z.enum(["0644", "0755"]);
export const ArtifactOpSchema = z.enum(["create", "overwrite", "delete"]);
export const CapabilitySchema = z.enum(["fs", "net", "secret", "ai", "compute", "git"]);

export const PlanArtifactSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("inline"),
      content: z.string().max(INLINE_CONTENT_MAX),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    })
    .strict(),
  z
    .object({
      type: z.literal("cas"),
      digest: DigestRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ref"),
      uri: z.url({ protocol: /^(file|https)$/ }),
      digest: DigestRefSchema,
    })
    .strict(),
  // Template source (D-13, S-207): resolved at compile time by an injected
  // EmitterRegistry (e.g. @codai/axiom-emitters-web); `params` are part of the
  // planDigest, the emitter version only of the manifestDigest. Without a
  // registry entry compile fails with ERR_UNSUPPORTED_OP.
  z
    .object({
      type: z.literal("template"),
      emitter: z.string().min(1),
      template: z.string().min(1),
      params: z.record(z.string(), z.json()).default({}),
    })
    .strict()
    .describe("template source rendered by a registered emitter at compile time"),
  // Patch source (D-17, S-401): the agent ships a diff instead of the whole file.
  // Compile reads the current file under the root, requires its sha256 to equal
  // `preImage` (ERR_PATCH_PREIMAGE), applies the patch with EXACT matching only
  // (ERR_PATCH_NO_MATCH) and content-addresses the result — so Manifest, checks and
  // apply never see a patch, only bytes. Fuzzy matching is deliberately absent: two
  // machines must derive identical content from one Plan.
  z
    .object({
      type: z.literal("patch"),
      format: z.enum(["unified", "v4a", "search-replace"]),
      /** sha256 of the file the patch was authored against, or `absent` for a new file. */
      preImage: z.union([DigestRefSchema, z.literal("absent")]),
      body: z.string().max(INLINE_CONTENT_MAX),
    })
    .strict()
    .describe("patch applied at compile time to the pre-image named by its digest"),
]);

export const PlanArtifactSchema = z
  .object({
    path: RelPathSchema,
    mode: ArtifactModeSchema.default("0644"),
    op: ArtifactOpSchema.default("create"),
    /** Required unless `op === "delete"`, in which case it must be absent. */
    source: PlanArtifactSourceSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.op === "delete" && a.source !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "source must be absent when op is delete",
        params: { code: "ERR_INVALID_PLAN" },
      });
    }
    if (a.op !== "delete" && a.source === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "source is required unless op is delete",
        params: { code: "ERR_INVALID_PLAN" },
      });
    }
  });

export const PlanSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal("Plan"),
    name: PlanNameSchema,
    intent: z.string().max(2000),
    profile: z.string().min(1).default("default"),
    capabilities: z.array(CapabilitySchema).default([]),
    artifacts: z.array(PlanArtifactSchema).min(1).max(2000),
    checks: z.array(CheckRefSchema).default([]),
    /** Anti-rollback counter (D-16); copied verbatim into `ManifestBody.counter`. */
    counter: z.int().nonnegative().optional(),
    metadata: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export type ApiVersion = typeof API_VERSION;
export type ArtifactMode = z.infer<typeof ArtifactModeSchema>;
export type ArtifactOp = z.infer<typeof ArtifactOpSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type PlanArtifactSource = z.infer<typeof PlanArtifactSourceSchema>;
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
export type Plan = z.infer<typeof PlanSchema>;
/** Shape accepted before defaults are applied (what an agent actually sends). */
export type PlanInput = z.input<typeof PlanSchema>;
