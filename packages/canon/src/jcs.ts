/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Lifted from codai/packages/rules-core/src/canon.ts (MIT, same author),
 * per docs/design/v2-architecture.md §2.3.
 *
 *  - object keys sorted by UTF-16 code units
 *  - no insignificant whitespace
 *  - numbers serialised per ECMAScript Number::toString (JSON.stringify)
 *  - strings escaped per RFC 8785 §3.2.2.2 (JSON.stringify is conformant)
 *  - I-JSON subset: lone surrogates, NaN/Infinity, bigint, undefined abort
 */
export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizeError";
  }
}

/**
 * Maximum object/array nesting `canonicalize` accepts (256 levels). Deeper input is rejected
 * with a `CanonicalizeError` instead of overflowing the call stack, which would surface as a
 * `RangeError` (and, upstream, as a generic `ERR_INTERNAL`).
 */
export const MAX_CANONICAL_DEPTH: number = 256;

/**
 * Index of the first unpaired surrogate in `s`, or -1. `TextEncoder` replaces such a code unit
 * with U+FFFD without telling anyone, so any string bound for a digest must be checked first.
 */
export function findLoneSurrogate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      return i;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}

function assertNoLoneSurrogates(s: string): void {
  const at = findLoneSurrogate(s);
  if (at >= 0) throw new CanonicalizeError(`lone surrogate at index ${at}`);
}

function sortKeys(a: string, b: string): number {
  // UTF-16 code-unit order — exactly what `<` on JS strings does.
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizeError(`nesting exceeds ${MAX_CANONICAL_DEPTH} levels`);
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizeError("non-finite number");
      return JSON.stringify(value);
    case "string":
      assertNoLoneSurrogates(value);
      return JSON.stringify(value);
    case "bigint":
      throw new CanonicalizeError("bigint not allowed (encode as string)");
    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalizeError(`unsupported type ${typeof value}`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map((v) => serialize(v === undefined ? null : v, depth + 1)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(sortKeys);
  const parts: string[] = [];
  for (const k of keys) {
    assertNoLoneSurrogates(k);
    parts.push(`${JSON.stringify(k)}:${serialize(obj[k], depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Serialise `value` to its RFC 8785 canonical JSON text. */
export function canonicalize(value: unknown): string {
  return serialize(value, 0);
}
