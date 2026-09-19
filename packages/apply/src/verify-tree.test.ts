import fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalDigestRef, sha256Hex } from "@codai/axiom-canon";
import { describe, expect, it } from "vitest";
import { apply } from "./apply.js";
import { makeBundle, mkRoot, writeTree } from "./test-helpers.js";
import { verifyTree } from "./verify-tree.js";

describe("verifyTree (S-403, D-20)", () => {
  it("post: ok after apply; a hand edit, a missing file or a resurrected delete are mismatches", async () => {
    const root = await mkRoot();
    await writeTree(root, { "old.txt": "bye", "keep.txt": "k" });
    const bundle = makeBundle([
      { path: "src/a.ts", content: "a" },
      { path: "old.txt", op: "delete" },
    ]);
    // Before apply: the tree is NOT what the manifest describes.
    const before = await verifyTree(root, bundle);
    expect(before.ok).toBe(false);
    expect(before.tree).toBe("post");
    expect(before.mismatches.map((m) => `${m.path}:${m.expected}->${m.actual}`)).toEqual([
      `old.txt:absent->${sha256Hex("bye")}`,
      `src/a.ts:${sha256Hex("a")}->absent`,
    ]);

    const r = await apply({ bundle, root, mode: "fs", confirmDigest: bundle.manifestDigest });
    expect(r.status).toBe("applied");
    const after = await verifyTree(root, bundle);
    expect(after.ok).toBe(true);
    expect(after.mismatches).toEqual([]);
    expect(after.paths).toEqual([
      { path: "old.txt", op: "delete", sha256: "absent" },
      { path: "src/a.ts", op: "create", sha256: sha256Hex("a") },
    ]);
    // Unrelated files do not matter (D-20: manifest paths only).
    await writeTree(root, { "keep.txt": "changed", "unrelated.md": "x" });
    expect((await verifyTree(root, bundle)).ok).toBe(true);

    await writeTree(root, { "src/a.ts": "edited" });
    const drifted = await verifyTree(root, bundle);
    expect(drifted.ok).toBe(false);
    expect(drifted.mismatches).toEqual([
      { path: "src/a.ts", op: "create", expected: sha256Hex("a"), actual: sha256Hex("edited") },
    ]);
    await writeTree(root, { "src/a.ts": "a", "old.txt": "back" });
    expect((await verifyTree(root, bundle)).mismatches.map((m) => m.path)).toEqual(["old.txt"]);
  });

  it("pre: verifies the declared pre-image set; without preImage → preImageMissing", async () => {
    const root = await mkRoot();
    await writeTree(root, { "cfg.json": "{}" });
    const bundle = makeBundle([{ path: "cfg.json", content: '{"v":2}', op: "overwrite" }]);
    const noPre = await verifyTree(root, bundle, { pre: true });
    expect(noPre).toMatchObject({ ok: false, tree: "pre", preImageMissing: true, paths: [] });

    const manifest = {
      ...bundle.manifest,
      preImage: [{ path: "cfg.json", sha256: sha256Hex("{}") }],
    };
    const bound = { ...bundle, manifest, manifestDigest: canonicalDigestRef(manifest) };
    const pre = await verifyTree(root, bound, { pre: true });
    expect(pre.ok).toBe(true);
    expect(pre.paths).toEqual([{ path: "cfg.json", op: "overwrite", sha256: sha256Hex("{}") }]);
    // post-state on the same tree is NOT ok yet (not applied)
    expect((await verifyTree(root, bound)).ok).toBe(false);
    await writeTree(root, { "cfg.json": "someone else" });
    const bad = await verifyTree(root, bound, { pre: true });
    expect(bad.ok).toBe(false);
    expect(bad.mismatches[0]).toMatchObject({ path: "cfg.json", expected: sha256Hex("{}") });
  });

  it("a symlink or directory where the manifest expects a file is a mismatch with the error code as `actual`", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "d/f.txt", content: "f" }]);
    await fs.mkdir(path.join(root, "d", "f.txt"), { recursive: true });
    const r = await verifyTree(root, bundle);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0]?.actual).toMatch(/^non-file:|^ERR_/);
  });

  it("ERR_INVALID_MANIFEST for a non-bundle; ERR_ROOT_NOT_DIR for a missing root; never touches .axiom", async () => {
    const root = await mkRoot();
    await expect(verifyTree(root, { nope: true })).rejects.toMatchObject({
      code: "ERR_INVALID_MANIFEST",
    });
    const bundle = makeBundle([{ path: "x", content: "x" }]);
    await expect(verifyTree(path.join(root, "missing"), bundle)).rejects.toMatchObject({
      code: "ERR_ROOT_NOT_DIR",
    });
    await verifyTree(root, bundle);
    await expect(fs.stat(path.join(root, ".axiom"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
