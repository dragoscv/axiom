import { z } from "zod";

/** Repo-relative location of the single v3 policy file (D-42). */
export const AXIOM_CONFIG_PATH = ".axiom/axiom.json" as const;

/** Highest `version` of `.axiom/axiom.json` this release understands. */
export const AXIOM_CONFIG_VERSION = 3;

/**
 * `.axiom/axiom.json` (3.0, D-42): one file for the gate policy (`gate`, validated by the gate
 * itself) and the check profile (`checks`, the `Profile` fields without `apiVersion`/`kind`).
 *
 * Deliberately NOT strict: unknown keys must be reported and ignored so a file written for a
 * newer 3.x keeps working on an older one (D-42). The file never participates in a digest.
 * `extends` entries: `./relative.json`, `axiom:default|strict|permissive`, or an npm package
 * (`@codai/axiom-pack-<name>`; other scopes only with `allowNpmPacks`).
 */
export const AxiomConfigFileSchema = z.looseObject({
  $schema: z.string().optional(),
  version: z.int().positive().optional(),
  extends: z.array(z.string().min(1)).max(32).optional(),
  /** Allow `extends` to resolve npm packages outside the `@codai` scope (root file only). */
  allowNpmPacks: z.boolean().optional(),
  gate: z.record(z.string(), z.unknown()).optional(),
  checks: z.record(z.string(), z.unknown()).optional(),
});

export type AxiomConfigFile = z.infer<typeof AxiomConfigFileSchema>;
