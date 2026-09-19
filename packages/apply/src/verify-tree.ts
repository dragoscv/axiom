/**
 * `axiom verify --tree <root> <bundle>` (S-403, D-20): does the tree under `root` match what the
 * manifest says it wrote?
 *
 * Scope is the manifest's own paths (D-20 A): every artifact must be present with the declared
 * digest (`create`/`overwrite`) or absent (`delete`). With `--pre`, the *pre-image* set from
 * S-402 is verified instead — "is this the tree the manifest was compiled against?" — which is
 * what a PR gate wants before it applies. A whole-root digest was rejected (D-20) because it
 * breaks on every unrelated commit.
 *
 * Pure read: never takes the lock, never touches `.axiom/`.
 */
import * as path from "node:path";
import {
  AxiomError,
  type DigestRef,
  type ManifestBundle,
  ManifestBundleSchema,
} from "@codai/axiom-schema";
import { resolveContained } from "./contain.js";
import { fileDigestOrAbsent } from "./fsx.js";
import { realpathNative } from "./realpath.js";

export interface TreeMismatch {
  path: string;
  op: string;
  expected: string;
  actual: string;
}

export interface VerifyTreeResult {
  ok: boolean;
  manifestDigest: DigestRef;
  root: string;
  /** Which state was checked: the post-apply artifacts or the declared pre-image. */
  tree: "post" | "pre";
  /** Every path that was compared, with the digest found (or `absent`). */
  paths: Array<{ path: string; op: string; sha256: string }>;
  mismatches: TreeMismatch[];
  /** `pre` requested but the manifest carries no `preImage` (compiled without a root). */
  preImageMissing?: true;
}

export interface VerifyTreeOptions {
  /** Verify the manifest's declared `preImage` set instead of the post-apply artifacts. */
  pre?: boolean;
}

export async function verifyTree(
  rootArg: string,
  bundleInput: unknown,
  opts: VerifyTreeOptions = {},
): Promise<VerifyTreeResult> {
  const parsed = ManifestBundleSchema.safeParse(bundleInput);
  if (!parsed.success) {
    throw new AxiomError("ERR_INVALID_MANIFEST", "bundle does not match schema", {
      details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
    });
  }
  const bundle: ManifestBundle = parsed.data;
  let root: string;
  try {
    root = await realpathNative(path.resolve(rootArg));
  } catch (err) {
    throw new AxiomError("ERR_ROOT_NOT_DIR", "root does not exist", {
      cause: err,
      details: { root: rootArg },
    });
  }
  if (process.platform === "win32" && root.startsWith("\\\\?\\")) root = root.slice(4);

  const tree: "post" | "pre" = opts.pre === true ? "pre" : "post";
  const expected: Array<{ path: string; op: string; sha256: string }> = [];
  if (tree === "pre") {
    if (bundle.manifest.preImage === undefined) {
      return {
        ok: false,
        manifestDigest: bundle.manifestDigest,
        root,
        tree,
        paths: [],
        mismatches: [],
        preImageMissing: true,
      };
    }
    const ops = new Map(bundle.manifest.artifacts.map((a) => [a.path, a.op]));
    for (const p of bundle.manifest.preImage) {
      expected.push({ path: p.path, op: ops.get(p.path) ?? "create", sha256: p.sha256 });
    }
  } else {
    for (const a of bundle.manifest.artifacts) {
      expected.push({
        path: a.path,
        op: a.op,
        sha256: a.op === "delete" ? "absent" : (a.digest?.sha256 ?? "absent"),
      });
    }
  }

  const paths: VerifyTreeResult["paths"] = [];
  const mismatches: TreeMismatch[] = [];
  for (const e of expected) {
    let actual: string;
    try {
      const { abs } = await resolveContained(root, e.path);
      actual = await fileDigestOrAbsent(abs);
    } catch (err) {
      // Symlink in the path, containment escape, …: the tree is not what the manifest describes.
      actual = err instanceof AxiomError ? err.code : "error";
    }
    paths.push({ path: e.path, op: e.op, sha256: actual });
    if (actual !== e.sha256) {
      mismatches.push({ path: e.path, op: e.op, expected: e.sha256, actual });
    }
  }
  return {
    ok: mismatches.length === 0,
    manifestDigest: bundle.manifestDigest,
    root,
    tree,
    paths,
    mismatches,
  };
}
