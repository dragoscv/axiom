import fs from "node:fs/promises";
import * as path from "node:path";
import { AxiomError } from "@codai/axiom-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkReservedDir,
  checkTargetType,
  isReservedAxiomPath,
  isReservedDirPath,
  probeCaseInsensitive,
  resolveContained,
  validateArtifactPaths,
} from "./contain.js";
import { isContained } from "./fsx.js";
import { mkRoot, writeTree } from "./test-helpers.js";

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AxiomError ? err.code : `non-axiom:${String(err)}`;
  }
}

function codeOfSync(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof AxiomError ? err.code : `non-axiom:${String(err)}`;
  }
}

describe("validateArtifactPaths", () => {
  it.each([
    ["../x", "ERR_PATH_SEGMENT"],
    ["a/../b", "ERR_PATH_SEGMENT"],
    ["/abs", "ERR_PATH_NOT_RELATIVE_POSIX"],
    ["C:/x", "ERR_PATH_NOT_RELATIVE_POSIX"],
    ["a\\b", "ERR_PATH_NOT_RELATIVE_POSIX"],
    ["a/./b", "ERR_PATH_SEGMENT"],
    ["a//b", "ERR_PATH_SEGMENT"],
    ["trailing. /x", "ERR_PATH_SEGMENT"],
    ["file.txt:stream", "ERR_PATH_INVALID_CHAR"],
    ["what?.txt", "ERR_PATH_INVALID_CHAR"],
  ])("rejects %s → %s", (p, code) => {
    expect(codeOfSync(() => validateArtifactPaths([{ path: p }]))).toBe(code);
  });

  it.each(["CON", "con.txt", "NUL", "com1", "LPT9.log", "src/AUX", "PRN.tar"])(
    "rejects Windows reserved name %s on every OS",
    (p) => {
      expect(codeOfSync(() => validateArtifactPaths([{ path: p }]))).toBe("ERR_PATH_RESERVED_NAME");
    },
  );

  it("detects case collision after NFC + lowercase", () => {
    expect(
      codeOfSync(() => validateArtifactPaths([{ path: "src/Foo.ts" }, { path: "src/foo.ts" }])),
    ).toBe("ERR_PATH_CASE_COLLISION");
    expect(
      codeOfSync(() => validateArtifactPaths([{ path: "src/foo.ts" }, { path: "src/bar.ts" }])),
    ).toBeUndefined();
  });
});

describe("resolveContained", () => {
  it("accepts nested non-existing paths and existing dirs", async () => {
    const root = await mkRoot();
    await writeTree(root, { "a/b.txt": "x" });
    const r1 = await resolveContained(root, "a/c/d.txt");
    expect(r1.abs).toBe(path.join(root, "a", "c", "d.txt"));
    const r2 = await resolveContained(root, "new/deep/file.txt");
    expect(r2.parentReal.toLowerCase()).toBe(root.toLowerCase());
  });

  it("rejects a file where a directory segment is expected", async () => {
    const root = await mkRoot();
    await writeTree(root, { a: "file" });
    expect(await codeOf(resolveContained(root, "a/b.txt"))).toBe("ERR_TARGET_TYPE");
  });

  it("rejects symlink / junction directory escape", async () => {
    const root = await mkRoot();
    const outside = await mkRoot();
    const link = path.join(root, "link");
    try {
      await fs.symlink(outside, link, "junction");
    } catch (err) {
      const c = (err as { code?: string }).code;
      if (c === "EPERM" || c === "EACCES") return; // no symlink privilege on this machine
      throw err;
    }
    expect(await codeOf(resolveContained(root, "link/evil.txt"))).toBe("ERR_SYMLINK_IN_PATH");
    // symlink INSIDE root still rejected (no following)
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "inlink"), "junction");
    expect(await codeOf(resolveContained(root, "inlink/x.txt"))).toBe("ERR_SYMLINK_IN_PATH");
  });

  it("refuses when the parent's realpath lies outside rootReal (containment backstop)", async () => {
    // rootReal must be canonical; a caller that passes an alias (junction/symlink to the real
    // root) would otherwise resolve parents to a path outside it. The segment walk sees no
    // symlink below the root, so only the final realpath comparison can catch this.
    const real = await mkRoot();
    const holder = await mkRoot();
    const alias = path.join(holder, "alias");
    try {
      await fs.symlink(real, alias, "junction");
    } catch (err) {
      const c = (err as { code?: string }).code;
      if (c === "EPERM" || c === "EACCES") return; // no symlink privilege on this machine
      throw err;
    }
    expect(await codeOf(resolveContained(alias, "new/file.txt"))).toBe("ERR_CONTAINMENT");
    expect(await codeOf(resolveContained(alias, "file.txt"))).toBe("ERR_CONTAINMENT");
  });
});

