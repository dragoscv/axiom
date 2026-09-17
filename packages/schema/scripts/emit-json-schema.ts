/**
 * Emits schemas/<Name>.schema.json (JSON Schema draft 2020-12) from the Zod schemas.
 * Run: pnpm --filter @codai/axiom-schema build:jsonschema
 * The generated files are committed; CI diffs them to catch drift.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ApplyResultSchema,
  CheckReportSchema,
  JournalSchema,
  ManifestBodySchema,
  ManifestBundleSchema,
  PlanSchema,
  ProfileSchema,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schemas");
mkdirSync(outDir, { recursive: true });

const targets: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["Plan", PlanSchema],
  ["Manifest", ManifestBodySchema],
  ["ManifestBundle", ManifestBundleSchema],
  ["CheckReport", CheckReportSchema],
  ["ApplyResult", ApplyResultSchema],
  ["Profile", ProfileSchema],
  ["Journal", JournalSchema],
];

for (const [name, schema] of targets) {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });
  const doc = {
    $id: `https://axiom.dev/schemas/v2/${name}.schema.json`,
    title: name,
    ...json,
  };
  const file = join(outDir, `${name}.schema.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8" });
  console.error(`wrote ${file}`);
}
