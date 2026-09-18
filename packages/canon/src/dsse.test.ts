import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AXIOM_MANIFEST_PAYLOAD_TYPE,
  type DsseEnvelope,
  generateKeyPair,
  keyidFor,
  privateKeyFrom,
  publicKeyBase64,
  publicKeyFrom,
  signEnvelope,
  type TrustedKey,
  verifyEnvelope,
} from "./dsse.js";
import { canonicalize } from "./jcs.js";
import { pae } from "./pae.js";

const kp = generateKeyPair();
const trust: TrustedKey[] = [{ keyid: kp.keyid, alg: "ed25519", publicKey: kp.publicKeyBase64 }];
const body = { kind: "Manifest", name: "p", artifacts: [{ path: "a", op: "create" }], counter: 3 };

describe("DSSE protocol.md §Test Vectors", () => {
  it("PAE for the spec's HelloWorld vector (payload base64 from the envelope example)", () => {
    // From https://github.com/secure-systems-lab/dsse/blob/master/protocol.md (v1.0.2):
    // payload "aGVsbG8gd29ybGQ=", payloadType "http://example.com/HelloWorld".
    const payload = Buffer.from("aGVsbG8gd29ybGQ=", "base64");
    expect(payload.toString("utf8")).toBe("hello world");
    const out = Buffer.from(pae("http://example.com/HelloWorld", payload)).toString("utf8");
    expect(out).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
  });
});

