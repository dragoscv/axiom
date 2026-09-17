import type { Blob } from "@codai/axiom-schema";

const utf8Decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder: TextEncoder = new TextEncoder();

/** Canonical base64 alphabet, optional `=` padding, whitespace already stripped. */
const BASE64_RE: RegExp = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isBase64(s: string): boolean {
  return BASE64_RE.test(s.replace(/\s+/g, ""));
}

/**
 * True when `bytes` round-trip losslessly through a JSON string: valid UTF-8
 * and no NUL. Everything else travels as base64.
 */
export function isTextSafe(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    utf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function encodeBlob(bytes: Uint8Array): Blob {
  if (isTextSafe(bytes)) return { encoding: "utf8", data: utf8Decoder.decode(bytes) };
  return { encoding: "base64", data: Buffer.from(bytes).toString("base64") };
}

export function decodeBlob(blob: Blob): Uint8Array {
  if (blob.encoding === "utf8") return utf8Encoder.encode(blob.data);
  const buf = Buffer.from(blob.data, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function utf8Bytes(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}
