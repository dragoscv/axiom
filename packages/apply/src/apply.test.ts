import fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import type { CheckReport, ManifestBundle } from "@codai/axiom-schema";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appliedPath, apply, rollback } from "./apply.js";
import { acquireLock } from "./lock.js";
import {
  exists,
  makeBundle,
  mkRoot,
  readText,
  type SpecFile,
  snapshot,
  writeTree,
} from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fsApply(
  bundle: ManifestBundle,
  root: string,
  extra: Partial<Parameters<typeof apply>[0]> = {},
) {
  return apply({ bundle, root, mode: "fs", confirmDigest: bundle.manifestDigest, ...extra });
}

describe("apply happy path", () => {
  it("creates 2 files, overwrites 1, deletes 1; journal + applied marker written; staging cleaned", async () => {
    const root = await mkRoot();
    await writeTree(root, { "keep.txt": "keep", "old.txt": "bye", "over.txt": "v1" });
    const bundle = makeBundle([
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { path: "src/b.ts", content: "export const b = 2;\n", mode: "0755" },
      { path: "over.txt", content: "v2", op: "overwrite" },
      { path: "old.txt", op: "delete" },
    ]);
    const r = await fsApply(bundle, root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("applied");
    expect(r.files.map((f) => `${f.op}:${f.path}:${f.status}`)).toEqual([
      "delete:old.txt:deleted",
      "overwrite:over.txt:written",
      "create:src/a.ts:written",
      "create:src/b.ts:written",
    ]);
    expect(await readText(root, "src/a.ts")).toBe("export const a = 1;\n");
    expect(await readText(root, "over.txt")).toBe("v2");
    expect(await exists(root, "old.txt")).toBe(false);
    expect(await readText(root, "keep.txt")).toBe("keep");
    expect(await exists(root, `.axiom/staging/${bundle.manifestDigest.slice(7)}`)).toBe(false);
    expect(await exists(root, `.axiom/journal/${bundle.manifestDigest.slice(7)}.json`)).toBe(true);
    expect(await exists(root, `.axiom/applied/${bundle.manifestDigest.slice(7)}.json`)).toBe(true);
    expect(await exists(root, ".axiom/lock")).toBe(false);
    // backup of pre-images kept
    expect(await readText(root, `.axiom/backup/${bundle.manifestDigest.slice(7)}/old.txt`)).toBe(
      "bye",
    );
    expect(await readText(root, `.axiom/backup/${bundle.manifestDigest.slice(7)}/over.txt`)).toBe(
      "v1",
    );
  });

  it("second apply of the same bundle is a noop", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "x.txt", content: "x" }]);
    expect((await fsApply(bundle, root)).status).toBe("applied");
    const r2 = await fsApply(bundle, root);
    expect(r2.status).toBe("noop");
    expect(r2.files[0]?.status).toBe("unchanged");
  });

  it("re-applies when marker exists but an overwrite target drifted; reports `drifted`", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "x.txt", content: "x", op: "overwrite" }]);
    await fsApply(bundle, root);
    await writeTree(root, { "x.txt": "drifted" });
    const r = await fsApply(bundle, root);
    expect(r.status).toBe("applied");
    expect(r.drifted).toEqual(["x.txt"]);
    expect(await readText(root, "x.txt")).toBe("x");
  });

  it("drifted re-apply of a `create` proceeds (design §apply), backs up the foreign bytes, and does not ERR_EXISTS", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([
      { path: "gen/a.txt", content: "a" },
      { path: "gen/b.txt", content: "b" },
    ]);
    expect((await fsApply(bundle, root)).status).toBe("applied");
    // Somebody edited one generated file by hand after the apply.
    await writeTree(root, { "gen/a.txt": "hand-edited" });
    const r = await fsApply(bundle, root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("applied");
    expect(r.drifted).toEqual(["gen/a.txt"]);
    expect(r.files.map((f) => `${f.path}:${f.status}`)).toEqual([
      "gen/a.txt:written",
      "gen/b.txt:written",
    ]);
    expect(await readText(root, "gen/a.txt")).toBe("a");
    // The foreign pre-image is recoverable, exactly like an overwrite's.
    expect(await readText(root, `.axiom/backup/${bundle.manifestDigest.slice(7)}/gen/a.txt`)).toBe(
      "hand-edited",
    );
    // A third apply with nothing drifted is a plain noop without `drifted`.
    const r3 = await fsApply(bundle, root);
    expect(r3.status).toBe("noop");
    expect(r3.drifted).toBeUndefined();
  });

  it("a fresh `create` over an existing file (no applied marker) is still ERR_EXISTS", async () => {
    const root = await mkRoot();
    await writeTree(root, { "x.txt": "theirs" });
    const r = await fsApply(makeBundle([{ path: "x.txt", content: "x" }]), root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_EXISTS");
    expect(r.drifted).toBeUndefined();
  });

  it("delete of an absent file is skipped, not an error", async () => {
    const root = await mkRoot();
    const r = await fsApply(
      makeBundle([
        { path: "gone.txt", op: "delete" },
        { path: "n.txt", content: "n" },
      ]),
      root,
    );
    expect(r.status).toBe("applied");
    expect(r.files.find((f) => f.path === "gone.txt")?.status).toBe("skipped");
  });

  it("prunes backups to keepBackups", async () => {
    const root = await mkRoot();
    await writeTree(root, { "f.txt": "0" });
    for (let i = 1; i <= 4; i++) {
      const r = await fsApply(
        makeBundle([{ path: "f.txt", content: String(i), op: "overwrite" }]),
        root,
        {
          keepBackups: 2,
        },
      );
      expect(r.status).toBe("applied");
    }
    const dirs = await fs.readdir(path.join(root, ".axiom", "backup"));
    expect(dirs.length).toBe(2);
  });
});