describe("checkTargetType", () => {
  it("ERR_EXISTS for create on existing file; ok for overwrite", async () => {
    const root = await mkRoot();
    await writeTree(root, { "f.txt": "x" });
    const abs = path.join(root, "f.txt");
    expect(await codeOf(checkTargetType(abs, "f.txt", "create"))).toBe("ERR_EXISTS");
    expect(await codeOf(checkTargetType(abs, "f.txt", "overwrite"))).toBeUndefined();
    expect(await codeOf(checkTargetType(abs, "f.txt", "delete"))).toBeUndefined();
  });

  it("ERR_TARGET_TYPE for directory target", async () => {
    const root = await mkRoot();
    await fs.mkdir(path.join(root, "d"));
    expect(await codeOf(checkTargetType(path.join(root, "d"), "d", "overwrite"))).toBe(
      "ERR_TARGET_TYPE",
    );
    expect(await codeOf(checkTargetType(path.join(root, "d"), "d", "delete"))).toBe(
      "ERR_TARGET_TYPE",
    );
  });

  it("symlink target → ERR_TARGET_TYPE", async () => {
    const root = await mkRoot();
    await writeTree(root, { "real.txt": "x" });
    try {
      await fs.symlink(path.join(root, "real.txt"), path.join(root, "ln.txt"), "file");
    } catch (err) {
      const c = (err as { code?: string }).code;
      if (c === "EPERM" || c === "EACCES") return;
      throw err;
    }
    expect(await codeOf(checkTargetType(path.join(root, "ln.txt"), "ln.txt", "overwrite"))).toBe(
      "ERR_TARGET_TYPE",
    );
  });
});

