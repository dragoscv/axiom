import fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unifiedDiff } from "./diff.js";
import { mkRoot } from "./test-helpers.js";
import { writeAtomic } from "./write.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeAtomic", () => {
  it("writes, re-hashes, leaves no tmp file, creates parent dirs", async () => {
    const root = await mkRoot();
    const target = path.join(root, "a", "b", "c.txt");
    const bytes = new TextEncoder().encode("hello\n");
    const hex = await writeAtomic(target, bytes);
    expect(hex).toBe(sha256Hex(bytes));
    expect(await fs.readFile(target, "utf8")).toBe("hello\n");
    const names = await fs.readdir(path.dirname(target));
    expect(names.filter((n) => n.startsWith(".axiom-tmp-"))).toEqual([]);
  });

  it("replaces an existing file atomically", async () => {
    const root = await mkRoot();
    const target = path.join(root, "f.txt");
    await fs.writeFile(target, "old");
    await writeAtomic(target, new TextEncoder().encode("new"));
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });

  it("200 parallel writeAtomic into one dir: distinct tmp names, all committed, no tmp left", async () => {
    const root = await mkRoot();
    const seen = new Set<string>();
    let duplicates = 0;
    const origOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (p, flags, mode) => {
      const s = String(p);
      if (path.basename(s).startsWith(".axiom-tmp-")) {
        if (seen.has(s)) duplicates++;
        seen.add(s);
      }
      return origOpen(p, flags as string, mode as number);
    });
    try {
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          writeAtomic(path.join(root, `f${i}.txt`), new TextEncoder().encode(`v${i}`)),
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(duplicates).toBe(0);
    expect(seen.size).toBe(200);
    const names = await fs.readdir(root);
    expect(names.filter((n) => n.startsWith(".axiom-tmp-"))).toEqual([]);
    expect(names.filter((n) => /^f\d+\.txt$/.test(n))).toHaveLength(200);
    expect(await fs.readFile(path.join(root, "f137.txt"), "utf8")).toBe("v137");
  });
});

describe("unifiedDiff", () => {
  it("produces a unified diff for text and marks binary", () => {
    const enc = new TextEncoder();
    const out = unifiedDiff([
      { path: "a.txt", before: enc.encode("one\ntwo\n"), after: enc.encode("one\nthree\n") },
      { path: "b.bin", before: new Uint8Array([0, 1, 2]), after: new Uint8Array([0, 9]) },
      { path: "new.txt", before: undefined, after: enc.encode("x\n") },
    ]);
    expect(out).toContain("-two");
    expect(out).toContain("+three");
    expect(out).toContain("Binary files differ");
    expect(out).toContain("/dev/null");
  });

  it("caps at 1 MiB", () => {
    const big = new TextEncoder().encode("x\n".repeat(700_000));
    const out = unifiedDiff([{ path: "big.txt", before: undefined, after: big }]);
    expect(Buffer.byteLength(out)).toBeLessThan(1024 * 1024 + 100);
    expect(out).toContain("[diff truncated at 1 MiB]");
  });
});
