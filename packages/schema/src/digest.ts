import { z } from "zod";

/** Lowercase hex sha256 (64 chars). */
export const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "ERR_DIGEST_FORMAT")
  .describe("Lowercase hex-encoded sha256");

/** in-toto DigestSet subset: `{ sha256 }`. */
export const DigestSchema = z.object({ sha256: Sha256HexSchema }).strict();

/** `sha256:<64 hex>` reference string used everywhere a digest is a key or id. */
export const DigestRefSchema = z
  .templateLiteral(["sha256:", Sha256HexSchema])
  .describe("sha256:<64 lowercase hex>");

export type Sha256Hex = z.infer<typeof Sha256HexSchema>;
export type Digest = z.infer<typeof DigestSchema>;
export type DigestRef = z.infer<typeof DigestRefSchema>;

export function toDigestRef(hex: Sha256Hex): DigestRef {
  return `sha256:${hex}`;
}

export function digestRefHex(ref: DigestRef): Sha256Hex {
  return ref.slice("sha256:".length);
}