describe("probeCaseInsensitive", () => {
  it("returns a boolean and leaves neither the probe file nor the scratch directory (A1-28)", async () => {
    const root = await mkRoot();
    const r = await probeCaseInsensitive(root);
    expect(typeof r).toBe("boolean");
    if (process.platform === "win32") expect(r).toBe(true);
    expect(await fs.lstat(path.join(root, ".axiom", "tmp")).catch(() => null)).toBeNull();
    expect(await fs.readdir(path.join(root, ".axiom"))).toEqual([]);
  });

  it("never deletes a .axiom/tmp someone else already uses", async () => {
    const root = await mkRoot();
    await writeTree(root, { ".axiom/tmp/other.bin": "x" });
    await probeCaseInsensitive(root);
    expect(await fs.readdir(path.join(root, ".axiom", "tmp"))).toEqual(["other.bin"]);
  });

  it("create:false on a root without .axiom/ writes nothing and returns the platform default", async () => {
    const root = await mkRoot();
    const r = await probeCaseInsensitive(root, { create: false });
    expect(r).toBe(process.platform === "win32" || process.platform === "darwin");
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("reserved .axiom/", () => {
  it.each([".axiom", ".axiom/x", ".AXIOM/x", ".Axiom/trust/keys.json", ".aXiOm/lock"])(
    "%s is reserved by name",
    (p) => {
      expect(isReservedAxiomPath(p)).toBe(true);
    },
  );

  it.each(["axiom/x", "src/.axiom/x", ".axiomx/y", ".axiom-old/y"])("%s is not reserved", (p) => {
    expect(isReservedAxiomPath(p)).toBe(false);
  });

  it("checkReservedDir refuses a parent realpath under the .axiom realpath (alias)", () => {
    const ax = path.join(path.sep, "r", ".axiom");
    expect(codeOfSync(() => checkReservedDir("AXIOM~1/x", path.join(ax, "trust"), ax))).toBe(
      "ERR_PATH_RESERVED_DIR",
    );
    expect(
      codeOfSync(() => checkReservedDir("src/x", path.join(path.sep, "r", "src"), ax)),
    ).toBeUndefined();
  });
});

describe("reserved .git/ (A1-14)", () => {
  it.each([".git", ".git/config", ".GIT/config", ".Git/hooks/pre-commit", ".gIt"])(
    "%s is refused by name, on every platform",
    (p) => {
      expect(isReservedDirPath(p)).toBe(true);
      expect(codeOfSync(() => checkReservedDir(p))).toBe("ERR_PATH_RESERVED_DIR");
    },
  );

  it.each([".github/workflows/ci.yml", "git/config", "src/.git/config", ".gitignore"])(
    "%s is not the reserved directory (first segment only)",
    (p) => {
      expect(isReservedDirPath(p)).toBe(false);
      expect(codeOfSync(() => checkReservedDir(p))).toBeUndefined();
    },
  );

  it("checkReservedDir refuses a parent realpath under the .git realpath (alias / case alias)", () => {
    const git = path.join(path.sep, "r", ".git");
    expect(codeOfSync(() => checkReservedDir("GIT~1/config", git, undefined, git))).toBe(
      "ERR_PATH_RESERVED_DIR",
    );
  });
});

describe("containment property (apply.instructions.md: the spec)", () => {
  /** A junction out of the root, or `undefined` when this machine may not create one. */
  async function mkJunction(root: string): Promise<string | undefined> {
    const outside = await mkRoot();
    try {
      await fs.symlink(outside, path.join(root, "link"), "junction");
      return outside;
    } catch (err) {
      const c = (err as { code?: string }).code;
      // skip reason: no symlink/junction privilege on this machine (Windows without developer mode)
      if (c === "EPERM" || c === "EACCES") return undefined;
      throw err;
    }
  }

  async function resolveOrRefuse(
    root: string,
    p: string,
  ): Promise<{ ok: true; abs: string; parentReal: string } | { ok: false; err: unknown }> {
    try {
      const v = await resolveContained(root, p);
      return { ok: true, abs: v.abs, parentReal: v.parentReal };
    } catch (err) {
      return { ok: false, err };
    }
  }

  const segment = fc.constantFrom(
    "a",
    "B",
    "src",
    "dir",
    "sub",
    "x.y",
    ".gitx",
    ".axiomx",
    "caf\u00e9",
    "cafe\u0301",
    "..",
    ".",
    "NUL",
    " ",
    "link",
    "deep",
    "x".repeat(70),
  );
  const candidate = fc
    .array(segment, { minLength: 1, maxLength: 7 })
    .map((segs) => segs.join("/"))
    .filter((p) => p.length > 0 && p.length < 250);

  it("a generated path either stays inside the root or is refused with a coded error", async () => {
    const root = await mkRoot();
    await writeTree(root, { "src/keep.txt": "k" });
    const junction = await mkJunction(root);
    await fc.assert(
      fc.asyncProperty(candidate, async (p) => {
        const r = await resolveOrRefuse(root, p);
        if (!r.ok) {
          expect(r.err).toBeInstanceOf(AxiomError);
          return;
        }
        expect(isContained(root, r.abs), `${p} resolved to ${r.abs}`).toBe(true);
        expect(isContained(root, r.parentReal), `${p} parent ${r.parentReal}`).toBe(true);
        if (junction !== undefined) {
          expect(isContained(junction, r.parentReal), `${p} went through the junction`).toBe(false);
        }
      }),
      { numRuns: 250 },
    );
  });

  it("case, NFD and long-path variants never escape either", async () => {
    const root = await mkRoot();
    await writeTree(root, { "src/keep.txt": "k" });
    const corpus = [
      "src/keep.txt",
      "Src/KEEP.TXT",
      "caf\u00e9.txt",
      "cafe\u0301.txt",
      "a/../src/keep.txt",
      "deep/../..",
      `long/${"x".repeat(80)}/${"y".repeat(80)}/${"z".repeat(60)}.txt`,
    ];
    for (const p of corpus) {
      for (const variant of [p, p.toUpperCase(), p.normalize("NFD"), p.normalize("NFC")]) {
        const r = await resolveOrRefuse(root, variant);
        if (!r.ok) {
          expect(r.err).toBeInstanceOf(AxiomError);
          continue;
        }
        expect(isContained(root, r.abs), `${variant} resolved to ${r.abs}`).toBe(true);
        expect(isContained(root, r.parentReal), `${variant} parent ${r.parentReal}`).toBe(true);
      }
    }
  });

  it("refuses a path under a junction whatever its shape", async () => {
    const root = await mkRoot();
    const outside = await mkJunction(root);
    if (outside === undefined) return;
    for (const p of ["link/x.txt", "link/dir/x.txt", "link"]) {
      const r = await resolveOrRefuse(root, p);
      if (!r.ok) continue; // refused: fine
      // A single-segment `link` resolves to the link itself (its POINTEE is judged by
      // checkTargetType, which refuses a symlink); it must never resolve INTO the target.
      expect(isContained(outside, r.parentReal)).toBe(false);
      expect(isContained(outside, r.abs)).toBe(false);
    }
  });
});
