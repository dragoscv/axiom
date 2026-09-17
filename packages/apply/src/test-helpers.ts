import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalDigestRef, sha256Hex } from "@codai/axiom-canon";
import {
  API_VERSION,
  type ArtifactOp,
  compareUtf8,
  type DigestRef,
  type ManifestArtifact,
  type ManifestBundle,
  toDigestRef,
} from "@codai/axiom-schema";
import { realpathNative } from "./realpath.js";

export interface SpecFile {
  path: string;
  content?: string | Uint8Array;
  op?: ArtifactOp;
  mode?: "0644" | "0755";
}

export async function mkRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "axiom-apply-"));
  return realpathNative(dir);
}

export function bytesOf(c: string | Uint8Array): Uint8Array {
  return typeof c === "string" ? new TextEncoder().encode(c) : c;
}

/** Builds a canonical bundle: artifacts sorted by path (UTF-8 order), blobs keyed by DigestRef. */
export function makeBundle(
  files: SpecFile[],
  opts: { name?: string; omitBlobs?: string[] } = {},
): ManifestBundle {
  const blobs: Record<DigestRef, { encoding: "utf8" | "base64"; data: string }> = {};
  const artifacts: ManifestArtifact[] = files.map((f) => {
    const op = f.op ?? "create";
    const a: ManifestArtifact = { path: f.path, op, mode: f.mode ?? "0644" };
    if (op !== "delete") {
      const b = bytesOf(f.content ?? "");
      const hex = sha256Hex(b);
      a.digest = { sha256: hex };
      a.bytes = b.byteLength;
      a.origin = "inline";
      if (!(opts.omitBlobs ?? []).includes(f.path)) {
        blobs[toDigestRef(hex)] =
          typeof f.content === "string" || f.content === undefined
            ? { encoding: "utf8", data: f.content ?? "" }
            : { encoding: "base64", data: Buffer.from(b).toString("base64") };
      }
    }
    return a;
  });
  artifacts.sort((x, y) => compareUtf8(x.path, y.path));
  const manifest: ManifestBundle["manifest"] = {
    apiVersion: API_VERSION,
    kind: "Manifest",
    name: opts.name ?? "test",
    profile: "default",
    planDigest: toDigestRef(sha256Hex("plan")),
    artifacts,
    checks: [],
    toolchain: { axiom: "2.0.0", emitters: {} },
  };
  return { manifest, manifestDigest: canonicalDigestRef(manifest), blobs };
}

/** Recursive snapshot of a tree as relPath → sha256 (skips `.axiom/`). */
export async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (r === ".axiom") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) out.set(r, sha256Hex(await fs.readFile(p)));
    }
  }
  await walk(root, "");
  return out;
}

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split("/"));
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

export async function readText(root: string, rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split("/")), "utf8");
}

export async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}