describe("apply preconditions", () => {
  it("ERR_ROOT_NOT_DIR", async () => {
    const r = await fsApply(
      makeBundle([{ path: "a", content: "a" }]),
      path.join(await mkRoot(), "nope"),
    );
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_ROOT_NOT_DIR");
  });

  it("ERR_CONFIRM_DIGEST_MISMATCH (missing and wrong), not required in dry-run", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a", content: "a" }]);
    const r1 = await apply({ bundle, root, mode: "fs" });
    expect(r1.error?.code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    const r2 = await apply({ bundle, root, mode: "fs", confirmDigest: `sha256:${"0".repeat(64)}` });
    expect(r2.error?.code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(await exists(root, "a")).toBe(false);
    const r3 = await apply({ bundle, root, mode: "dry-run" });
    expect(r3.status).toBe("applied");
  });

  it("ERR_NOT_CANONICAL when manifestDigest does not match manifest", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a", content: "a" }]);
    const tampered: ManifestBundle = { ...bundle, manifest: { ...bundle.manifest, name: "other" } };
    const r = await fsApply(tampered, root);
    expect(r.error?.code).toBe("ERR_NOT_CANONICAL");
  });

  it("ERR_INVALID_MANIFEST on schema violation", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a", content: "a" }]);
    const bad = {
      ...bundle,
      manifest: { ...bundle.manifest, artifacts: [] },
    } as unknown as ManifestBundle;
    const r = await apply({ bundle: bad, root, mode: "fs", confirmDigest: bad.manifestDigest });
    expect(r.error?.code).toBe("ERR_INVALID_MANIFEST");
  });

  it("ERR_BLOB_MISSING aborts before any write", async () => {
    const root = await mkRoot();
    const bundle = makeBundle(
      [
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
      ],
      {
        omitBlobs: ["b.txt"],
      },
    );
    const r = await fsApply(bundle, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_BLOB_MISSING");
    expect(r.error?.path).toBe("b.txt");
    expect(await exists(root, "a.txt")).toBe(false);
    expect(await exists(root, `.axiom/staging/${bundle.manifestDigest.slice(7)}`)).toBe(false);
  });

  it("ERR_DIGEST_MISMATCH when blob bytes differ from declared digest", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a.txt", content: "a" }]);
    const key = Object.keys(bundle.blobs)[0] as keyof typeof bundle.blobs;
    const tampered: ManifestBundle = {
      ...bundle,
      blobs: { [key]: { encoding: "utf8", data: "b" } },
    };
    const r = await fsApply(tampered, root);
    expect(r.error?.code).toBe("ERR_DIGEST_MISMATCH");
  });

  it("ERR_DIGEST_MISMATCH precisely when size matches", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a.txt", content: "aa" }]);
    const key = Object.keys(bundle.blobs)[0] as keyof typeof bundle.blobs;
    const tampered: ManifestBundle = {
      ...bundle,
      blobs: { [key]: { encoding: "utf8", data: "bb" } },
    };
    const r = await fsApply(tampered, root);
    expect(r.error?.code).toBe("ERR_DIGEST_MISMATCH");
  });

  it("ERR_EXISTS for create over an existing file", async () => {
    const root = await mkRoot();
    await writeTree(root, { "a.txt": "old" });
    const r = await fsApply(makeBundle([{ path: "a.txt", content: "new" }]), root);
    expect(r.error?.code).toBe("ERR_EXISTS");
    expect(await readText(root, "a.txt")).toBe("old");
  });

  it("Windows reserved names rejected on every OS", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "src/ok.txt", content: "x" }]);
    // Bypass the schema-level artifact validation by patching the manifest after hashing
    // is not canonical — so test via the pre-hash path: the schema itself rejects it.
    const withReserved: ManifestBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        artifacts: [
          {
            ...(bundle.manifest.artifacts[0] as NonNullable<(typeof bundle.manifest.artifacts)[0]>),
            path: "NUL.txt",
          },
        ],
      },
    };
    const r = await apply({ bundle: withReserved, root, mode: "dry-run" });
    expect(["ERR_INVALID_MANIFEST", "ERR_PATH_RESERVED_NAME"]).toContain(r.error?.code);
  });

  it("artifacts targeting .axiom/ are rejected", async () => {
    const root = await mkRoot();
    const r = await fsApply(makeBundle([{ path: ".axiom/lock", content: "x" }]), root);
    expect(r.error?.code).toBe("ERR_CONTAINMENT");
  });

  it("ERR_CHECKS_FAILED when preChecks verdict is not pass; nothing written", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a.txt", content: "a" }]);
    const report = (verdict: CheckReport["verdict"]): CheckReport => ({
      apiVersion: "axiom.dev/v2",
      kind: "CheckReport",
      manifestDigest: bundle.manifestDigest,
      profile: "default",
      verdict,
      findings: [],
      factsDigest: `sha256:${sha256Hex("f")}`,
      durationMs: 0,
      providers: [],
    });
    let sawStaging = false;
    const r = await fsApply(bundle, root, {
      preChecks: async (staged) => {
        sawStaging = await exists(
          root,
          path.relative(root, staged.stagingDir).replaceAll(path.sep, "/"),
        );
        return report("fail");
      },
    });
    expect(sawStaging).toBe(true);
    expect(r.error?.code).toBe("ERR_CHECKS_FAILED");
    expect(await exists(root, "a.txt")).toBe(false);
    const ok = await fsApply(bundle, root, { preChecks: async () => report("pass") });
    expect(ok.status).toBe("applied");
  });
});

