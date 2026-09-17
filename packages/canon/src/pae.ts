/**
 * DSSE Pre-Authentication Encoding.
 * https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
 *
 *   PAE(type, payload) = "DSSEv1" SP LEN(type) SP type SP LEN(payload) SP payload
 *
 * Lifted from codai/packages/rules-core/src/envelope.ts (MIT, same author).
 * Signing/verification arrives in v2.2.
 */

/** DSSE payloadType for in-toto Statements. */
export const DSSE_IN_TOTO_PAYLOAD_TYPE: "application/vnd.in-toto+json" =
  "application/vnd.in-toto+json";

const utf8: TextEncoder = new TextEncoder();

/** Lengths are byte counts of the UTF-8 encodings. */
export function pae(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = utf8.encode(payloadType);
  const head = utf8.encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}
