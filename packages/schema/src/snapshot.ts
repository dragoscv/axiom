import { z } from "zod";
import { DigestRefSchema, Sha256HexSchema } from "./digest.js";
import { RelPathSchema } from "./path.js";
import { ApiVersionSchema, ArtifactModeSchema } from "./plan.js";

export const RepoSnapshotEntryKindSchema = z.enum(["file", "symlink"]);

/**
 * One inventory row. `sha256` is absent when content digests were not requested
 * or when the entry is a symlink whose target lies outside the root (never followed).
 */
export const RepoSnapshotEntrySchema = z
  .object({
    path: RelPathSchema,
    bytes: z.int().nonnegative(),
    sha256: Sha256HexSchema.optional(),
    mode: ArtifactModeSchema,
    kind: RepoSnapshotEntryKindSchema,
  })
  .strict();

/** The hashed part: `snapshotDigest = sha256(JCS(body))`. No timestamps, no absolute paths. */
export const RepoSnapshotBodySchema = z
  .object({
    /** Sorted by `compareUtf8(path)`. */
    files: z.array(RepoSnapshotEntrySchema),
    /** True when `maxFiles` or `maxBytes` stopped the walk; `files` is then a prefix of the full order. */
    truncated: z.boolean(),
    counts: z
      .object({
        files: z.int().nonnegative(),
        bytes: z.int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const RepoSnapshotSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal("RepoSnapshot"),
    /** Paths are relative to the walked root; the root itself is deliberately not recorded. */
    root: z.object({ kind: z.literal("relative") }).strict(),
    snapshotDigest: DigestRefSchema,
    body: RepoSnapshotBodySchema,
  })
  .strict();

export type RepoSnapshotEntryKind = z.infer<typeof RepoSnapshotEntryKindSchema>;
export type RepoSnapshotEntry = z.infer<typeof RepoSnapshotEntrySchema>;
export type RepoSnapshotBody = z.infer<typeof RepoSnapshotBodySchema>;
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;
