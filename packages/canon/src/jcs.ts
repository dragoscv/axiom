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

function assertNoLoneSurrogates(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      throw new CanonicalizeError("lone high surrogate");
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalizeError("lone low surrogate");
  }
}

function sortKeys(a: string, b: string): number {
  // UTF-16 code-unit order — exactly what `<` on JS strings does.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Serialise `value` to its RFC 8785 canonical JSON text. */
export function canonicalize(value: unknown): string {
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
    return `[${items.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(sortKeys);
  const parts: string[] = [];
  for (const k of keys) {
    assertNoLoneSurrogates(k);
    parts.push(`${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  }
  return `{${parts.join(",")}}`;
}