describe("dry-run", () => {
  it("produces a diff and touches nothing", async () => {
    const root = await mkRoot();
    await writeTree(root, { "over.txt": "line1\nline2\n" });
    const before = await snapshot(root);
    const bundle = makeBundle([
      { path: "over.txt", content: "line1\nchanged\n", op: "overwrite" },
      { path: "new.txt", content: "hi\n" },
      { path: "bin.dat", content: new Uint8Array([0, 1, 2, 255]) },
    ]);
    const r = await apply({ bundle, root, mode: "dry-run" });
    expect(r.status).toBe("applied");
    expect(r.diff).toContain("-line2");
    expect(r.diff).toContain("+changed");
    expect(r.diff).toContain("+hi");
    expect(r.diff).toContain("Binary files differ");
    expect(await snapshot(root)).toEqual(before);
    expect(await exists(root, `.axiom/staging/${bundle.manifestDigest.slice(7)}`)).toBe(false);
    expect(await exists(root, ".axiom/journal")).toBe(false);
    expect(await exists(root, ".axiom/applied")).toBe(false);
  });
});

describe("TOCTOU and rollback", () => {
  it("pre-image changed between staging and commit → rolled-back, tree byte-identical", async () => {
    const root = await mkRoot();
    await writeTree(root, { "a.txt": "a0", "b.txt": "b0" });
    const bundle = makeBundle([
      { path: "a.txt", content: "a1", op: "overwrite" },
      { path: "b.txt", content: "b1", op: "overwrite" },
    ]);
    // Mutate b.txt while checks run (after staging, before commit).
    const r = await fsApply(bundle, root, {
      preChecks: async () => {
        await writeTree(root, { "b.txt": "b-external" });
        return {
          apiVersion: "axiom.dev/v2",
          kind: "CheckReport",
          manifestDigest: bundle.manifestDigest,
          profile: "default",
          verdict: "pass",
          findings: [],
          factsDigest: `sha256:${sha256Hex("f")}`,
          durationMs: 0,
          providers: [],
        };
      },
    });
    expect(r.status).toBe("rolled-back");
    expect(r.error?.code).toBe("ERR_PREIMAGE_CHANGED");
    expect(r.error?.path).toBe("b.txt");
    expect(await readText(root, "a.txt")).toBe("a0");
    expect(await readText(root, "b.txt")).toBe("b-external");
    expect(
      await exists(root, appliedPath(root, bundle.manifestDigest).slice(root.length + 1)),
    ).toBe(false);
  });

  it("injected fault at rename k restores a byte-identical tree (fast-check)", async () => {
    const enc = new TextEncoder();
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            // `[a-z]{1,6}` can spell a reserved device name (`aux`, `con`, `nul`, `prn`,
            // `com1`…) which RelPath rejects on every platform (ERR_PATH_RESERVED_NAME) —
            // that is a schema failure, not a commit fault, so keep it out of this property.
            name: fc
              .stringMatching(/^[a-z]{1,6}$/)
              .filter((n) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)),
            kind: fc.constantFrom("create", "overwrite", "delete"),
            content: fc.string({ maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 5, selector: (x) => x.name },
        ),
        fc.nat(),
        async (specs, kSeed) => {
          const root = await mkRoot();
          const pre: Record<string, string> = {};
          const files: SpecFile[] = [];
          for (const s of specs) {
            const p = `d/${s.name}.txt`;
            if (s.kind === "overwrite" || s.kind === "delete") pre[p] = `pre-${s.name}`;
            if (s.kind === "delete") files.push({ path: p, op: "delete" });
            else files.push({ path: p, content: s.content, op: s.kind as "create" | "overwrite" });
          }
          await writeTree(root, pre);
          const before = await snapshot(root);
          const bundle = makeBundle(files);

          // Count how many renames a clean commit performs by doing a dry pass on a copy.
          // Cheaper: renames happen in commit for every non-skipped step; k in 1..N.
          const n = files.filter((f) => f.op !== "delete" || pre[f.path] !== undefined).length;
          const k = (kSeed % n) + 1;

          // Commit-phase mutations of the user tree are: rename(staging→target) for
          // create/overwrite and unlink(target) for delete. Inject at the k-th one.
          const realRename = fs.rename.bind(fs);
          const realUnlink = fs.unlink.bind(fs);
          let calls = 0;
          const inject = (): void => {
            calls++;
            if (calls === k) {
              const e = new Error("injected") as NodeJS.ErrnoException;
              e.code = "EIO";
              throw e;
            }
          };
          const inUserTree = (p: string): boolean => !p.includes(`${path.sep}.axiom${path.sep}`);
          const spyRename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (inUserTree(String(to))) inject();
            return realRename(from, to);
          });
          const spyUnlink = vi.spyOn(fs, "unlink").mockImplementation(async (p) => {
            if (inUserTree(String(p))) inject();
            return realUnlink(p);
          });
          try {
            const r = await fsApply(bundle, root);
            expect(r.status, JSON.stringify(r.error)).toBe("rolled-back");
            expect(r.error?.code).toBe("ERR_INTERNAL");
          } finally {
            spyRename.mockRestore();
            spyUnlink.mockRestore();
          }
          expect(await snapshot(root)).toEqual(before);
          expect(enc.encode("").length).toBe(0);
          // And a clean re-apply afterwards succeeds.
          const r2 = await fsApply(bundle, root);
          expect(r2.status).toBe("applied");
        },
      ),
      { numRuns: 25 },
    );
  });

  it("rollback(root, digest) after a successful apply restores pre-images", async () => {
    const root = await mkRoot();
    await writeTree(root, { "a.txt": "a0", "del.txt": "d0" });
    const bundle = makeBundle([
      { path: "a.txt", content: "a1", op: "overwrite" },
      { path: "new.txt", content: "n" },
      { path: "del.txt", op: "delete" },
    ]);
    const before = await snapshot(root);
    expect((await fsApply(bundle, root)).status).toBe("applied");
    const j = await rollback(root, bundle.manifestDigest);
    expect(j.phase).toBe("rolled-back");
    expect(await snapshot(root)).toEqual(before);
    // apply again works (marker removed)
    expect((await fsApply(bundle, root)).status).toBe("applied");
  });

  it("crash recovery: a journal left in committing is rolled back at next apply", async () => {
    const root = await mkRoot();
    await writeTree(root, { "a.txt": "a0" });
    const bundle = makeBundle([
      { path: "a.txt", content: "a1", op: "overwrite" },
      { path: "b.txt", content: "b" },
    ]);
    // Simulate: crash right after journal goes `committing` with steps partially done.
    let realRenameCount = 0;
    const realRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const toStr = String(to);
      if (!toStr.includes(`${path.sep}.axiom${path.sep}`)) {
        realRenameCount++;
        if (realRenameCount === 2) {
          // do the rename, then "crash": throw a non-Axiom error that also breaks rollback's marker
          await realRename(from, to);
          throw Object.assign(new Error("crash"), { code: "CRASH" });
        }
      }
      return realRename(from, to);
    });
    const r = await fsApply(bundle, root);
    spy.mockRestore();
    // Engine rolled back in-process already; verify the state and that another apply is clean.
    expect(r.status).toBe("rolled-back");
    expect(await readText(root, "a.txt")).toBe("a0");
    expect(await exists(root, "b.txt")).toBe(false);
    const r2 = await fsApply(bundle, root);
    expect(r2.status).toBe("applied");
    expect(await readText(root, "a.txt")).toBe("a1");
  });

  // skip reason: chmod is advisory on NTFS (a 0o555 dir stays writable); the ubuntu/macos CI jobs run it.
  it.skipIf(process.platform === "win32")(
    "IO failure at commit (target dir made read-only) → rolled-back with error.path, tree byte-identical",
    async () => {
      const root = await mkRoot();
      await fs.mkdir(path.join(root, "ro"));
      await writeTree(root, { "keep.txt": "keep" });
      const before = await snapshot(root);
      const bundle = makeBundle([
        { path: "keep.txt", content: "changed", op: "overwrite" },
        { path: "ro/new.txt", content: "x" },
      ]);
      await fs.chmod(path.join(root, "ro"), 0o555);
      try {
        const r = await fsApply(bundle, root);
        expect(r.status).toBe("rolled-back");
        // EACCES on the commit rename goes through renameRetry → ERR_EBUSY (never ERR_INTERNAL).
        expect(r.error?.code).toBe("ERR_EBUSY");
        expect(r.error?.path).toBe("ro/new.txt");
        expect(await readText(root, "keep.txt")).toBe("keep");
        expect(await exists(root, "ro/new.txt")).toBe(false);
        expect(await snapshot(root)).toEqual(before);
      } finally {
        await fs.chmod(path.join(root, "ro"), 0o755);
      }
    },
  );
});

