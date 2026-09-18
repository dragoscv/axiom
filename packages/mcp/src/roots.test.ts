import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRootsPolicy, isSameOrInside, resolveRoot } from "./roots.js";
import { tmpRepo } from "./test-helpers.js";

const IS_WIN32 = process.platform === "win32";

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe("roots policy", () => {
  let a: Awaited<ReturnType<typeof tmpRepo>>;
  let b: Awaited<ReturnType<typeof tmpRepo>>;
  let outside: Awaited<ReturnType<typeof tmpRepo>>;
  beforeEach(async () => {
    a = await tmpRepo("axiom-root-a-");
    b = await tmpRepo("axiom-root-b-");
    outside = await tmpRepo("axiom-outside-");
    await mkdir(join(a.root, "sub", "deep"), { recursive: true });
    await writeFile(join(a.root, "file.txt"), "x");
  });
  afterEach(async () => {
    await Promise.all([a.cleanup(), b.cleanup(), outside.cleanup()]);
  });

  it("createRootsPolicy: realpaths, freezes, rejects missing/non-dir/relative", async () => {
    const p = await createRootsPolicy([a.root]);
    expect(p.roots.size).toBe(1);
    expect(Object.isFrozen(p)).toBe(true);
    expect(await code(createRootsPolicy([join(a.root, "nope")]))).toBe("ERR_ROOT_NOT_DIR");
    expect(await code(createRootsPolicy([join(a.root, "file.txt")]))).toBe("ERR_ROOT_NOT_DIR");
    expect(await code(createRootsPolicy(["relative/dir"]))).toBe("ERR_ROOT_NOT_DIR");
  });

  it.each([
    ["none requested, zero roots", [] as string[], undefined, "ERR_ROOT_REQUIRED"],
    ["none requested, one root → that root", ["a"], undefined, "ok:a"],
    ["none requested, many roots", ["a", "b"], undefined, "ERR_ROOT_REQUIRED"],
    ["requested equals a root", ["a", "b"], "b", "ok:b"],
    ["requested inside a root → effective is ancestor", ["a", "b"], "a/sub/deep", "inside:a"],
    ["requested outside", ["a"], "outside", "ERR_ROOT_NOT_ALLOWED"],
    ["requested missing", ["a"], "a/missing", "ERR_ROOT_NOT_ALLOWED"],
    ["requested relative", ["a"], "rel", "ERR_ROOT_NOT_ALLOWED"],
  ])("resolveRoot: %s", async (_label, rootKeys, req, expected) => {
    const byKey: Record<string, string> = { a: a.root, b: b.root, outside: outside.root };
    const policy = await createRootsPolicy(rootKeys.map((k) => byKey[k] as string));
    let requested: string | undefined;
    if (req !== undefined) {
      const [head, ...rest] = req.split("/");
      requested = req === "rel" ? "rel" : join(byKey[head as string] as string, ...rest);
    }
    const result = resolveRoot(policy, requested);
    if (expected.startsWith("ok:")) {
      const r = await result;
      const want = (await createRootsPolicy([byKey[expected.slice(3)] as string])).roots
        .values()
        .next().value;
      expect(r.rootReal).toBe(want);
      expect(r.effectiveRoot).toBe(want);
    } else if (expected.startsWith("inside:")) {
      const r = await result;
      expect(r.effectiveRoot).toBe([...policy.roots][0]);
      expect(r.rootReal.startsWith(r.effectiveRoot)).toBe(true);
      expect(r.rootReal).not.toBe(r.effectiveRoot);
    } else {
      expect(await code(result)).toBe(expected);
    }
  });

  it("isSameOrInside: equality, containment, prefix trap, case sensitivity", () => {
    expect(isSameOrInside("/r/a", "/r/a")).toBe(true);
    expect(isSameOrInside("/r/a", "/r/a/b")).toBe(true);
    expect(isSameOrInside("/r/a", "/r/ab")).toBe(false);
    expect(isSameOrInside("/r/a/", "/r/a/b")).toBe(true);
    expect(isSameOrInside("/r/a", "/r")).toBe(false);
    expect(isSameOrInside("/r/A", "/r/a/b")).toBe(IS_WIN32);
  });

  it.runIf(IS_WIN32)("win32: differently-cased requested path is accepted", async () => {
    const policy = await createRootsPolicy([a.root]);
    const upper = a.root.toUpperCase();
    const r = await resolveRoot(policy, upper);
    expect(r.effectiveRoot).toBe([...policy.roots][0]);
  });
});
