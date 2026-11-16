import { z } from "zod";
import { DigestRefSchema, DigestSchema, Sha256HexSchema } from "./digest.js";
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
    /**
     * Machine-readable context for the code (e.g. `ERR_CONFLICT` → `{ otherDigest, paths }`,
     * `ERR_LOCKED` → `{ holder, waitedMs, queuePosition }`). Branch on `code`, read `details`.
     */
    details: z.record(z.string(), z.unknown()).optional(),
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
    /**
     * Dry-run only: journals still in `staged` / `committing` / `rolling-back` when the preview
     * ran. A dry-run never runs crash recovery (it is annotated read-only), it reports them.
     */
    interrupted: z.array(DigestRefSchema).optional(),
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

/** Every journal backup lives under this prefix (the engine adds `<digest hex>/<path>`). */
export const JOURNAL_BACKUP_PREFIX = ".axiom/backup/";

/**
 * The stored backup path is `.axiom/backup/<digest hex>/<artifact path>`, which is longer than
 * `RelPathSchema` allows whenever the artifact path approaches its own 1024-char cap (A1-11: a
 * 962-char path yields a 1041-char backup path and made the journal unreadable). It has its own
 * cap. 4.0 no longer stores it at all — it is derivable — so this schema exists to keep reading
 * 3.x journals.
 */
export const JOURNAL_BACKUP_PATH_MAX_LENGTH = 2048;

// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are exactly what we reject
const BACKUP_PATH_INVALID_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;

/**
 * A step's `backup` is a relative POSIX path under `.axiom/backup/` — never absolute, never `..`,
 * never a backslash. The engine additionally pins it to
 * `.axiom/backup/<this journal's hex>/<step.path>` at rollback.
 */
export const JournalBackupPathSchema = z
  .string()
  .min(JOURNAL_BACKUP_PREFIX.length + 1)
  .max(JOURNAL_BACKUP_PATH_MAX_LENGTH)
  .superRefine((p, ctx) => {
    const fail = (why: string): void => {
      ctx.addIssue({ code: "custom", message: "ERR_JOURNAL_CORRUPT", params: { why } });
    };
    if (!p.startsWith(JOURNAL_BACKUP_PREFIX)) return fail("prefix");
    if (p.includes("\\")) return fail("separator");
    if (BACKUP_PATH_INVALID_CHARS.test(p)) return fail("char");
    if (p !== p.normalize("NFC")) return fail("nfc");
    if (
      p
        .split("/")
        .some((s) => s === "" || s === "." || s === ".." || s.endsWith(".") || s.endsWith(" "))
    ) {
      return fail("segment");
    }
  })
  .describe("Relative POSIX path under .axiom/backup/ (own length cap)");

export const JournalStepSchema = z
  .object({
    path: RelPathSchema,
    op: ArtifactOpSchema,
    /**
     * Legacy (<=3.0) field: the engine derives the backup path from the digest and no longer
     * writes it. Read for compatibility; a value that is not the derived path is tampering.
     */
    backup: JournalBackupPathSchema.optional(),
    /** sha256 of the target before commit, or `absent` (recorded before phase 2). */
    preImage: z.union([Sha256HexSchema, z.literal("absent")]).optional(),
    /** sha256 the commit writes (create/overwrite); rollback's drift check compares against it. */
    postImage: Sha256HexSchema.optional(),
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