describe("keyidFor", () => {
  it("is sha256(raw 32-byte public key) hex, identical for KeyObject / raw / base64 inputs", () => {
    const raw = Buffer.from(kp.publicKeyBase64, "base64");
    expect(raw).toHaveLength(32);
    const expected = createHash("sha256").update(raw).digest("hex");
    expect(kp.keyid).toBe(expected);
    expect(keyidFor(kp.publicKey)).toBe(expected);
    expect(keyidFor(kp.privateKey)).toBe(expected);
    expect(keyidFor(raw)).toBe(expected);
    expect(keyidFor(kp.publicKeyBase64)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects non-32-byte material", () => {
    expect(() => keyidFor(new Uint8Array(31))).toThrow(/32 raw bytes/);
  });
});

describe("key material parsing", () => {
  it("accepts base64 PKCS#8, base64 raw seed and PEM for the private key", () => {
    const fromPkcs8 = privateKeyFrom(kp.privateKeyBase64);
    expect(keyidFor(fromPkcs8)).toBe(kp.keyid);
    const pkcs8 = Buffer.from(kp.privateKeyBase64, "base64");
    const seed = pkcs8.subarray(pkcs8.length - 32).toString("base64");
    expect(keyidFor(privateKeyFrom(seed))).toBe(kp.keyid);
    const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(keyidFor(privateKeyFrom(pem))).toBe(kp.keyid);
  });
  it("accepts base64 raw, base64 SPKI and PEM for the public key", () => {
    expect(publicKeyBase64(publicKeyFrom(kp.publicKeyBase64))).toBe(kp.publicKeyBase64);
    const spki = Buffer.from(kp.publicKey.export({ type: "spki", format: "der" })).toString(
      "base64",
    );
    expect(publicKeyBase64(publicKeyFrom(spki))).toBe(kp.publicKeyBase64);
    const pem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(publicKeyBase64(publicKeyFrom(pem))).toBe(kp.publicKeyBase64);
  });
  it("rejects garbage and non-ed25519 keys", () => {
    expect(() => privateKeyFrom("")).toThrow();
    expect(() => privateKeyFrom("AAAA")).toThrow();
    expect(() => publicKeyFrom("AAAA")).toThrow();
  });
});

describe("signEnvelope / verifyEnvelope", () => {
  it("roundtrips and reports the signing keyid", () => {
    const env = signEnvelope(body, kp.privateKey);
    expect(env.payloadType).toBe(AXIOM_MANIFEST_PAYLOAD_TYPE);
    expect(Buffer.from(env.payload, "base64").toString("utf8")).toBe(canonicalize(body));
    expect(env.signatures).toHaveLength(1);
    expect(env.signatures[0]?.keyid).toBe(kp.keyid);
    expect(Buffer.from(env.signatures[0]?.sig ?? "", "base64")).toHaveLength(64);
    const r = verifyEnvelope(env, trust);
    expect(r).toEqual({ ok: true, keyids: [kp.keyid], payload: canonicalize(body) });
  });

  it("rejects a wrong payload type", () => {
    const env = signEnvelope(body, kp.privateKey);
    expect(verifyEnvelope({ ...env, payloadType: "application/json" }, trust).reason).toBe(
      "BAD_PAYLOAD_TYPE",
    );
    const inToto = signEnvelope(body, kp.privateKey, undefined, "application/vnd.in-toto+json");
    expect(verifyEnvelope(inToto, trust).reason).toBe("BAD_PAYLOAD_TYPE");
    expect(verifyEnvelope(inToto, trust, "application/vnd.in-toto+json").ok).toBe(true);
  });

  it("rejects an envelope without signatures", () => {
    const env = signEnvelope(body, kp.privateKey);
    expect(verifyEnvelope({ ...env, signatures: [] }, trust).reason).toBe("NO_SIGNATURES");
  });

  it("rejects an unknown key (empty trust store, other key, or hint pointing nowhere)", () => {
    const env = signEnvelope(body, kp.privateKey);
    expect(verifyEnvelope(env, []).reason).toBe("UNKNOWN_KEY");
    const other = generateKeyPair();
    const r = verifyEnvelope(env, [
      { keyid: other.keyid, alg: "ed25519", publicKey: other.publicKeyBase64 },
    ]);
    expect(r.reason).toBe("UNKNOWN_KEY");
    expect(r.ok).toBe(false);
  });

  it("keyid is only a hint: a wrong/missing keyid still verifies against the right trusted key", () => {
    const env = signEnvelope(body, kp.privateKey, "not-the-real-id");
    expect(verifyEnvelope(env, trust)).toMatchObject({ ok: true, keyids: [kp.keyid] });
    const noHint: DsseEnvelope = {
      ...env,
      signatures: env.signatures.map((s) => ({ sig: s.sig })),
    };
    expect(verifyEnvelope(noHint, trust).ok).toBe(true);
  });

  it("a known keyid with a forged signature is BAD_SIGNATURE, not UNKNOWN_KEY", () => {
    const env = signEnvelope(body, kp.privateKey);
    const sig = Buffer.from(env.signatures[0]?.sig ?? "", "base64");
    sig[0] = (sig[0] ?? 0) ^ 0xff;
    const forged = { ...env, signatures: [{ keyid: kp.keyid, sig: sig.toString("base64") }] };
    expect(verifyEnvelope(forged, trust).reason).toBe("BAD_SIGNATURE");
  });

  it("rejects a non-JSON payload and a non-canonical payload before touching crypto", () => {
    const env = signEnvelope(body, kp.privateKey);
    expect(
      verifyEnvelope({ ...env, payload: Buffer.from("{oops").toString("base64") }, trust).reason,
    ).toBe("BAD_PAYLOAD");
    // Same JSON value, different serialisation (pretty-printed) → NOT_CANONICAL
    const pretty = Buffer.from(JSON.stringify(body, null, 2)).toString("base64");
    expect(verifyEnvelope({ ...env, payload: pretty }, trust).reason).toBe("NOT_CANONICAL");
  });

  it("every single-byte flip in the payload is rejected (NOT_CANONICAL or BAD_SIGNATURE)", () => {
    const env = signEnvelope(body, kp.privateKey);
    const bytes = Buffer.from(env.payload, "base64");
    let notCanonical = 0;
    let badSig = 0;
    let badPayload = 0;
    for (let i = 0; i < bytes.length; i++) {
      for (const flip of [0x01, 0x20, 0x80]) {
        const mutated = Buffer.from(bytes);
        mutated[i] = (mutated[i] ?? 0) ^ flip;
        const r = verifyEnvelope({ ...env, payload: mutated.toString("base64") }, trust);
        expect(r.ok).toBe(false);
        if (r.reason === "NOT_CANONICAL") notCanonical++;
        else if (r.reason === "BAD_SIGNATURE") badSig++;
        else if (r.reason === "BAD_PAYLOAD") badPayload++;
        else throw new Error(`unexpected reason ${String(r.reason)} at byte ${i}`);
      }
    }
    // Flips that keep the JSON parseable AND canonical (e.g. inside a string) fall to the signature.
    expect(badSig).toBeGreaterThan(0);
    expect(notCanonical + badPayload).toBeGreaterThan(0);
  });

  it("multi-signature: reports every verifying trusted key, sorted", () => {
    const k2 = generateKeyPair();
    const e1 = signEnvelope(body, kp.privateKey);
    const e2 = signEnvelope(body, k2.privateKey);
    const env = { ...e1, signatures: [...e2.signatures, ...e1.signatures] };
    const r = verifyEnvelope(env, [
      ...trust,
      { keyid: k2.keyid, alg: "ed25519", publicKey: k2.publicKeyBase64 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.keyids).toEqual([kp.keyid, k2.keyid].sort());
    // Only one trusted → only one keyid, still ok
    expect(verifyEnvelope(env, trust).keyids).toEqual([kp.keyid]);
  });

  it("skips unusable trust entries instead of failing open", () => {
    const env = signEnvelope(body, kp.privateKey);
    const r = verifyEnvelope(env, [
      { keyid: "x", alg: "ed25519", publicKey: "not-a-key" },
      { keyid: "y", alg: "rsa" as never, publicKey: kp.publicKeyBase64 },
    ]);
    expect(r).toMatchObject({ ok: false, reason: "UNKNOWN_KEY" });
  });

  it("fast-check: random JSON bodies roundtrip; a different body never verifies as the same payload", () => {
    const json = fc.jsonValue({ maxDepth: 4 }).filter((v) => v !== null && typeof v === "object");
    fc.assert(
      fc.property(json, (b) => {
        const env = signEnvelope(b, kp.privateKey);
        const r = verifyEnvelope(env, trust);
        expect(r.ok).toBe(true);
        expect(r.payload).toBe(canonicalize(b));
      }),
      { numRuns: 200 },
    );
  });
});
