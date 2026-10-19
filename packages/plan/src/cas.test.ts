import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { isAxiomError } from "@codai/axiom-schema";
import { afterEach, describe, expect, it } from "vitest";
import { casGet, casGetUnverified, casHas, casPath, casPut } from "./cas.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("cas", () => {
  it("casPath shards by the first two hex chars", () => {
    const hex = "ab".padEnd(64, "0");
    expect(casPath("/r", hex)).toBe(join("/r", ".axiom", "cas", "sha256", "ab", hex));
  });

  it("put → has → get round-trips and leaves no tmp files", async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-cas-"));
    const bytes = new Uint8Array([1, 2, 3, 0, 255]);
    const hex = await casPut(root, bytes);
    expect(hex).toBe(sha256Hex(bytes));
    expect(await casHas(root, hex)).toBe(true);
    expect(await casGet(root, hex)).toEqual(bytes);
    expect(await casHas(root, "0".repeat(64))).toBe(false);
    expect(await casGet(root, "0".repeat(64))).toBeUndefined();
    const files = await readdir(join(root, ".axiom", "cas", "sha256", hex.slice(0, 2)));
    expect(files).toEqual([hex]);
  });

  it("second put of the same bytes is a no-op", async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-cas-"));
    const a = await casPut(root, new Uint8Array([9]));
    const b = await casPut(root, new Uint8Array([9]));
    expect(a).toBe(b);
  });

  it("concurrent puts of the same bytes all succeed", async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-cas-"));
    const bytes = new TextEncoder().encode("race");
    const hexes = await Promise.all(Array.from({ length: 8 }, () => casPut(root, bytes)));
    expect(new Set(hexes).size).toBe(1);
  });

  it("casGet re-hashes: a poisoned entry is ERR_DIGEST_MISMATCH; casGetUnverified returns raw bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-cas-"));
    const hex = sha256Hex("GOOD");
    const p = casPath(root, hex);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "EVIL");
    let code: string | undefined;
    try {
      await casGet(root, hex);
    } catch (err) {
      code = isAxiomError(err) ? err.code : "not-axiom";
    }
    expect(code).toBe("ERR_DIGEST_MISMATCH");
    expect(new TextDecoder().decode(await casGetUnverified(root, hex))).toBe("EVIL");
  });
});
