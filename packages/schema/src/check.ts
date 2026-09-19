import { z } from "zod";
import { DigestRefSchema } from "./digest.js";
import { RelPathSchema } from "./path.js";

export const SeveritySchema = z.enum(["error", "warn", "info"]);

/** Reference to a registered predicate with its JSON params (§3.1). */
export const CheckRefSchema = z
  .object({
    id: z.string().min(1).max(128),
    predicate: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/, "predicate must be <group>.<name>"),
    params: z.json(),
    severity: SeveritySchema.default("error"),
  })
  .strict();

export const FindingSchema = z
  .object({
    id: z.string(),
    severity: SeveritySchema,
    predicate: z.string(),
    message: z.string(),
    path: RelPathSchema.optional(),
    facts: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export const ProviderStatusSchema = z
  .object({
    name: z.string(),
    status: z.enum(["ok", "skipped", "error"]),
    ms: z.int().nonnegative(),
  })
  .strict();

export const CheckReportSchema = z
  .object({
    apiVersion: z.literal("axiom.dev/v2"),
    kind: z.literal("CheckReport"),
    manifestDigest: DigestRefSchema,
    profile: z.string(),
    /** `error` = a provider/guard could not run; never silently pass. */
    verdict: z.enum(["pass", "fail", "error"]),
    findings: z.array(FindingSchema),
    /** sha256(JCS(all facts)) → replayable. */
    factsDigest: DigestRefSchema,
    durationMs: z.int().nonnegative(),
    providers: z.array(ProviderStatusSchema),
    /**
     * S-402: how the manifest's `preImage` related to the tree at check time.
     * `verified` = every entry matched; `drifted` = at least one differed (an `error`
     * finding `ERR_PREIMAGE_CHANGED` is also emitted); `unverified` = no root, or the
     * manifest carries no `preImage`.
     */
    preImage: z.enum(["verified", "drifted", "unverified"]).optional(),
  })
  .strict();

export type Severity = z.infer<typeof SeveritySchema>;
export type CheckRef = z.infer<typeof CheckRefSchema>;
export type CheckRefInput = z.input<typeof CheckRefSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
export type CheckReport = z.infer<typeof CheckReportSchema>;
