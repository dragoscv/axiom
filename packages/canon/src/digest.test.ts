import { describe, expect, it } from "vitest";
import {
  canonicalDigestRef,
  digestRef,
  parseDigestRef,
  sha256Digest,
  sha256Hex,
} from "./digest.js";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("digest refs", () => {
  it("wraps and parses sha256: refs", () => {
    expect(digestRef(ABC)).toBe(`sha256:${ABC}`);
    expect(parseDigestRef(`sha256:${ABC}`)).toBe(ABC);
  });

  it("rejects malformed hex and refs", () => {
    expect(() => digestRef("abc")).toThrow(TypeError);
    expect(() => digestRef(ABC.toUpperCase())).toThrow(TypeError);
    expect(() => parseDigestRef(ABC)).toThrow(TypeError);
    expect(() => parseDigestRef(`sha512:${ABC}`)).toThrow(TypeError);
    expect(() => parseDigestRef(`sha256:${ABC}0`)).toThrow(TypeError);
    expect(() => parseDigestRef("")).toThrow(TypeError);
  });

  it("sha256Digest returns an in-toto DigestSet", () => {
    expect(sha256Digest("abc")).toEqual({ sha256: ABC });
  });

  it("canonicalDigestRef hashes the JCS form", () => {
    expect(canonicalDigestRef({ b: 1, a: 2 })).toBe(`sha256:${sha256Hex('{"a":2,"b":1}')}`);
  });
});
