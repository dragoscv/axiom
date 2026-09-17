import { z } from "zod";
import { CheckRefSchema } from "./check.js";
import { ApiVersionSchema } from "./plan.js";

export const ProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const ProfileLimitsSchema = z
  .object({
    maxArtifacts: z.int().positive(),
    maxTotalBytes: z.int().positive(),
    maxBlobBytes: z.int().positive(),
  })
  .strict()
  .partial();

export const ProfileFactsSchema = z
  .object({
    allowRepo: z.boolean().default(true),
    allowGuards: z.boolean().default(false),
  })
  .strict();

export const ProfileSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    kind: z.literal("Profile"),
    name: ProfileNameSchema,
    extends: ProfileNameSchema.optional(),
    checks: z.array(CheckRefSchema),
    limits: ProfileLimitsSchema.default({}),
    // prefault (not default) so the inner defaults are applied when `facts` is omitted
    facts: ProfileFactsSchema.prefault({}),
  })
  .strict();

export type ProfileLimits = z.infer<typeof ProfileLimitsSchema>;
export type ProfileFacts = z.infer<typeof ProfileFactsSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileInput = z.input<typeof ProfileSchema>;
