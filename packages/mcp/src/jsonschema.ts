import {
  ApplyResultSchema,
  CheckReportSchema,
  JournalSchema,
  ManifestBodySchema,
  ManifestBundleSchema,
  PlanSchema,
  ProfileSchema,
} from "@codai/axiom-schema";
import { z } from "zod";

export const SCHEMA_KINDS = [
  "Plan",
  "Manifest",
  "ManifestBundle",
  "CheckReport",
  "ApplyResult",
  "Profile",
  "Journal",
] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

const BY_KIND: Record<SchemaKind, z.ZodType> = {
  Plan: PlanSchema,
  Manifest: ManifestBodySchema,
  ManifestBundle: ManifestBundleSchema,
  CheckReport: CheckReportSchema,
  ApplyResult: ApplyResultSchema,
  Profile: ProfileSchema,
  Journal: JournalSchema,
};

export function isSchemaKind(v: unknown): v is SchemaKind {
  return typeof v === "string" && (SCHEMA_KINDS as readonly string[]).includes(v);
}

/** Draft 2020-12 JSON Schema, byte-identical to `packages/schema/schemas/<kind>.schema.json`. */
export function jsonSchemaFor(kind: SchemaKind): Record<string, unknown> {
  const json = z.toJSONSchema(BY_KIND[kind], {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });
  return { $id: `https://axiom.dev/schemas/v2/${kind}.schema.json`, title: kind, ...json };
}

/** Compact JSON Schema for tool input/output (spec/tools.json). */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
}