describe("error-code hygiene (S-407)", () => {
  it("S-402: a manifest compiled against tree A is refused on tree B with ERR_PREIMAGE_CHANGED before any write; re-apply of an applied digest is exempt", async () => {
    const root = await mkRoot();
    await writeTree(root, { "cfg.json": "{}" });
    const bundle = makeBundle([
      { path: "cfg.json", content: '{"v":2}', op: "overwrite" },
      { path: "new.txt", content: "n" },
    ]);
    // Simulate compile-time binding (S-402): what compile saw on disk.
    const bound = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        preImage: [
          { path: "cfg.json", sha256: sha256Hex("{}") },
          { path: "new.txt", sha256: "absent" as const },
        ],
      },
    };
    const { canonicalDigestRef } = await import("@codai/axiom-canon");
    const boundBundle = { ...bound, manifestDigest: canonicalDigestRef(bound.manifest) };

    // Tree drifted after compile (someone edited cfg.json) → refused, nothing written.
    await writeTree(root, { "cfg.json": '{"edited":true}' });
    const before = await snapshot(root);
    const r = await fsApply(boundBundle, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_PREIMAGE_CHANGED");
    expect(r.error?.path).toBe("cfg.json");
    expect(await snapshot(root)).toEqual(before);
    expect(await exists(root, "new.txt")).toBe(false);

    // Restore the tree the manifest was compiled against → applies.
    await writeTree(root, { "cfg.json": "{}" });
    const ok = await fsApply(boundBundle, root);
    expect(ok.status).toBe("applied");
    // Re-apply: the tree now differs from preImage (our own writes), but the applied marker
    // makes this a noop / drifted re-apply, not ERR_PREIMAGE_CHANGED.
    const again = await fsApply(boundBundle, root);
    expect(again.status).toBe("noop");
    await writeTree(root, { "new.txt": "hand edit" });
    const re = await fsApply(boundBundle, root);
    expect(re.status).toBe("applied");
    expect(re.drifted).toEqual(["new.txt"]);
  });

  it("ERR_ROLLBACK when the commit fails AND the rollback fails; original error kept in the message", async () => {
    const root = await mkRoot();
    await writeTree(root, { "a.txt": "a0" });
    const bundle = makeBundle([
      { path: "a.txt", content: "a1", op: "overwrite" },
      { path: "b.txt", content: "b" },
    ]);
    const realRename = fs.rename.bind(fs);
    const inUserTree = (p: string): boolean => !p.includes(`${path.sep}.axiom${path.sep}`);
    let userRenames = 0;
    let restores = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const fromStr = String(from);
      const toStr = String(to);
      // Commit: staging → target. Fail the 2nd one so step 1 is done and must be rolled back.
      if (inUserTree(toStr) && fromStr.includes(`${path.sep}staging${path.sep}`)) {
        userRenames++;
        if (userRenames === 2) {
          throw Object.assign(new Error("disk on fire"), { code: "EIO" });
        }
      }
      // Rollback: backup → target. Make it fail too.
      if (inUserTree(toStr) && fromStr.includes(`${path.sep}backup${path.sep}`)) {
        restores++;
        throw Object.assign(new Error("restore failed"), { code: "EIO" });
      }
      return realRename(from, to);
    });
    let r: Awaited<ReturnType<typeof fsApply>>;
    try {
      r = await fsApply(bundle, root);
    } finally {
      spy.mockRestore();
    }
    expect(restores).toBeGreaterThan(0);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_ROLLBACK");
    // Raw EIO is not an AxiomError → the original surfaces as ERR_INTERNAL inside the message.
    expect(r.error?.message).toContain("after ERR_INTERNAL");
    expect(r.error?.message).toContain("disk on fire");
    expect(r.journal).toBeDefined();
    // No applied marker: the digest is not considered applied.
    expect(await exists(root, `.axiom/applied/${bundle.manifestDigest.slice(7)}.json`)).toBe(false);
    // The journal is left for `axiom rollback`, and that rollback (unmocked) restores the tree.
    const j = await rollback(root, bundle.manifestDigest);
    expect(j.phase).toBe("rolled-back");
    expect(await readText(root, "a.txt")).toBe("a0");
    expect(await exists(root, "b.txt")).toBe(false);
  });

  it("ERR_JOURNAL_CORRUPT from readJournal; recovery skips the corrupt file and a fresh apply still works", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "x.txt", content: "x" }]);
    const other = makeBundle([{ path: "y.txt", content: "y" }]);
    // A journal file that is not JSON at all, and one that is JSON but fails the schema.
    await fs.mkdir(path.join(root, ".axiom", "journal"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".axiom", "journal", `${bundle.manifestDigest.slice(7)}.json`),
      "{not json",
    );
    await fs.writeFile(
      path.join(root, ".axiom", "journal", `${other.manifestDigest.slice(7)}.json`),
      JSON.stringify({ manifestDigest: other.manifestDigest, phase: "sideways", steps: 3 }),
    );
    const { readJournal, listJournals } = await import("./journal.js");
    await expect(readJournal(root, bundle.manifestDigest)).rejects.toMatchObject({
      code: "ERR_JOURNAL_CORRUPT",
    });
    await expect(readJournal(root, other.manifestDigest)).rejects.toMatchObject({
      code: "ERR_JOURNAL_CORRUPT",
    });
    const listed = await listJournals(root);
    expect(listed.corrupt).toHaveLength(2);
    expect(listed.journals).toHaveLength(0);
    // `axiom rollback <digest>` on a corrupt journal is the error, not a crash.
    await expect(rollback(root, bundle.manifestDigest)).rejects.toMatchObject({
      code: "ERR_JOURNAL_CORRUPT",
    });
    // Recovery at the start of apply ignores corrupt journals and the apply succeeds.
    const r = await fsApply(makeBundle([{ path: "z.txt", content: "z" }]), root);
    expect(r.status).toBe("applied");
    expect(await readText(root, "z.txt")).toBe("z");
  });

  it("ERR_SIZE_MISMATCH when `bytes` disagrees with the blob (digest still right)", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "s.txt", content: "12345" }]);
    // Tamper `bytes` only; recompute the manifest digest so canonical checks pass.
    const { canonicalDigestRef } = await import("@codai/axiom-canon");
    const manifest = structuredClone(bundle.manifest);
    const a = manifest.artifacts[0];
    if (a === undefined) throw new Error("fixture");
    a.bytes = 4;
    const tampered = { ...bundle, manifest, manifestDigest: canonicalDigestRef(manifest) };
    const r = await fsApply(tampered, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_SIZE_MISMATCH");
    expect(r.error?.path).toBe("s.txt");
    expect(await exists(root, "s.txt")).toBe(false);
  });

  it("ERR_DIGEST_FORMAT: a manifest whose artifact digest is not 64 lowercase hex fails schema with that code", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "d.txt", content: "d" }]);
    const manifest = structuredClone(bundle.manifest);
    const a = manifest.artifacts[0];
    if (a === undefined || a.digest === undefined) throw new Error("fixture");
    a.digest.sha256 = a.digest.sha256.toUpperCase();
    const { canonicalDigestRef } = await import("@codai/axiom-canon");
    const tampered = { ...bundle, manifest, manifestDigest: canonicalDigestRef(manifest) };
    const r = await fsApply(tampered as typeof bundle, root);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("ERR_INVALID_MANIFEST");
    // The Zod issue that caused it names the closed-enum code.
    const { ManifestBundleSchema } = await import("@codai/axiom-schema");
    const parsed = ManifestBundleSchema.safeParse(tampered);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain("ERR_DIGEST_FORMAT");
    }
  });
});

