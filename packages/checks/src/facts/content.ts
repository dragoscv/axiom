import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDigestRef, sha256Hex } from "@codai/axiom-canon";
import type { ManifestBundle } from "@codai/axiom-schema";
import type { ContentReader } from "../types.js";

function decodeBlob(blob: { encoding: "utf8" | "base64"; data: string }): Uint8Array {
  return blob.encoding === "utf8"
    ? new TextEncoder().encode(blob.data)
    : new Uint8Array(Buffer.from(blob.data, "base64"));
}

/**
 * Resolve artifact bytes by path: inline `blobs` first, then the CAS directory
 * (`<casDir>/sha256/<aa>/<hex>`), re-hashed on read. Never touches the network.
 * Returns `undefined` for deletes, unknown paths, missing or corrupt content.
 */
export function contentReader(bundle: ManifestBundle, casDir?: string): ContentReader {
  const byPath = new Map<string, string>();
  for (const a of bundle.manifest.artifacts) {
    if (a.digest !== undefined) byPath.set(a.path, a.digest.sha256);
  }
  const cache = new Map<string, Promise<Uint8Array | undefined>>();

  const load = async (hex: string): Promise<Uint8Array | undefined> => {
    const ref = `sha256:${hex}` as const;
    const blob = bundle.blobs[ref];
    if (blob !== undefined) {
      const bytes = decodeBlob(blob);
      return sha256Hex(bytes) === hex ? bytes : undefined;
    }
    if (casDir === undefined) return undefined;
    try {
      const file = join(casDir, "sha256", hex.slice(0, 2), hex);
      const bytes = new Uint8Array(await readFile(file));
      return sha256Hex(bytes) === hex ? bytes : undefined;
    } catch {
      return undefined;
    }
  };

  return (path) => {
    const hex = byPath.get(path);
    if (hex === undefined) return Promise.resolve(undefined);
    // Validate the ref shape once; a malformed digest is treated as missing.
    try {
      parseDigestRef(`sha256:${hex}`);
    } catch {
      return Promise.resolve(undefined);
    }
    let p = cache.get(hex);
    if (p === undefined) {
      p = load(hex);
      cache.set(hex, p);
    }
    return p;
  };
}
