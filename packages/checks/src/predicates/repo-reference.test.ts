/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${path}` etc. are the predicate's own template syntax, deliberately un-interpolated */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinRegistry } from "../registry.js";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { renderReferenceTemplate, repoRequireReference, resolveJsonPointer } from "./repo.js";

const PRED = "repo.requireReference";

async function check(bundle: ReturnType<typeof makeBundle>, params: unknown, root?: string) {
  const opts: Parameters<typeof runChecks>[0] = {
    bundle,
    profile: profileWith([
      { id: PRED, predicate: PRED, params: params as never, severity: "error" },
    ]),
  };
  if (root !== undefined) opts.root = root;
  const r = await runChecks(opts);
  return { verdict: r.verdict, ids: r.findings.map((f) => f.id), findings: r.findings };
}

const rule = (over: Record<string, unknown> = {}) => ({
  rules: [
    {
      name: "tools",
      when: "packages/mcp/src/tools/*.ts",
      in: "packages/mcp/spec/tools.json",
      mustContain: "${basename}",
      ...over,
    },
  ],
});

describe("repo.requireReference", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-ref-"));
    await mkdir(join(root, "packages", "mcp", "spec"), { recursive: true });
    await writeFile(
      join(root, "packages", "mcp", "spec", "tools.json"),
      JSON.stringify({
        tools: ["apply.ts", "check.ts"],
        byName: { "apply.ts": {}, "check.ts": {} },
      }),
    );
    await writeFile(
      join(root, "packages", "mcp", "spec", "README.md"),
      "see apply.ts and check.ts\n",
    );
    await writeFile(join(root, "packages", "mcp", "spec", "broken.json"), "{ not json");
    await writeFile(
      join(root, "packages", "mcp", "spec", "latin1.txt"),
      Buffer.from([0xff, 0xfe, 0x41]),
    );
    // A directory where a file is expected: exists() is true, read() is undefined.
    await mkdir(join(root, "packages", "mcp", "spec", "a-dir.json"), { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is registered and declares manifest + content + repo", () => {
    expect(builtinRegistry().list()).toContain(PRED);
    expect(repoRequireReference.requires).toEqual(["manifest", "content", "repo"]);
  });

  it("is skipped without a root (repo predicates are not evaluable)", async () => {
    const b = makeBundle([{ path: "packages/mcp/src/tools/new.ts", content: "" }]);
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: PRED, predicate: PRED, params: rule() as never, severity: "error" },
      ]),
    });
    expect(r.verdict).toBe("pass");
    expect(r.providers.find((p) => p.name === "repo")?.status).toBe("skipped");
  });

  it("rejects params without rules, unknown keys, or a malformed jsonPointer", async () => {
    const b = makeBundle([{ path: "packages/mcp/src/tools/new.ts", content: "" }]);
    for (const bad of [
      { rules: [] },
      rule({ extra: 1 }),
      rule({ jsonPointer: "tools" }),
      { rules: [{ name: "x", when: "**", in: "a" }] },
    ]) {
      const r = await check(b, bad, root);
      expect(r.verdict).toBe("error");
      expect(r.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
    }
  });

  describe("plain substring", () => {
    const md = rule({ in: "packages/mcp/spec/README.md" });
    it("passes when the repo companion mentions the artifact's basename", async () => {
      const b = makeBundle([{ path: "packages/mcp/src/tools/apply.ts", content: "" }]);
      expect((await check(b, md, root)).verdict).toBe("pass");
    });
    it("fails with facts {in, expected, source: repo} when it does not", async () => {
      const b = makeBundle([{ path: "packages/mcp/src/tools/rollback.ts", content: "" }]);
      const r = await check(b, md, root);
      expect(r.verdict).toBe("fail");
      expect(r.ids).toEqual(["repo.requireReference.tools"]);
      expect(r.findings[0]?.predicate).toBe(PRED);
      expect(r.findings[0]?.path).toBe("packages/mcp/src/tools/rollback.ts");
      expect(r.findings[0]?.facts).toMatchObject({
        in: "packages/mcp/spec/README.md",
        expected: "rollback.ts",
        source: "repo",
      });
    });
    it("a plan blob for the companion wins over the repo file (source: plan)", async () => {
      const pass = makeBundle([
        { path: "packages/mcp/src/tools/rollback.ts", content: "" },
        { path: "packages/mcp/spec/README.md", op: "overwrite", content: "rollback.ts\n" },
      ]);
      expect((await check(pass, md, root)).verdict).toBe("pass");
      // The repo copy mentions apply.ts, but the PLANNED copy drops it → fail, source: plan.
      const fail = makeBundle([
        { path: "packages/mcp/src/tools/apply.ts", content: "" },
        { path: "packages/mcp/spec/README.md", op: "overwrite", content: "nothing here\n" },
      ]);
      const r = await check(fail, md, root);
      expect(r.verdict).toBe("fail");
      expect(r.findings[0]?.facts.source).toBe("plan");
    });
    it("one finding per triggering artifact; the companion itself never triggers its own rule", async () => {
      const b = makeBundle([
        { path: "packages/mcp/src/tools/a.ts", content: "" },
        { path: "packages/mcp/src/tools/b.ts", content: "" },
        { path: "packages/mcp/src/tools/apply.ts", content: "" },
      ]);
      const r = await check(b, md, root);
      expect(r.findings.map((f) => f.path)).toEqual([
        "packages/mcp/src/tools/a.ts",
        "packages/mcp/src/tools/b.ts",
      ]);
      const self = makeBundle([{ path: "docs/index.md", content: "" }]);
      const selfRule = {
        rules: [{ name: "s", when: "docs/**", in: "docs/index.md", mustContain: "${path}" }],
      };
      expect((await check(self, selfRule, root)).verdict).toBe("pass");
    });
    it("deleted artifacts do not trigger; a companion deleted in the plan counts as absent", async () => {
      const del = makeBundle([{ path: "packages/mcp/src/tools/zz.ts", op: "delete" }]);
      expect((await check(del, md, root)).verdict).toBe("pass");
      const gone = makeBundle([
        { path: "packages/mcp/src/tools/apply.ts", content: "" },
        { path: "packages/mcp/spec/README.md", op: "delete" },
      ]);
      const r = await check(gone, md, root);
      expect(r.verdict).toBe("fail");
      expect(r.findings[0]?.facts.source).toBe("absent");
    });
    it("absent companion: fails with source: absent, mentioning plan-or-repo", async () => {
      const b = makeBundle([{ path: "packages/mcp/src/tools/apply.ts", content: "" }]);
      const r = await check(b, rule({ in: "packages/mcp/spec/nope.md" }), root);
      expect(r.verdict).toBe("fail");
      expect(r.findings[0]?.facts).toMatchObject({ source: "absent", mustChange: false });
      expect(r.findings[0]?.message).toMatch(/neither in the plan nor in the repo/);
    });
    it("mustChange: the repo companion does not count; the planned one does", async () => {
      const strict = rule({ in: "packages/mcp/spec/README.md", mustChange: true });
      const onlyTool = makeBundle([{ path: "packages/mcp/src/tools/apply.ts", content: "" }]);
      const r = await check(onlyTool, strict, root);
      expect(r.verdict).toBe("fail");
      expect(r.findings[0]?.facts).toMatchObject({ source: "absent", mustChange: true });
      expect(r.findings[0]?.message).toMatch(/does not also change/);
      const both = makeBundle([
        { path: "packages/mcp/src/tools/apply.ts", content: "" },
        { path: "packages/mcp/spec/README.md", op: "overwrite", content: "apply.ts" },
      ]);
      expect((await check(both, strict, root)).verdict).toBe("pass");
    });
    it("a planned companion whose blob is not available yields no finding (runner reports the missing fact)", async () => {
      const b = makeBundle([
        { path: "packages/mcp/src/tools/zz.ts", content: "" },
        { path: "packages/mcp/spec/README.md", op: "overwrite", content: "x", noBlob: true },
      ]);
      const r = await runChecks({
        bundle: b,
        profile: profileWith([
          { id: PRED, predicate: PRED, params: md as never, severity: "error" },
        ]),
        root,
      });
      expect(r.findings.filter((f) => f.predicate === PRED)).toEqual([]);
    });
    it("renders ${path} and ${dirname}", async () => {
      const b = makeBundle([
        { path: "packages/mcp/src/tools/x.ts", content: "" },
        {
          path: "index.md",
          content: "- packages/mcp/src/tools/x.ts lives in packages/mcp/src/tools\n",
        },
      ]);
      const byPath = {
        rules: [
          {
            name: "p",
            when: "packages/**/*.ts",
            in: "index.md",
            mustContain: "- ${path} lives in ${dirname}",
          },
        ],
      };
      expect((await check(b, byPath, root)).verdict).toBe("pass");
      const wrong = {
        rules: [
          {
            name: "p",
            when: "packages/**/*.ts",
            in: "index.md",
            mustContain: "${dirname}/${path}",
          },
        ],
      };
      const r = await check(b, wrong, root);
      expect(r.verdict).toBe("fail");
      expect(r.findings[0]?.facts.expected).toBe(
        "packages/mcp/src/tools/packages/mcp/src/tools/x.ts",
      );
    });
  });

  describe("jsonPointer", () => {
    it("array of strings: member equality, not substring", async () => {
      const ok = makeBundle([{ path: "packages/mcp/src/tools/apply.ts", content: "" }]);
      expect((await check(ok, rule({ jsonPointer: "/tools" }), root)).verdict).toBe("pass");
      // "apply.ts" is a substring of nothing here, but "ply.ts" IS a substring of "apply.ts" —
      // array semantics must not accept it.
      const sub = makeBundle([{ path: "packages/mcp/src/tools/ply.ts", content: "" }]);
      const r = await check(sub, rule({ jsonPointer: "/tools" }), root);
      expect(r.verdict).toBe("fail");
      expect(r.findings[0]?.facts).toMatchObject({ jsonPointer: "/tools", expected: "ply.ts" });
    });
    it("object: key membership", async () => {
      const ok = makeBundle([{ path: "packages/mcp/src/tools/check.ts", content: "" }]);
      expect((await check(ok, rule({ jsonPointer: "/byName" }), root)).verdict).toBe("pass");
      const missing = makeBundle([{ path: "packages/mcp/src/tools/gc.ts", content: "" }]);
      expect((await check(missing, rule({ jsonPointer: "/byName" }), root)).verdict).toBe("fail");
    });
    it("string: substring; empty pointer = whole document", async () => {
      const b = makeBundle([
        { path: "packages/mcp/src/tools/gc.ts", content: "" },
        {
          path: "packages/mcp/spec/tools.json",
          op: "overwrite",
          content: JSON.stringify({ doc: "gc.ts is a tool" }),
        },
      ]);
      expect((await check(b, rule({ jsonPointer: "/doc" }), root)).verdict).toBe("pass");
      const whole = makeBundle([
        { path: "packages/mcp/src/tools/gc.ts", content: "" },
        {
          path: "packages/mcp/spec/tools.json",
          op: "overwrite",
          content: JSON.stringify({ "gc.ts": 1 }),
        },
      ]);
      expect((await check(whole, rule({ jsonPointer: "" }), root)).verdict).toBe("pass");
    });
    it("escapes ~0 / ~1 and indexes arrays", async () => {
      const b = makeBundle([
        { path: "packages/mcp/src/tools/gc.ts", content: "" },
        {
          path: "packages/mcp/spec/tools.json",
          op: "overwrite",
          content: JSON.stringify({ "a/b": { "~x": [{ list: ["gc.ts"] }] } }),
        },
      ]);
      expect((await check(b, rule({ jsonPointer: "/a~1b/~0x/0/list" }), root)).verdict).toBe(
        "pass",
      );
    });
  });

  describe("fails closed (verdict: error, provider finding)", () => {
    const trigger = () => makeBundle([{ path: "packages/mcp/src/tools/apply.ts", content: "" }]);
    const expectProviderError = (r: Awaited<ReturnType<typeof check>>, re: RegExp) => {
      expect(r.verdict).toBe("error");
      expect(r.findings[0]?.predicate).toBe(PRED);
      expect(r.findings[0]?.severity).toBe("error");
      expect(r.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");
      expect(r.findings[0]?.message).toMatch(re);
    };
    it("jsonPointer set but the companion is not JSON", async () => {
      const r = await check(
        trigger(),
        rule({ in: "packages/mcp/spec/broken.json", jsonPointer: "/tools" }),
        root,
      );
      expectProviderError(r, /not valid JSON/);
    });
    it("jsonPointer does not resolve", async () => {
      const r = await check(trigger(), rule({ jsonPointer: "/nope/deeper" }), root);
      expectProviderError(r, /does not resolve/);
    });
    it("jsonPointer resolves to a number (cannot contain a string)", async () => {
      const b = makeBundle([
        { path: "packages/mcp/src/tools/apply.ts", content: "" },
        {
          path: "packages/mcp/spec/tools.json",
          op: "overwrite",
          content: JSON.stringify({ n: 42 }),
        },
      ]);
      const r = await check(b, rule({ jsonPointer: "/n" }), root);
      expectProviderError(r, /is a number/);
    });
    it("companion is not UTF-8", async () => {
      const r = await check(trigger(), rule({ in: "packages/mcp/spec/latin1.txt" }), root);
      expectProviderError(r, /not valid UTF-8/);
    });
    it("companion exists but cannot be read as a file", async () => {
      const r = await check(
        trigger(),
        rule({ in: "packages/mcp/spec/a-dir.json", jsonPointer: "/x" }),
        root,
      );
      expectProviderError(r, /could not be read/);
    });
    it("a `warn` CheckRef does not downgrade the provider error", async () => {
      const r = await runChecks({
        bundle: trigger(),
        profile: profileWith([
          {
            id: "ref",
            predicate: PRED,
            params: rule({ in: "packages/mcp/spec/broken.json", jsonPointer: "/tools" }) as never,
            severity: "warn",
          },
        ]),
        root,
      });
      expect(r.verdict).toBe("error");
      expect(r.findings[0]?.severity).toBe("error");
    });
    it("a plain-text rule on an unreadable-but-existing companion also errors (not a silent pass)", async () => {
      const dirRoot = await mkdtemp(join(tmpdir(), "axiom-ref-dir-"));
      try {
        await mkdir(join(dirRoot, "spec.json"), { recursive: true });
        await chmod(join(dirRoot, "spec.json"), 0o755);
        const r = await check(
          makeBundle([{ path: "tools/x.ts", content: "" }]),
          { rules: [{ name: "d", when: "tools/**", in: "spec.json", mustContain: "${basename}" }] },
          dirRoot,
        );
        expectProviderError(r, /could not be read/);
      } finally {
        await rm(dirRoot, { recursive: true, force: true });
      }
    });
  });

  describe("helpers", () => {
    it("renderReferenceTemplate: root-level artifact has empty dirname; unknown vars are kept", () => {
      expect(renderReferenceTemplate("${dirname}|${basename}|${path}", "README.md")).toBe(
        "|README.md|README.md",
      );
      expect(renderReferenceTemplate("${nope} ${basename}", "a/b.ts")).toBe("${nope} b.ts");
    });
    it("property: for any valid path, ${dirname}/${basename} round-trips to ${path} (or equals it at root)", () => {
      const seg = fc.stringMatching(/^[a-z0-9_.-]{1,8}$/).filter((s) => s !== "." && s !== "..");
      fc.assert(
        fc.property(fc.array(seg, { minLength: 1, maxLength: 6 }), (segs) => {
          const p = segs.join("/");
          const rendered = renderReferenceTemplate("${dirname}/${basename}", p);
          if (segs.length === 1) expect(rendered).toBe(`/${p}`);
          else expect(rendered).toBe(p);
          expect(renderReferenceTemplate("${path}", p)).toBe(p);
          // The template output always contains the basename, and the plain rule therefore
          // passes against a companion that is exactly the rendered path.
          expect(rendered.endsWith(segs[segs.length - 1] ?? "")).toBe(true);
        }),
      );
    });
    it("resolveJsonPointer: RFC 6901 examples", () => {
      const doc = {
        foo: ["bar", "baz"],
        "": 0,
        "a/b": 1,
        "c%d": 2,
        "e^f": 3,
        "g|h": 4,
        "i\\j": 5,
        'k"l': 6,
        " ": 7,
        "m~n": 8,
      };
      expect(resolveJsonPointer(doc, "")).toBe(doc);
      expect(resolveJsonPointer(doc, "/foo")).toEqual(["bar", "baz"]);
      expect(resolveJsonPointer(doc, "/foo/0")).toBe("bar");
      expect(resolveJsonPointer(doc, "/")).toBe(0);
      expect(resolveJsonPointer(doc, "/a~1b")).toBe(1);
      expect(resolveJsonPointer(doc, "/m~0n")).toBe(8);
      expect(resolveJsonPointer(doc, "/ ")).toBe(7);
      expect(resolveJsonPointer(doc, "/foo/2")).toBeUndefined();
      expect(resolveJsonPointer(doc, "/foo/-")).toBeUndefined();
      expect(resolveJsonPointer(doc, "/foo/01")).toBeUndefined();
      expect(resolveJsonPointer(doc, "/foo/0/x")).toBeUndefined();
      expect(resolveJsonPointer(doc, "/__proto__")).toBeUndefined();
    });
  });
});
