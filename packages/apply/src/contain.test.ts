import fs from "node:fs/promises";
import * as path from "node:path";
import { AxiomError } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import {
  checkTargetType,
  probeCaseInsensitive,
  resolveContained,
  validateArtifactPaths,
} from "./contain.js";
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
  it("returns a boolean and leaves no probe file", async () => {
    const root = await mkRoot();
    const r = await probeCaseInsensitive(root);
    expect(typeof r).toBe("boolean");
    if (process.platform === "win32") expect(r).toBe(true);
    const left = await fs.readdir(path.join(root, ".axiom", "tmp"));
    expect(left).toEqual([]);
  });
});
