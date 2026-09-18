/**
 * DSSE v1.0.2 signing/verification over a canonical AXIOM manifest body.
 * https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
 *
 * Ed25519 only (`node:crypto`, no dependency). The envelope lives OUTSIDE the
 * canonical body, so `manifestDigest` is identical whether a bundle is signed
 * or not.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";
import { canonicalize } from "./jcs.js";
import { pae } from "./pae.js";

/** DSSE payloadType for an AXIOM `ManifestBody`. */
export const AXIOM_MANIFEST_PAYLOAD_TYPE: "application/vnd.axiom.manifest+json" =
  "application/vnd.axiom.manifest+json";

/** Ed25519 raw key sizes (RFC 8032). */
export const ED25519_RAW_PUBLIC_BYTES = 32;
export const ED25519_SEED_BYTES = 32;

/** DER prefixes for wrapping raw Ed25519 keys (RFC 8410). */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface DsseSignature {
  /** Unauthenticated hint: `sha256(rawPublicKey)` as lowercase hex. */
  keyid?: string | undefined;
  /** base64 of the raw 64-byte Ed25519 signature. */
  sig: string;
}

export interface DsseEnvelope {
  payloadType: string;
  /** base64(JCS(body)) */
  payload: string;
  signatures: readonly DsseSignature[];
}

/** A public key entry as it appears in `.axiom/trust/keys.json`. */
export interface TrustedKey {
  keyid: string;
  alg: "ed25519";
  /** base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
  name?: string | undefined;
  /** Lowest manifest `counter` this key may sign for. */
  notBefore?: number | undefined;
}

export type EnvelopeFailure =
  | "BAD_PAYLOAD_TYPE"
  | "NO_SIGNATURES"
  | "BAD_PAYLOAD"
  | "NOT_CANONICAL"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE";

export interface VerifyEnvelopeResult {
  ok: boolean;
  /** keyids that produced a valid signature, sorted, unique. */
  keyids: string[];
  /** The canonical payload text, only when `ok`. Never re-parse the envelope. */
  payload?: string;
  reason?: EnvelopeFailure;
}

function toBuffer(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

function rawPublicKeyOf(key: KeyObject): Buffer {
  const spki = key.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - ED25519_RAW_PUBLIC_BYTES));
}

/** `sha256(rawPublicKey)` as lowercase hex (64 chars). Full digest — no truncation. */
export function keyidFor(key: KeyObject | Uint8Array | string): string {
  let raw: Buffer;
  if (typeof key === "string") raw = Buffer.from(key, "base64");
  else if (key instanceof Uint8Array) raw = toBuffer(key);
  else raw = rawPublicKeyOf(key.type === "private" ? createPublicKey(key) : key);
  if (raw.length !== ED25519_RAW_PUBLIC_BYTES)
    throw new Error(`ed25519 public key must be ${ED25519_RAW_PUBLIC_BYTES} raw bytes`);
  return createHash("sha256").update(raw).digest("hex");
}

/** base64 of the raw 32-byte public key, for a trust-store entry. */
export function publicKeyBase64(key: KeyObject): string {
  return rawPublicKeyOf(key.type === "private" ? createPublicKey(key) : key).toString("base64");
}

/**
 * Accept either a base64 PKCS#8 DER private key or a base64 raw 32-byte seed
 * (also tolerates PEM text). Never logged, never echoed.
 */
export function privateKeyFrom(material: string): KeyObject {
  const text = material.trim();
  if (text.includes("-----BEGIN")) {
    const key = createPrivateKey(text);
    assertEd25519(key);
    return key;
  }
  let der: Buffer;
  try {
    der = Buffer.from(text, "base64");
  } catch {
    throw new Error("signing key is not valid base64");
  }
  if (der.length === 0) throw new Error("signing key is empty");
  if (der.length === ED25519_SEED_BYTES) {
    const key = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, der]),
      format: "der",
      type: "pkcs8",
    });
    return key;
  }
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  assertEd25519(key);
  return key;
}

/** Accept base64 raw 32 bytes, base64 SPKI DER, or PEM. */
export function publicKeyFrom(material: string): KeyObject {
  const text = material.trim();
  if (text.includes("-----BEGIN")) {
    const key = createPublicKey(text);
    assertEd25519(key);
    return key;
  }
  const der = Buffer.from(text, "base64");
  if (der.length === ED25519_RAW_PUBLIC_BYTES) {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, der]),
      format: "der",
      type: "spki",
    });
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  assertEd25519(key);
  return key;
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`expected an ed25519 key, got ${String(key.asymmetricKeyType)}`);
  }
}

