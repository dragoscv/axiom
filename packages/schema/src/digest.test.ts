import { describe, expect, it } from "vitest";
import {
  DigestRefSchema,
  DigestSchema,
  digestRefHex,
  Sha256HexSchema,
  toDigestRef,
} from "./digest.js";

const HEX = "0123456789abcdef".repeat(4);

describe("digest schemas", () => {
  it("Sha256Hex: 64 lowercase hex only", () => {
    expect(Sha256HexSchema.safeParse(HEX).success).toBe(true);
    expect(Sha256HexSchema.safeParse(HEX.toUpperCase()).success).toBe(false);
    expect(Sha256HexSchema.safeParse(HEX.slice(1)).success).toBe(false);
    expect(Sha256HexSchema.safeParse(`${HEX}0`).success).toBe(false);
    expect(Sha256HexSchema.safeParse("g".repeat(64)).success).toBe(false);
  });

  it("Digest: strict {sha256}", () => {
    expect(DigestSchema.safeParse({ sha256: HEX }).success).toBe(true);
    expect(DigestSchema.safeParse({ sha256: HEX, sha512: HEX }).success).toBe(false);
    expect(DigestSchema.safeParse({}).success).toBe(false);
  });

  it("DigestRef: sha256:<hex> template literal", () => {
    expect(DigestRefSchema.safeParse(`sha256:${HEX}`).success).toBe(true);
    expect(DigestRefSchema.safeParse(HEX).success).toBe(false);
    expect(DigestRefSchema.safeParse(`sha512:${HEX}`).success).toBe(false);
    expect(DigestRefSchema.safeParse(`sha256:${HEX.toUpperCase()}`).success).toBe(false);
    expect(DigestRefSchema.safeParse(`sha256:${HEX} `).success).toBe(false);
  });

  it("helpers round-trip", () => {
    const ref = toDigestRef(HEX);
    expect(ref).toBe(`sha256:${HEX}`);
    expect(digestRefHex(ref)).toBe(HEX);
  });
});
