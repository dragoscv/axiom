import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalHash, sha256Hex, verifyCanonical } from "./digest.js";
import { CanonicalizeError, canonicalize } from "./jcs.js";

describe("canonicalize (RFC 8785)", () => {
  it("matches the RFC 8785 Appendix B number vectors", () => {
    // Appendix B: ES6 Number serialisation
    expect(canonicalize(1e30)).toBe("1e+30");
    expect(canonicalize(0.000001)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(100000000000000000000)).toBe("100000000000000000000");
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(9007199254740992)).toBe("9007199254740992");
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(-1.5)).toBe("-1.5");
    // biome-ignore lint/correctness/noPrecisionLoss: RFC 8785 Appendix B vector is intentionally lossy
    expect(canonicalize(333333333.33333329)).toBe("333333333.3333333");
    expect(canonicalize(5e-324)).toBe("5e-324");
    expect(canonicalize(1.7976931348623157e308)).toBe("1.7976931348623157e+308");
  });

  it("matches the RFC 8785 §3.2.3 key-ordering vector (UTF-16 code units)", () => {
    const input: Record<string, unknown> = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      [String.fromCodePoint(0x1f600)]: "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","' +
        String.fromCodePoint(0x1f600) +
        '":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("matches the RFC 8785 §3.2.3 full example", () => {
    const input = {
      // biome-ignore lint/correctness/noPrecisionLoss: RFC 8785 §3.2.3 vector
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"/",
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys and strips whitespace, nested", () => {
    expect(canonicalize({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });

  it("drops undefined object members, nulls undefined array items", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([undefined, 1])).toBe("[null,1]");
  });

  it("rejects non-finite numbers, bigint, functions", () => {
    expect(() => canonicalize(NaN)).toThrow(CanonicalizeError);
    expect(() => canonicalize(Infinity)).toThrow(CanonicalizeError);
    expect(() => canonicalize(1n)).toThrow(CanonicalizeError);
    expect(() => canonicalize(() => 1)).toThrow(CanonicalizeError);
    expect(() => canonicalize(undefined)).toThrow(CanonicalizeError);
  });

  it("rejects lone surrogates in values and keys, accepts valid pairs", () => {
    const hi = String.fromCharCode(0xd800);
    const lo = String.fromCharCode(0xdc00);
    expect(() => canonicalize(hi)).toThrow("lone high surrogate");
    expect(() => canonicalize(lo)).toThrow("lone low surrogate");
    expect(() => canonicalize({ [hi]: 1 })).toThrow(CanonicalizeError);
    const emoji = String.fromCodePoint(0x1f600);
    expect(canonicalize(emoji)).toBe(JSON.stringify(emoji));
  });

  it("is idempotent on its own output", () => {
    const v = { z: [1e21, "x"], a: { m: null } };
    const c = canonicalize(v);
    expect(canonicalize(JSON.parse(c))).toBe(c);
  });

  it("property: canonicalize(JSON.parse(canonicalize(x))) === canonicalize(x)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (x) => {
        const c = canonicalize(x);
        expect(canonicalize(JSON.parse(c))).toBe(c);
        expect(verifyCanonical(c)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("verifyCanonical", () => {
  it("roundtrips canonical text and rejects non-canonical text", () => {
    expect(verifyCanonical('{"a":1,"b":[true,null]}')).toBe(true);
    expect(verifyCanonical('{"b":1,"a":2}')).toBe(false);
    expect(verifyCanonical('{ "a": 1 }')).toBe(false);
    expect(verifyCanonical("{")).toBe(false);
    expect(verifyCanonical("1E30")).toBe(false);
    expect(verifyCanonical("1e+30")).toBe(true);
  });
});

describe("digests", () => {
  it("sha256Hex and canonicalHash agree", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
    expect(canonicalHash({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
  });
});