export interface GeneratedKeyPair {
  keyid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** base64 PKCS#8 DER — what `AXIOM_SIGNING_KEY` / `--key-file` expect. */
  privateKeyBase64: string;
  /** base64 raw 32 bytes — what the trust store stores. */
  publicKeyBase64: string;
}

export function generateKeyPair(): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyid: keyidFor(publicKey),
    privateKey,
    publicKey,
    privateKeyBase64: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString(
      "base64",
    ),
    publicKeyBase64: publicKeyBase64(publicKey),
  };
}

/** Sign `JCS(body)` under the AXIOM manifest payload type. */
export function signEnvelope(
  body: unknown,
  privateKey: KeyObject,
  keyid?: string,
  payloadType: string = AXIOM_MANIFEST_PAYLOAD_TYPE,
): DsseEnvelope {
  assertEd25519(privateKey);
  const payloadBytes = new TextEncoder().encode(canonicalize(body));
  const message = toBuffer(pae(payloadType, payloadBytes));
  const sig = edSign(null, message, privateKey);
  return {
    payloadType,
    payload: toBuffer(payloadBytes).toString("base64"),
    signatures: [{ keyid: keyid ?? keyidFor(privateKey), sig: sig.toString("base64") }],
  };
}

function eqKeyid(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Verify an envelope against a trust store. The decoded payload must be
 * byte-identical to its own JCS form (`NOT_CANONICAL`), which is what makes a
 * signature bind the *canonical* manifest rather than one particular
 * serialisation of it.
 *
 * `keyid` is an unauthenticated hint per the spec: when a signature carries one
 * that no trusted key matches we still try every trusted key before reporting
 * `UNKNOWN_KEY`.
 */
export function verifyEnvelope(
  env: DsseEnvelope,
  trustedKeys: readonly TrustedKey[],
  payloadType: string = AXIOM_MANIFEST_PAYLOAD_TYPE,
): VerifyEnvelopeResult {
  if (env.payloadType !== payloadType) return { ok: false, keyids: [], reason: "BAD_PAYLOAD_TYPE" };
  if (!Array.isArray(env.signatures) || env.signatures.length === 0)
    return { ok: false, keyids: [], reason: "NO_SIGNATURES" };

  const payloadBytes = Buffer.from(env.payload, "base64");
  const text = payloadBytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, keyids: [], reason: "BAD_PAYLOAD" };
  }
  let canon: string;
  try {
    canon = canonicalize(parsed);
  } catch {
    return { ok: false, keyids: [], reason: "NOT_CANONICAL" };
  }
  if (canon !== text) return { ok: false, keyids: [], reason: "NOT_CANONICAL" };

  const message = toBuffer(pae(env.payloadType, payloadBytes));
  const keys: { keyid: string; key: KeyObject }[] = [];
  for (const t of trustedKeys) {
    if (t.alg !== "ed25519") continue;
    try {
      keys.push({ keyid: t.keyid, key: publicKeyFrom(t.publicKey) });
    } catch {
      /* an unusable trust entry is not a verification result; skip it */
    }
  }
  if (keys.length === 0) return { ok: false, keyids: [], reason: "UNKNOWN_KEY" };

  const verified = new Set<string>();
  let sawKnownKeyid = false;
  for (const s of env.signatures) {
    if (s.keyid !== undefined && keys.some((k) => eqKeyid(k.keyid, s.keyid as string)))
      sawKnownKeyid = true;
    let sig: Buffer;
    try {
      sig = Buffer.from(s.sig, "base64");
    } catch {
      continue;
    }
    for (const k of keys) {
      try {
        if (edVerify(null, message, k.key, sig)) verified.add(k.keyid);
      } catch {
        /* try the next key */
      }
    }
  }
  if (verified.size === 0) {
    return {
      ok: false,
      keyids: [],
      reason: sawKnownKeyid ? "BAD_SIGNATURE" : "UNKNOWN_KEY",
    };
  }
  return { ok: true, keyids: [...verified].sort(), payload: text };
}
