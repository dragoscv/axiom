import type { z } from "zod";
import type { ManifestBodySchema, ManifestBundleSchema, PlanSchema } from "./index.js";

export const HEX_A = "a".repeat(64);
export const HEX_B = "b".repeat(64);
export const REF_A = `sha256:${HEX_A}` as const;
export const REF_B = `sha256:${HEX_B}` as const;

export function validPlan(): z.input<typeof PlanSchema> {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: "hello-world",
    intent: "Create a greeting module",
    artifacts: [
      { path: "src/hello.ts", source: { type: "inline", content: "export const hi = 1;\n" } },
      { path: "src/old.ts", op: "delete" },
    ],
  };
}

export function validManifest(): z.input<typeof ManifestBodySchema> {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Manifest",
    name: "hello-world",
    profile: "default",
    planDigest: REF_A,
    artifacts: [
      { path: "src/a.ts", op: "create", mode: "0644", digest: { sha256: HEX_A }, bytes: 20 },
      { path: "src/b.ts", op: "delete", mode: "0644" },
    ],
    checks: [],
    toolchain: { axiom: "2.0.0", emitters: {} },
  };
}

export function validBundle(): z.input<typeof ManifestBundleSchema> {
  return {
    manifest: validManifest(),
    manifestDigest: REF_B,
    blobs: { [REF_A]: { encoding: "utf8", data: "export const a = 1;\n" } },
  };
}
