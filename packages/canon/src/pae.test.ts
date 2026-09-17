import { describe, expect, it } from "vitest";
import { DSSE_IN_TOTO_PAYLOAD_TYPE, pae } from "./pae.js";

const enc: TextEncoder = new TextEncoder();
const dec: TextDecoder = new TextDecoder();

describe("pae (DSSE)", () => {
  it("matches the DSSE protocol.md vector", () => {
    const out = pae("http://example.com/HelloWorld", enc.encode("hello world"));
    expect(dec.decode(out)).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
  });

  it("uses byte lengths, not code-unit lengths", () => {
    const out = pae("t/€", enc.encode("€"));
    expect(dec.decode(out)).toBe("DSSEv1 5 t/€ 3 €");
  });

  it("handles empty payload", () => {
    expect(dec.decode(pae("x", new Uint8Array(0)))).toBe("DSSEv1 1 x 0 ");
  });

  it("exports the in-toto payload type", () => {
    expect(DSSE_IN_TOTO_PAYLOAD_TYPE).toBe("application/vnd.in-toto+json");
  });
});
