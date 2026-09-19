import { z } from "zod";
import { DigestRefSchema, DigestSchema } from "./digest.js";
import { ERROR_CODES } from "./errors.js";
import { RelPathSchema } from "./path.js";
import { ApiVersionSchema, ArtifactOpSchema } from "./plan.js";

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const AppliedFileSchema = z
  .object({
    path: RelPathSchema,
    op: ArtifactOpSchema,
    digest: DigestSchema.optional(),
    status: z.enum(["written", "deleted", "unchanged", "skipped"]),
  })
  .strict();

export const ApplyErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string(),
    path: RelPathSchema.optional(),
  })
  .strict();

export const GitResultSchema = z
  .object({
    branch: z.string().min(1),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    compareUrl: z.url().optional(),
  })
  .strict();

export const ApplyResultSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal("ApplyResult"),
    manifestDigest: DigestRefSchema,
    mode: z.enum(["dry-run", "fs", "pr"]),
    status: z.enum(["applied", "noop", "rolled-back", "failed"]),
    /** Absolute, realpath'd, as authorised. */
    root: z.string().min(1),
    files: z.array(AppliedFileSchema),
    /** Unified diff (dry-run), capped at 1 MiB by the engine. */
    diff: z.string().optional(),
    /** Path of `.axiom/journal/<digest>.json`. */
    journal: z.string().optional(),
    git: GitResultSchema.optional(),
    /**
     * Re-apply of an already-applied digest whose files no longer matched on disk:
     * the artifacts listed here were re-written over foreign changes (design §apply).
     */
    drifted: z.array(RelPathSchema).optional(),
    error: ApplyErrorSchema.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.status === "failed" && r.error === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required when status is failed",
      });
    }
  });

export const JournalPhaseSchema = z.enum([
  "staged",
  "committing",
  "committed",
  "rolling-back",
  "rolled-back",
]);

export const JournalStepSchema = z
  .object({
    path: RelPathSchema,
    op: ArtifactOpSchema,
    backup: z.string().optional(),
    done: z.boolean(),
  })
  .strict();

/** `.axiom/journal/<digest>.json` — written and fsynced before phase 2 (§4.2). */
export const JournalSchema = z
  .object({
    manifestDigest: DigestRefSchema,
    phase: JournalPhaseSchema,
    steps: z.array(JournalStepSchema),
    startedAt: z.iso.datetime(),
    pid: z.int().positive(),
  })
  .strict();

export type AppliedFile = z.infer<typeof AppliedFileSchema>;
export type ApplyError = z.infer<typeof ApplyErrorSchema>;
export type GitResult = z.infer<typeof GitResultSchema>;
export type ApplyResult = z.infer<typeof ApplyResultSchema>;
export type JournalPhase = z.infer<typeof JournalPhaseSchema>;
export type JournalStep = z.infer<typeof JournalStepSchema>;
export type Journal = z.infer<typeof JournalSchema>;
