import type { Plan } from "@codai/axiom-schema";
import * as fc from "fast-check";

const HEX = "0123456789abcdef";
const ident = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz_"),
    fc.stringMatching(/^[A-Za-z0-9_-]{0,11}$/),
  )
  .map(([a, b]) => `${a}${b}`);
const kebab = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,15}$/);
const digest = fc
  .string({ unit: fc.constantFrom(...HEX), minLength: 64, maxLength: 64 })
  .map((h) => `sha256:${h}` as const);
/** Printable ASCII plus newlines — the byte range the heredoc must preserve exactly. */
const inlineContent = fc.string({
  unit: fc.constantFrom(
    ..." !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\n",
  ),
  maxLength: 80,
});
// RelPathSchema rejects Windows device names (con, nul, com1, ...) on every OS.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const segment = fc
  .stringMatching(/^[a-z][a-z0-9_-]{0,7}(\.[a-z]{1,3})?$/)
  .filter((s) => !RESERVED.test(s));
const relPath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));

const jsonKey = fc.stringMatching(/^[a-z]{1,6}$/);
/** JSON values that survive stringify→parse→deep-equal (no -0, no non-finite, no lone surrogates). */
const { jsonValue } = fc.letrec<{ jsonValue: unknown }>((tie) => ({
  jsonValue: fc.oneof(
    { depthSize: "small", maxDepth: 2 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.string({ maxLength: 12 }),
    fc.array(tie("jsonValue"), { maxLength: 3 }),
    fc
      .dictionary(jsonKey, tie("jsonValue"), { maxKeys: 3 })
      .map((o) => JSON.parse(JSON.stringify(o)) as unknown),
  ),
}));
/** `fc.dictionary` yields null-prototype objects; normalise through JSON so deep-equality holds. */
const jsonObject = fc
  .dictionary(jsonKey, jsonValue, { maxKeys: 3 })
  .map((o) => JSON.parse(JSON.stringify(o)) as Record<string, never>);

const source = fc.oneof(
  inlineContent.map((content) => ({ type: "inline" as const, encoding: "utf8" as const, content })),
  digest.map((d) => ({ type: "cas" as const, digest: d })),
  fc
    .tuple(
      fc.stringMatching(/^[a-z0-9]{1,8}(\.[a-z]{2,3})?$/),
      fc.stringMatching(/^[a-z0-9]{1,8}$/),
      digest,
    )
    .map(([host, p, d]) => ({ type: "ref" as const, uri: `https://${host}/${p}`, digest: d })),
);

const artifact = fc
  .tuple(
    relPath,
    fc.constantFrom("0644" as const, "0755" as const),
    fc.constantFrom("create" as const, "overwrite" as const, "delete" as const),
    source,
  )
  .map(([path, mode, op, src]) =>
    op === "delete" ? { path, mode, op } : { path, mode, op, source: src },
  );

const check = fc
  .tuple(
    ident,
    fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,6}\.[a-zA-Z][a-zA-Z0-9]{0,8}$/),
    fc.oneof(jsonObject, fc.array(jsonValue, { maxLength: 3 })),
  )
  .map(([id, predicate, params]) => ({ id, predicate, params, severity: "error" as const }));

/** Random valid Plans with inline / cas / ref sources, unique artifact paths and unique check ids. */
export const planArb: fc.Arbitrary<Plan> = fc
  .record({
    name: kebab,
    intent: fc.string({ maxLength: 40 }),
    profile: fc.constantFrom("default", "strict", "permissive"),
    capabilities: fc.uniqueArray(
      fc.constantFrom("fs", "net", "secret", "ai", "compute", "git") as fc.Arbitrary<
        Plan["capabilities"][number]
      >,
      { maxLength: 6 },
    ),
    artifacts: fc.uniqueArray(artifact, { minLength: 1, maxLength: 4, selector: (a) => a.path }),
    checks: fc.uniqueArray(check, { maxLength: 3, selector: (c) => c.id }),
    metadata: jsonObject,
  })
  .map((p) => ({ apiVersion: "axiom.dev/v2" as const, kind: "Plan" as const, ...p }) as Plan);
