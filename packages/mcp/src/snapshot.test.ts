import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigestRef } from "@codai/axiom-canon";
import { RepoSnapshotSchema } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffSnapshots, snapshotRoot } from "./snapshot.js";
import { harness, structured, textOf, tmpRepo } from "./test-helpers.js";

const IS_WIN = process.platform === "win32";

async function fixture(root: string): Promise<void> {
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, ".axiom"), { recursive: true });
  await writeFile(join(root, "README.md"), "# hi\n");
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "src", "z.log"), "ignored by gitignore\n");
  await writeFile(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, ".axiom", "lock"), "x");
  await writeFile(join(root, ".gitignore"), "node_modules/\n*.log\n# comment\n!keep.log\n");
}

describe("snapshotRoot", () => {
  let repo: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    repo = await tmpRepo("axiom-snap-");
    await fixture(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("inventories files with sha256, skips .git/.axiom and .gitignore matches, validates against the schema", async () => {
    const snap = await snapshotRoot(repo.root);
    expect(RepoSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.body.files.map((f) => f.path)).toEqual([
      ".gitignore",
      "README.md",
      "src/a.ts",
      "src/deep/b.ts",
    ]);
    const a = snap.body.files.find((f) => f.path === "src/a.ts");
    expect(a).toMatchObject({ bytes: 20, kind: "file", mode: "0644" });
    expect(a?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.body.counts).toEqual({
      files: 4,
      bytes: snap.body.files.reduce((n, f) => n + f.bytes, 0),
    });
    expect(snap.body.truncated).toBe(false);
    expect(snap.snapshotDigest).toBe(canonicalDigestRef(snap.body));
    expect(JSON.stringify(snap)).not.toContain(repo.root.replaceAll("\\", "\\\\"));
  });

  it("is deterministic across runs and changes when a file is added or edited", async () => {
    const one = await snapshotRoot(repo.root);
    const two = await snapshotRoot(repo.root);
    expect(two).toStrictEqual(one);
    await writeFile(join(repo.root, "src", "c.ts"), "3");
    const three = await snapshotRoot(repo.root);
    expect(three.snapshotDigest).not.toBe(one.snapshotDigest);
    await writeFile(join(repo.root, "src", "a.ts"), "export const a = 2;\n");
    const four = await snapshotRoot(repo.root);
    expect(four.snapshotDigest).not.toBe(three.snapshotDigest);
    expect(four.body.counts.files).toBe(three.body.counts.files);
  });

  it("respectGitignore:false includes ignored files but never .git/.axiom", async () => {
    const snap = await snapshotRoot(repo.root, { respectGitignore: false });
    const paths = snap.body.files.map((f) => f.path);
    expect(paths).toContain("src/z.log");
    expect(paths).toContain("node_modules/dep/index.js");
    expect(paths.some((p) => p.startsWith(".git/") || p.startsWith(".axiom/"))).toBe(false);
  });

  it("include/exclude globs filter; withContentDigest:false omits sha256", async () => {
    const inc = await snapshotRoot(repo.root, { include: ["src/**"], withContentDigest: false });
    expect(inc.body.files.map((f) => f.path)).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(inc.body.files.every((f) => f.sha256 === undefined)).toBe(true);
    const exc = await snapshotRoot(repo.root, { exclude: ["src/deep/**", "*.md"] });
    expect(exc.body.files.map((f) => f.path)).toEqual([".gitignore", "src/a.ts"]);
  });

  it("maxFiles cap → truncated:true with the deterministic sorted prefix", async () => {
    const full = await snapshotRoot(repo.root);
    const capped = await snapshotRoot(repo.root, { maxFiles: 2 });
    expect(capped.body.truncated).toBe(true);
    expect(capped.body.files).toEqual(full.body.files.slice(0, 2));
    expect(capped.body.counts.files).toBe(2);
    const bytesCapped = await snapshotRoot(repo.root, { maxBytes: 10 });
    expect(bytesCapped.body.truncated).toBe(true);
    expect(bytesCapped.body.counts.bytes).toBeLessThanOrEqual(10);
  });

  it("rejects globs that escape the root and followSymlinks:true", async () => {
    await expect(snapshotRoot(repo.root, { include: ["../**"] })).rejects.toMatchObject({
      code: "ERR_CONTAINMENT",
    });
    await expect(snapshotRoot(repo.root, { exclude: ["/etc/*"] })).rejects.toMatchObject({
      code: "ERR_CONTAINMENT",
    });
    await expect(snapshotRoot(repo.root, { followSymlinks: true })).rejects.toMatchObject({
      code: "ERR_UNSUPPORTED_OP",
    });
  });

  it.skipIf(IS_WIN)(
    "records symlinks: inside → target digest, outside → no digest; 0755 → mode",
    async () => {
      const outside = await tmpRepo("axiom-snap-out-");
      try {
        await writeFile(join(outside.root, "secret.txt"), "top secret");
        await symlink(join(outside.root, "secret.txt"), join(repo.root, "leak"));
        await symlink(join(repo.root, "src", "a.ts"), join(repo.root, "alias"));
        await symlink(join(repo.root, "nope"), join(repo.root, "dangling"));
        await chmod(join(repo.root, "src", "a.ts"), 0o755);
        const snap = await snapshotRoot(repo.root);
        expect(RepoSnapshotSchema.safeParse(snap).success).toBe(true);
        const by = new Map(snap.body.files.map((f) => [f.path, f]));
        const a = by.get("src/a.ts");
        expect(a?.mode).toBe("0755");
        expect(by.get("alias")).toEqual({
          path: "alias",
          bytes: a?.bytes,
          sha256: a?.sha256,
          mode: "0755",
          kind: "symlink",
        });
        expect(by.get("leak")).toEqual({ path: "leak", bytes: 0, mode: "0644", kind: "symlink" });
        expect(by.get("dangling")).toEqual({
          path: "dangling",
          bytes: 0,
          mode: "0644",
          kind: "symlink",
        });
        expect(JSON.stringify(snap)).not.toContain("top secret");
      } finally {
        await outside.cleanup();
      }
    },
  );
});

describe("diffSnapshots", () => {
  it("reports added, removed and changed paths in code-point order", async () => {
    const repo = await tmpRepo("axiom-snap-diff-");
    try {
      await fixture(repo.root);
      const a = await snapshotRoot(repo.root);
      await writeFile(join(repo.root, "src", "a.ts"), "changed");
      await writeFile(join(repo.root, "new.txt"), "n");
      await writeFile(join(repo.root, "Z.txt"), "z");
      await (await import("node:fs/promises")).rm(join(repo.root, "README.md"));
      const b = await snapshotRoot(repo.root);
      const d = diffSnapshots(a, b);
      expect(d.added).toEqual(["Z.txt", "new.txt"]);
      expect(d.removed).toEqual(["README.md"]);
      expect(d.changed).toHaveLength(1);
      expect(d.changed[0]?.path).toBe("src/a.ts");
      expect(d.changed[0]?.from).toBe(a.body.files.find((f) => f.path === "src/a.ts")?.sha256);
      expect(d.changed[0]?.to).toBe(b.body.files.find((f) => f.path === "src/a.ts")?.sha256);
      expect(diffSnapshots(a, a)).toEqual({ added: [], removed: [], changed: [] });
    } finally {
      await repo.cleanup();
    }
  });
});

describe("axiom_repo_snapshot (MCP)", () => {
  it("returns a schema-valid snapshot with a summarized text projection; rejects roots outside the allowlist", async () => {
    const repo = await tmpRepo("axiom-snap-mcp-");
    const other = await tmpRepo("axiom-snap-other-");
    const h = await harness([repo.root]);
    try {
      await fixture(repo.root);
      const r = await h.call("axiom_repo_snapshot", { include: ["src/**"] });
      expect(r.isError).not.toBe(true);
      const snap = structured<{ snapshotDigest: string; body: { counts: { files: number } } }>(r);
      expect(RepoSnapshotSchema.safeParse(snap).success).toBe(true);
      expect(snap.body.counts.files).toBe(2);
      const text = JSON.parse(textOf(r)) as {
        snapshotDigest: string;
        paths: string[];
        counts: unknown;
      };
      expect(text.snapshotDigest).toBe(snap.snapshotDigest);
      expect(text.paths).toEqual(["src/a.ts", "src/deep/b.ts"]);
      const denied = await h.call("axiom_repo_snapshot", { root: other.root });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("ERR_ROOT_NOT_ALLOWED");
      const bad = await h.call("axiom_repo_snapshot", { include: ["../x"] });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain("ERR_CONTAINMENT");
    } finally {
      await h.close();
      await repo.cleanup();
      await other.cleanup();
    }
  });
});
