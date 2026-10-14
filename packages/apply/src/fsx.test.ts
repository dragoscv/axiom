import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isContained } from "./fsx.js";

describe("isContained", () => {
  const root = path.resolve("/r", "a");

  it("accepts the root itself and paths below it", () => {
    expect(isContained(root, root)).toBe(true);
    expect(isContained(root, path.join(root, "b"))).toBe(true);
    expect(isContained(root, path.join(root, "b", "c.txt"))).toBe(true);
  });

  it("rejects a sibling that only shares the prefix (the /r/a vs /r/ab trap)", () => {
    expect(isContained(root, `${root}b`)).toBe(false);
    expect(isContained(root, `${root}-evil${path.sep}x`)).toBe(false);
  });

  it("rejects parents and unrelated paths", () => {
    expect(isContained(root, path.dirname(root))).toBe(false);
    expect(isContained(root, path.resolve("/other"))).toBe(false);
  });

  it("accepts a root given with a trailing separator", () => {
    expect(isContained(`${root}${path.sep}`, path.join(root, "b"))).toBe(true);
  });

  it.runIf(process.platform === "win32")("is case-insensitive on win32", () => {
    expect(isContained(root.toUpperCase(), path.join(root, "B"))).toBe(true);
  });
});