describe("long paths", () => {
  it("writes, re-reads and deletes three targets whose absolute path exceeds 260 chars", async () => {
    const root = await mkRoot();
    const deep = Array.from({ length: 12 }, (_, i) => `segment-${i}-${"x".repeat(20)}`).join("/");
    const paths = [`${deep}/a.txt`, `${deep}/b.txt`, `${deep}/c/${"y".repeat(60)}.txt`];
    for (const p of paths) expect(path.join(root, p).length).toBeGreaterThan(260);
    const bundle = makeBundle(paths.map((p, i) => ({ path: p, content: `v${i}` })));
    const r = await fsApply(bundle, root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("applied");
    expect(r.files.map((f) => f.path).sort()).toEqual([...paths].sort());
    expect(await readText(root, paths[2]!)).toBe("v2");
    expect(await readText(root, paths[0]!)).toBe("v0");
    const del = makeBundle(
      paths.map((p) => ({ path: p, op: "delete" as const })),
      { name: "del" },
    );
    const r2 = await fsApply(del, root);
    expect(r2.status).toBe("applied");
    expect(r2.files.every((f) => f.status === "deleted")).toBe(true);
    for (const p of paths) expect(await exists(root, p)).toBe(false);
  });
});

describe("lock", () => {
  it("second apply on a locked root gets ERR_LOCKED (short timeout)", async () => {
    const root = await mkRoot();
    const bundle = makeBundle([{ path: "a.txt", content: "a" }]);
    const lock = await acquireLock(root, "sha256:other", 1000);
    try {
      const r = await fsApply(bundle, root, { lockTimeoutMs: 300 });
      expect(r.status).toBe("failed");
      expect(r.error?.code).toBe("ERR_LOCKED");
    } finally {
      await lock.release();
    }
    const r2 = await fsApply(bundle, root, { lockTimeoutMs: 300 });
    expect(r2.status).toBe("applied");
  });

  it("two concurrent applies on the same root serialise (both succeed)", async () => {
    const root = await mkRoot();
    const b1 = makeBundle([{ path: "one.txt", content: "1" }], { name: "one" });
    const b2 = makeBundle([{ path: "two.txt", content: "2" }], { name: "two" });
    const [r1, r2] = await Promise.all([fsApply(b1, root), fsApply(b2, root)]);
    expect(r1.status).toBe("applied");
    expect(r2.status).toBe("applied");
    expect(await readText(root, "one.txt")).toBe("1");
    expect(await readText(root, "two.txt")).toBe("2");
  });

  it("stale lock (dead pid) is reclaimed", async () => {
    const root = await mkRoot();
    await fs.mkdir(path.join(root, ".axiom"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".axiom", "lock"),
      JSON.stringify({
        pid: 999_999,
        hostname: (await import("node:os")).hostname(),
        startedAt: new Date().toISOString(),
        manifestDigest: "x",
      }),
    );
    const r = await fsApply(makeBundle([{ path: "a.txt", content: "a" }]), root, {
      lockTimeoutMs: 500,
    });
    expect(r.status).toBe("applied");
  });
});
