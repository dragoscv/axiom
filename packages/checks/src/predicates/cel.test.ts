import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { builtinRegistry } from "../registry.js";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import type { FactContext } from "../types.js";
import {
  CEL_ALLOWED_FUNCTIONS,
  type CelOutcome,
  EXPRESSION_MAX_CHARS,
  evaluateCel,
  exprCel,
  toCelValue,
} from "./cel.js";

interface Vector {
  expr: string;
  expect: boolean | "error";
  activation: "A" | "R";
  note?: string;
}
interface VectorFile {
  activations: Record<"A" | "R", Record<string, unknown>>;
  cases: Vector[];
}

const file: VectorFile = JSON.parse(
  readFileSync(join(import.meta.dirname, "cel-vectors.json"), "utf8"),
);

type Activation = Parameters<typeof evaluateCel>[1];

function activationOf(name: "A" | "R"): Activation {
  const raw = toCelValue(file.activations[name]) as Record<string, unknown>;
  const manifest = raw.manifest as Record<string, unknown>;
  const out: Activation = {
    manifest,
    artifacts: manifest.artifacts as unknown[],
    content: raw.content as Record<string, unknown>,
  };
  if (raw.repo !== undefined) out.repo = raw.repo as Record<string, unknown>;
  return out;
}

const summarize = (o: CelOutcome) => (o.kind === "value" ? o.value : `error(${o.message})`);

describe("expr.cel vector suite", () => {
  it("has at least 200 cases across all three expectation classes", () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(200);
    const byClass = { true: 0, false: 0, error: 0 };
    for (const c of file.cases) byClass[String(c.expect) as keyof typeof byClass] += 1;
    expect(byClass.true).toBeGreaterThan(50);
    expect(byClass.false).toBeGreaterThan(20);
    expect(byClass.error).toBeGreaterThan(50);
  });

  for (const [i, c] of file.cases.entries()) {
    const label = c.expr.length > 90 ? `${c.expr.slice(0, 87)}…` : c.expr;
    it(`#${i} [${c.activation}] ${label} → ${String(c.expect)}${c.note ? ` (${c.note})` : ""}`, async () => {
      const r = await evaluateCel(c.expr, activationOf(c.activation));
      if (c.expect === "error") {
        expect(r.kind, summarize(r).toString()).toBe("error");
        if (r.kind === "error") {
          expect(["ERR_PREDICATE_PARAMS", "ERR_PROVIDER_FAILED"]).toContain(r.code);
        }
      } else {
        expect(r.kind, summarize(r).toString()).toBe("value");
        if (r.kind === "value") expect(r.value).toBe(c.expect);
      }
    });
  }

  it("is pure: evaluating the whole suite twice yields identical outcomes", async () => {
    const run = async () => {
      const out: unknown[] = [];
      for (const c of file.cases) {
        const r = await evaluateCel(c.expr, activationOf(c.activation));
        out.push(r.kind === "value" ? r.value : [r.code, r.message]);
      }
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });

  it("classifies error codes: parse/denied → ERR_PREDICATE_PARAMS, runtime → ERR_PROVIDER_FAILED", async () => {
    const act = activationOf("A");
    const code = async (e: string) => {
      const r = await evaluateCel(e, act);
      return r.kind === "error" ? r.code : r.value;
    };
    expect(await code("1 <")).toBe("ERR_PREDICATE_PARAMS");
    expect(await code("now() > 1")).toBe("ERR_PREDICATE_PARAMS");
    expect(await code("manifest.name.matches('(?=d)')")).toBe("ERR_PREDICATE_PARAMS");
    expect(await code(`'${"x".repeat(EXPRESSION_MAX_CHARS)}' == ''`)).toBe("ERR_PREDICATE_PARAMS");
    expect(await code("1 / 0 == 1")).toBe("ERR_PROVIDER_FAILED");
    expect(await code("nope == 1")).toBe("ERR_PROVIDER_FAILED");
    expect(await code("repo.gitDirty")).toBe("ERR_PROVIDER_FAILED");
    expect(await code("1")).toBe("ERR_PROVIDER_FAILED");
  });

  it("fails closed when evaluation exceeds the wall-clock budget", async () => {
    const r = await evaluateCel("artifacts.all(a, a.path.size() > 0)", activationOf("A"), 0);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("ERR_PROVIDER_FAILED");
  });

  it("never allows a clock, random or encoding function through the allowlist", () => {
    for (const denied of ["timestamp", "duration", "now", "base64", "hex", "json", "bind", "at"]) {
      expect(CEL_ALLOWED_FUNCTIONS.has(denied)).toBe(false);
    }
  });
});

