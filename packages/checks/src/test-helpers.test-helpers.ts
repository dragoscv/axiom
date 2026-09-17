import { canonicalDigestRef, sha256Hex } from "@codai/axiom-canon";
import {
  type ArtifactOp,
  compareUtf8,
  type ManifestArtifact,
  type ManifestBundle,
  ManifestBundleSchema,
  type Profile,
} from "@codai/axiom-schema";

export interface FileSpec {
  path: string;
  content?: string | Uint8Array;
  op?: ArtifactOp;
  /** Omit the blob from the bundle (content unavailable to predicates). */
  noBlob?: boolean;
}

const enc = new TextEncoder();

export function makeBundle(files: FileSpec[], extra: Partial<ManifestBundle> = {}): ManifestBundle {
  const artifacts: ManifestArtifact[] = [];
  const blobs: ManifestBundle["blobs"] = {};
  for (const f of files) {
    const op = f.op ?? "create";
    if (op === "delete") {
      artifacts.push({ path: f.path, op, mode: "0644" });
      continue;
    }
    const bytes =
      typeof f.content === "string" ? enc.encode(f.content) : (f.content ?? new Uint8Array());
    const hex = sha256Hex(bytes);
    artifacts.push({
      path: f.path,
      op,
      mode: "0644",
      digest: { sha256: hex },
      bytes: bytes.length,
      origin: "inline",
    });
    if (!f.noBlob) {
      blobs[`sha256:${hex}`] =
        typeof f.content === "string"
          ? { encoding: "utf8", data: f.content }
          : { encoding: "base64", data: Buffer.from(bytes).toString("base64") };
    }
  }
  artifacts.sort((a, b) => compareUtf8(a.path, b.path));
  const manifest: ManifestBundle["manifest"] = {
    apiVersion: "axiom.dev/v2",
    kind: "Manifest",
    name: "test",
    profile: "default",
    planDigest: canonicalDigestRef({ test: true }),
    artifacts,
    checks: [],
    toolchain: { axiom: "2.0.0", emitters: {} },
  };
  const bundle: ManifestBundle = {
    manifest,
    manifestDigest: canonicalDigestRef(manifest),
    blobs,
    ...extra,
  };
  return ManifestBundleSchema.parse(bundle);
}

export function profileWith(
  checks: Profile["checks"],
  facts: Partial<Profile["facts"]> = {},
): Profile {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Profile",
    name: "test",
    checks,
    limits: {},
    facts: { allowRepo: true, allowGuards: false, ...facts },
  };
}
