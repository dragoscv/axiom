import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { isAxiomError } from "@codai/axiom-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { contentReader } from "./content.js";
import { deriveManifestFacts, extOf } from "./manifest.js";
import { currentPreImage } from "./preimage.js";
import { createRepoFacts } from "./repo.js";

describe("manifest facts", () => {
  it("derives counts, bytes, byExt, deletes, signed", () => {
    const b = makeBundle([
      { path: "a.ts", content: "abc" },
      { path: "dir/b.TS", content: "de" },
      { path: "Makefile", content: "" },
      { path: "gone.md", op: "delete" },
    ]);
    const f = deriveManifestFacts(b);
    expect(f.artifactCount).toBe(4);
    expect(f.totalBytes).toBe(5);
    expect(f.byExt).toEqual({ ".ts": 2, "": 1, ".md": 1 });
    expect(f.hasDeletes).toBe(true);
    expect(f.signed).toBe(false);
    expect(f.paths).toEqual(["Makefile", "a.ts", "dir/b.TS", "gone.md"]);
  });
  it("extOf", () => {
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("x/.env.local")).toBe(".local");
    expect(extOf("a.tar.gz")).toBe(".gz");
  });
});

describe("content reader", () => {
  let cas: string;
  beforeAll(async () => {
    cas = await mkdtemp(join(tmpdir(), "axiom-cas-"));
  });
  afterAll(async () => {
    await rm(cas, { recursive: true, force: true });
  });
  it("reads inline blobs and rejects digest mismatch", async () => {
    const b = makeBundle([{ path: "a.txt", content: "hello" }]);
    const read = contentReader(b);
    expect(new TextDecoder().decode(await read("a.txt"))).toBe("hello");
    expect(await read("missing.txt")).toBeUndefined();
    const key = Object.keys(b.blobs)[0]!;
    const tampered = { ...b, blobs: { [key]: { encoding: "utf8" as const, data: "HELLO" } } };
    expect(await contentReader(tampered)("a.txt")).toBeUndefined();
  });
  it("falls back to CAS and re-hashes", async () => {
    const b = makeBundle([{ path: "big.bin", content: "cas-content", noBlob: true }]);
    expect(await contentReader(b)("big.bin")).toBeUndefined();
    const hex = sha256Hex("cas-content");
    await mkdir(join(cas, "sha256", hex.slice(0, 2)), { recursive: true });
    await writeFile(join(cas, "sha256", hex.slice(0, 2), hex), "cas-content");
    expect(new TextDecoder().decode(await contentReader(b, cas)("big.bin"))).toBe("cas-content");
    await writeFile(join(cas, "sha256", hex.slice(0, 2), hex), "corrupt");
    expect(await contentReader(b, cas)("big.bin")).toBeUndefined();
  });
});

describe("repo facts", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-repo-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(root, ".gitignore"), "# c\n*.log\nbuild/\n/top-only.txt\n");
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "deep", "x.ts"), "0123456789");
    await writeFile(join(root, "src", "debug.log"), "");
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build", "out.js"), "");
    await mkdir(join(root, "node_modules", "m"), { recursive: true });
    await writeFile(join(root, "node_modules", "m", "index.js"), "");
    await writeFile(join(root, "top-only.txt"), "");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "top-only.txt"), "");
    await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("exists / read / read(max)", async () => {
    const r = await createRepoFacts(root);
    expect(await r.exists("src/deep/x.ts")).toBe(true);
    expect(await r.exists("nope")).toBe(false);
    expect(await r.exists("../etc/passwd")).toBe(false);
    expect(new TextDecoder().decode(await r.read("src/deep/x.ts"))).toBe("0123456789");
    expect(new TextDecoder().decode(await r.read("src/deep/x.ts", 4))).toBe("0123");
    expect(await r.read("src")).toBeUndefined();
  });
  it("glob respects skip dirs and .gitignore", async () => {
    const r = await createRepoFacts(root);
    const all = await r.glob("**");
    expect(all).toContain("src/deep/x.ts");
    expect(all).toContain("sub/top-only.txt");
    expect(all).toContain("package.json");
    expect(all).not.toContain("src/debug.log");
    expect(all).not.toContain("build/out.js");
    expect(all).not.toContain("node_modules/m/index.js");
    expect(all).not.toContain("top-only.txt");
    expect(all.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(await r.glob("src/**/*.ts")).toEqual(["src/deep/x.ts"]);
  });
  it("packageJson and gitHead without spawning", async () => {
    const r = await createRepoFacts(root);
    expect(r.packageJson).toEqual({ name: "fixture" });
    expect(r.gitHead).toBe("a".repeat(40));
    expect(r.gitDirty).toBeUndefined();
  });
  it("detached HEAD and missing .git", async () => {
    await writeFile(join(root, ".git", "HEAD"), `${"b".repeat(40)}\n`);
    expect((await createRepoFacts(root)).gitHead).toBe("b".repeat(40));
    const empty = await mkdtemp(join(tmpdir(), "axiom-empty-"));
    const r = await createRepoFacts(empty);
    expect(r.gitHead).toBeUndefined();
    expect(r.packageJson).toBeUndefined();
    expect(await r.glob("**")).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });
});

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

describe("repo facts / pre-image never cross a symlink or junction out of the root", () => {
  let outside: string;
  let root: string;
  beforeAll(async () => {
    outside = await mkdtemp(join(tmpdir(), "axiom-out-"));
    root = await mkdtemp(join(tmpdir(), "axiom-in-"));
    await writeFile(join(outside, "secret.txt"), "TOPSECRET\n");
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "ok.txt"), "ok");
    await symlink(outside, join(root, "link"), LINK_TYPE);
    await symlink(join(root, "real"), join(root, "inlink"), LINK_TYPE);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("read / exists through an escaping junction throw ERR_CONTAINMENT (fail closed)", async () => {
    const r = await createRepoFacts(root);
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return "resolved";
      } catch (e) {
        return isAxiomError(e) ? e.code : "plain";
      }
    };
    expect(await codeOf(r.read("link/secret.txt"))).toBe("ERR_CONTAINMENT");
    expect(await codeOf(r.exists("link/secret.txt"))).toBe("ERR_CONTAINMENT");
    expect(await codeOf(r.exists("link/missing.txt"))).toBe("ERR_CONTAINMENT");
    // An in-root link is fine.
    expect(new TextDecoder().decode(await r.read("inlink/ok.txt"))).toBe("ok");
  });

  it("repo.noOverwriteOf over an escaping junction → verdict error, not pass", async () => {
    const report = await runChecks({
      bundle: makeBundle([{ path: "link/secret.txt", op: "overwrite", content: "x" }]),
      profile: profileWith([
        {
          id: "protect",
          predicate: "repo.noOverwriteOf",
          params: { globs: ["**/secret.txt"] },
          severity: "error",
        },
      ]),
      root,
    });
    expect(report.verdict).toBe("error");
    expect(report.findings.some((f) => f.facts.code === "ERR_PROVIDER_FAILED")).toBe(true);
  });

  it("currentPreImage: a symlink/junction segment is non-file:symlink (apply parity)", async () => {
    expect(await currentPreImage(root, "link/secret.txt")).toBe("non-file:symlink");
    expect(await currentPreImage(root, "link")).toBe("non-file:symlink");
    expect(await currentPreImage(root, "real")).toBe("non-file:dir");
    expect(await currentPreImage(root, "real/ok.txt")).toBe(sha256Hex("ok"));
    expect(await currentPreImage(root, "real/none.txt")).toBe("absent");
    expect(await currentPreImage(root, "real/ok.txt/below")).toBe("absent");
  });
});
