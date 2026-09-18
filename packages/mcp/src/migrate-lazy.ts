/**
 * Lazy-loaded `axiom migrate v1` entry. Built by tsdown as its own self-contained chunk
 * (`dist/migrate-lazy.js`, own copy of schema/zod/plan/canon) and reached only via
 * `import("./migrate-lazy.js")` from `cli-main.ts`, so the eager `cli.js + cli-main.js` budget
 * pays nothing for the v1 migration code path.
 */
export {
  type Dropped,
  findClockKeys,
  MIGRATE_TOOL,
  type MigrateOptions,
  type MigrateReport,
  type MigrateResult,
  type MigrationMetadata,
  migrateV1,
  normaliseV1Path,
  type V1Manifest,
  V1ManifestSchema,
} from "./migrate.js";