describe("expr.cel predicate through runChecks", () => {
  const bundle = makeBundle([
    { path: "src/a.ts", content: "export const a = 1;" },
    { path: "src/big.bin", content: new Uint8Array(1024).fill(0xff) },
    { path: "old.js", op: "delete" },
  ]);
  const one = (params: unknown, severity: "error" | "warn" | "info" = "error") =>
    profileWith([{ id: "cel", predicate: "expr.cel", params: params as never, severity }]);

  it("is registered (18 built-ins) and requires only manifest + content", () => {
    const reg = builtinRegistry();
    expect(reg.list()).toContain("expr.cel");
    expect(reg.list()).toHaveLength(18);
    expect(exprCel.requires).toEqual(["manifest", "content"]);
  });

  it("passes when the expression is true", async () => {
    const r = await runChecks({
      bundle,
      profile: one({ expression: "artifacts.all(a, a.op == 'delete' || a.bytes < 2048)" }),
    });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toEqual([]);
  });

  it("fails with ONE finding carrying the custom message when false", async () => {
    const r = await runChecks({
      bundle,
      profile: one({
        expression: "artifacts.all(a, a.op == 'delete' || a.bytes < 100)",
        message: "artifacts must be under 100 bytes",
      }),
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.predicate).toBe("expr.cel");
    expect(r.findings[0]?.id).toBe("expr.cel");
    expect(r.findings[0]?.message).toBe("artifacts must be under 100 bytes");
    expect(r.findings[0]?.facts.expression).toBe(
      "artifacts.all(a, a.op == 'delete' || a.bytes < 100)",
    );
    expect(r.findings[0]?.facts.__provider).toBeUndefined();
  });

  it("re-labels a false result with the check severity (warn → verdict pass)", async () => {
    const r = await runChecks({ bundle, profile: one({ expression: "false" }, "warn") });
    expect(r.verdict).toBe("pass");
    expect(r.findings[0]?.severity).toBe("warn");
  });

  it("exposes content text only for UTF-8 blobs and bytes/sha256 for all", async () => {
    const ok = await runChecks({
      bundle,
      profile: one({
        expression:
          "content['src/a.ts'].text.contains('const a') && !('text' in content['src/big.bin']) && 'text' in content['src/a.ts'] && content['src/big.bin'].bytes == 1024 && content['src/a.ts'].sha256 == artifacts[1].digest.sha256",
      }),
    });
    expect(ok.verdict, JSON.stringify(ok.findings)).toBe("pass");
  });

  it("evaluates on the canonical manifest fields (name/profile/planDigest/checks)", async () => {
    const r = await runChecks({
      bundle,
      profile: one({
        expression:
          "manifest.name == 'test' && manifest.profile == 'default' && manifest.planDigest.startsWith('sha256:') && size(manifest.checks) == 0",
      }),
    });
    expect(r.verdict).toBe("pass");
  });

  it("returns verdict error (not pass) on parse error, denied function, non-bool", async () => {
    for (const expression of ["1 <", "timestamp('2020-01-01T00:00:00Z') > timestamp(0)", "1"]) {
      const r = await runChecks({ bundle, profile: one({ expression }) });
      expect(r.verdict, expression).toBe("error");
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.facts.__provider).toBe(true);
      expect(["ERR_PREDICATE_PARAMS", "ERR_PROVIDER_FAILED"]).toContain(r.findings[0]?.facts.code);
    }
  });

  it("rejects params that break the Zod contract (over-long expression, unknown key)", async () => {
    const long = await runChecks({
      bundle,
      profile: one({ expression: `'${"x".repeat(EXPRESSION_MAX_CHARS)}' == ''` }),
    });
    expect(long.verdict).toBe("error");
    expect(long.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
    const extra = await runChecks({ bundle, profile: one({ expression: "true", nope: 1 }) });
    expect(extra.verdict).toBe("error");
    expect(extra.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
  });

  it("errors when `repo` is referenced without a root, evaluates it with one", async () => {
    const noRoot = await runChecks({
      bundle,
      profile: one({ expression: "artifacts.all(a, a.op == 'delete' || !repo.exists[a.path])" }),
    });
    expect(noRoot.verdict).toBe("error");
    expect(noRoot.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");

    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "axiom-cel-"));
    try {
      await writeFile(join(root, "old.js"), "x");
      const withRoot = await runChecks({
        bundle,
        root,
        profile: one({
          expression:
            "repo.exists['old.js'] && !repo.exists['src/a.ts'] && artifacts.filter(a, a.op == 'create').all(a, !repo.exists[a.path])",
        }),
      });
      expect(withRoot.verdict, JSON.stringify(withRoot.findings)).toBe("pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the content provider throws", async () => {
    const ctx: FactContext = {
      manifest: bundle.manifest,
      bundle,
      facts: {
        manifest: {
          artifactCount: 3,
          totalBytes: 0,
          paths: [],
          byExt: {},
          hasDeletes: true,
          signed: false,
        },
        content: async () => {
          throw new Error("blob store down");
        },
        profile: { allowRepo: false, allowGuards: false },
      },
    };
    await expect(
      exprCel.run(ctx, { expression: "content.all(k, content[k].bytes > 0)" }),
    ).rejects.toThrow(/blob store down/);
  });
});

describe("expr.cel property: simple comparisons agree with a JS reference", () => {
  const ops = ["<", "<=", ">", ">=", "==", "!="] as const;
  const jsCompare = (a: number, op: (typeof ops)[number], b: number): boolean => {
    switch (op) {
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      case "==":
        return a === b;
      case "!=":
        return a !== b;
    }
  };

  const artifactArb = fc.record({
    path: fc
      .array(fc.constantFrom("a", "b", "c", "d", "src", "docs", "x.ts", "y.md"), {
        minLength: 1,
        maxLength: 3,
      })
      .map((segs) => segs.join("/")),
    bytes: fc.integer({ min: 0, max: 1_000_000 }),
  });

  it("artifacts.all(a, a.bytes OP N) matches Array.every", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(artifactArb, { minLength: 1, maxLength: 12 }),
        fc.constantFrom(...ops),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (arts, op, n) => {
          const artifacts = arts.map((a, i) => ({
            path: `${a.path}/${i}`,
            op: "create",
            mode: "0644",
            digest: { sha256: "a".repeat(64) },
            bytes: BigInt(a.bytes),
          }));
          const r = await evaluateCel(`artifacts.all(a, a.bytes ${op} ${n})`, {
            manifest: { name: "p", artifacts },
            artifacts,
            content: {},
          });
          expect(r.kind).toBe("value");
          if (r.kind === "value") {
            expect(r.value).toBe(arts.every((a) => jsCompare(a.bytes, op, n)));
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("exists / exists_one / filter().size() agree with the reference", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(artifactArb, { minLength: 0, maxLength: 10 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (arts, n) => {
          const artifacts = arts.map((a) => ({ path: a.path, bytes: BigInt(a.bytes) }));
          const act = { manifest: { artifacts }, artifacts, content: {} };
          const hits = arts.filter((a) => a.bytes > n).length;
          const ex = await evaluateCel(`artifacts.exists(a, a.bytes > ${n})`, act);
          const one = await evaluateCel(`artifacts.exists_one(a, a.bytes > ${n})`, act);
          const cnt = await evaluateCel(
            `size(artifacts.filter(a, a.bytes > ${n})) == ${hits}`,
            act,
          );
          expect(ex).toMatchObject({ kind: "value", value: hits > 0 });
          expect(one).toMatchObject({ kind: "value", value: hits === 1 });
          expect(cnt).toMatchObject({ kind: "value", value: true });
        },
      ),
      { numRuns: 150 },
    );
  });

  it("integer literal comparisons agree with JS for the whole safe range", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.constantFrom(...ops),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        async (a, op, b) => {
          const r = await evaluateCel(`${a} ${op} ${b}`, {
            manifest: {},
            artifacts: [],
            content: {},
          });
          expect(r).toMatchObject({ kind: "value", value: jsCompare(a, op, b) });
        },
      ),
      { numRuns: 200 },
    );
  });
});
