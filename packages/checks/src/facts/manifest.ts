import type { ManifestBundle } from "@codai/axiom-schema";
import type { ManifestFacts } from "../types.js";

/** File extension including the dot, lowercase; `""` when none. */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function deriveManifestFacts(bundle: ManifestBundle): ManifestFacts {
  const byExt: Record<string, number> = {};
  let totalBytes = 0;
  let hasDeletes = false;
  const paths: string[] = [];
  for (const a of bundle.manifest.artifacts) {
    paths.push(a.path);
    totalBytes += a.bytes ?? 0;
    if (a.op === "delete") hasDeletes = true;
    const ext = extOf(a.path);
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  const signed = bundle.envelope !== undefined && bundle.envelope.signatures.length > 0;
  return {
    artifactCount: bundle.manifest.artifacts.length,
    totalBytes,
    paths,
    byExt,
    hasDeletes,
    signed,
  };
}
