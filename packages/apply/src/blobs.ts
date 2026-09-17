import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AxiomError,
  type DigestRef,
  type ManifestArtifact,
  type ManifestBundle,
  toDigestRef,
} from "@codai/axiom-schema";
import { errnoCode, nsPath, sha256Of } from "./fsx.js";

export const CAS_BLOB_BYTES_MAX: number = 32 * 1024 * 1024;

export function casPath(casDir: string, hex: string): string {
  return path.join(casDir, "sha256", hex.slice(0, 2), hex);
}

function decodeBlob(blob: { encoding: "utf8" | "base64"; data: string }): Uint8Array {
  return blob.encoding === "utf8"
    ? new TextEncoder().encode(blob.data)
    : new Uint8Array(Buffer.from(blob.data, "base64"));
}

/**
 * §2.5 resolution order: inline `blobs` → CAS → (`ref` → ERR_REF_OFFLINE in v2.0).
 * Always re-hashes and checks declared size.
 */
export async function resolveContent(
  bundle: ManifestBundle,
  artifact: ManifestArtifact,
  casDir?: string,
): Promise<Uint8Array> {
  if (artifact.digest === undefined) {
    throw new AxiomError("ERR_INVALID_MANIFEST", "artifact without digest", {
      path: artifact.path,
    });
  }
  const hex = artifact.digest.sha256;
  const ref: DigestRef = toDigestRef(hex);
  let bytes: Uint8Array | undefined;
  const inline = bundle.blobs[ref];
  if (inline !== undefined) {
    bytes = decodeBlob(inline);
  } else if (casDir !== undefined) {
    const p = casPath(casDir, hex);
    try {
      const st = await fs.lstat(nsPath(p));
      if (st.isFile()) {
        if (st.size > CAS_BLOB_BYTES_MAX) {
          throw new AxiomError("ERR_BLOB_TOO_LARGE", "CAS blob exceeds 32 MiB", {
            path: artifact.path,
            details: { digest: ref, size: st.size },
          });
        }
        bytes = new Uint8Array(await fs.readFile(nsPath(p)));
      }
    } catch (err) {
      if (err instanceof AxiomError) throw err;
      if (errnoCode(err) !== "ENOENT") throw err;
    }
  }
  if (bytes === undefined) {
    if (artifact.origin === "ref") {
      throw new AxiomError("ERR_REF_OFFLINE", "ref sources are not fetched in v2.0", {
        path: artifact.path,
        details: { digest: ref },
      });
    }
    throw new AxiomError("ERR_BLOB_MISSING", "no inline blob or CAS entry for artifact", {
      path: artifact.path,
      details: { digest: ref },
    });
  }
  if (artifact.bytes !== undefined && artifact.bytes !== bytes.byteLength) {
    throw new AxiomError("ERR_SIZE_MISMATCH", "content size differs from manifest", {
      path: artifact.path,
      details: { expected: artifact.bytes, actual: bytes.byteLength },
    });
  }
  const actual = sha256Of(bytes);
  if (actual !== hex) {
    throw new AxiomError("ERR_DIGEST_MISMATCH", "content digest differs from manifest", {
      path: artifact.path,
      details: { expected: hex, actual },
    });
  }
  return bytes;
}
