import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestBody } from "@codai/axiom-schema";
import { afterEach, describe, expect, it } from "vitest";
import { builtinRegistry } from "../registry.js";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import type { FactContext } from "../types.js";
import {
  __setCedarModuleForTests,
  buildCedarRequests,
  CEDAR_MAX_POLICIES,
  CEDAR_POLICY_MAX_CHARS,
  type CedarActivation,
  type CedarOutcome,
  cedarModule,
  evaluateCedar,
  exprCedar,
  isCedarMissingError,
} from "./cedar.js";
import type { ContentEntry } from "./cel.js";

interface Vector {
  policies: string;
  mode?: "forbid" | "permit";
  activation: "A" | "R";
  expect: string[] | "error";
  reasons?: Record<string, string[]>;
  note?: string;
}
interface VectorFile {
  manifestDigest: string;
  activations: Record<
    "A" | "R",
    {
      manifest: ManifestBody;
      content: Record<string, ContentEntry>;
      repo?: Record<string, unknown>;
    }
  >;
  cases: Vector[];
}

const file: VectorFile = JSON.parse(
  readFileSync(join(import.meta.dirname, "cedar-vectors.json"), "utf8"),
);

function activationOf(name: "A" | "R"): CedarActivation {
  const raw = file.activations[name];
  const out: CedarActivation = {
    manifest: raw.manifest,
    manifestDigest: file.manifestDigest,
    content: raw.content,
  };
  if (raw.repo !== undefined) out.repo = raw.repo;
  return out;
}

const summarize = (o: CedarOutcome) =>
  o.kind === "value" ? o.denied.map((d) => d.path).join(",") : `error(${o.code}: ${o.message})`;

describe("expr.cedar vector suite", () => {
  it("has at least 150 cases across deny / no-deny / error classes and both modes", () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(150);
    let denies = 0;
    let clean = 0;
    let errors = 0;
    let permitMode = 0;
    let withRepo = 0;
    for (const c of file.cases) {
      if (c.expect === "error") errors += 1;
      else if (c.expect.length === 0) clean += 1;
      else denies += 1;
      if (c.mode === "permit") permitMode += 1;
      if (c.activation === "R") withRepo += 1;
    }
    expect(denies).toBeGreaterThan(70);
    expect(clean).toBeGreaterThan(20);
    expect(errors).toBeGreaterThan(30);
    expect(permitMode).toBeGreaterThan(8);
    expect(withRepo).toBeGreaterThan(10);
  });

  for (const [i, c] of file.cases.entries()) {
    const flat = c.policies.replace(/\s+/g, " ");
    const label = flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
    const mode = c.mode ?? "forbid";
    it(`#${i} [${c.activation}/${mode}] ${label} → ${JSON.stringify(c.expect)}${c.note ? ` (${c.note})` : ""}`, async () => {
      const r = await evaluateCedar({ policies: c.policies, mode }, activationOf(c.activation));
      if (c.expect === "error") {
        expect(r.kind, summarize(r)).toBe("error");
        if (r.kind === "error") {
          expect(["ERR_PREDICATE_PARAMS", "ERR_PROVIDER_FAILED"]).toContain(r.code);
        }
        return;
      }
      expect(r.kind, summarize(r)).toBe("value");
      if (r.kind !== "value") return;
      expect(r.denied.map((d) => d.path)).toEqual(c.expect);
      if (c.reasons !== undefined) {
        const got = Object.fromEntries(r.denied.map((d) => [d.path, d.reason]));
        expect(got).toEqual(c.reasons);
      }
    });
  }

  it("is pure: evaluating the whole suite twice yields identical outcomes", async () => {
    const run = async () => {
      const out: unknown[] = [];
      for (const c of file.cases) {
        const r = await evaluateCedar(
          { policies: c.policies, mode: c.mode ?? "forbid" },
          activationOf(c.activation),
        );
        out.push(r.kind === "value" ? r.denied : [r.code, r.message]);
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });

  it("classifies: parse/templates/too many → ERR_PREDICATE_PARAMS, eval → ERR_PROVIDER_FAILED", async () => {
    const act = activationOf("A");
    const code = async (policies: string, mode: "forbid" | "permit" = "forbid") => {
      const r = await evaluateCedar({ policies, mode }, act);
      return r.kind === "error" ? r.code : r.denied.map((d) => d.path);
    };
    expect(await code("forbid(")).toBe("ERR_PREDICATE_PARAMS");
    expect(await code("permit(principal == ?principal, action, resource);")).toBe(
      "ERR_PREDICATE_PARAMS",
    );
    const many = Array.from(
      { length: CEDAR_MAX_POLICIES + 1 },
      () => "forbid(principal, action, resource) when { false };",
    ).join("\n");
    expect(await code(many)).toBe("ERR_PREDICATE_PARAMS");
    expect(await code("forbid(principal, action, resource) when { resource.bytes > 0 };")).toBe(
      "ERR_PROVIDER_FAILED",
    );
    expect(await code("forbid(principal, action, resource) when { context.repo.gitDirty };")).toBe(
      "ERR_PROVIDER_FAILED",
    );
  });

  it("fails closed when evaluation exceeds the wall-clock budget", async () => {
    const r = await evaluateCedar(
      { policies: "forbid(principal, action, resource) when { false };", mode: "forbid" },
      activationOf("A"),
      0,
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("ERR_PROVIDER_FAILED");
  });

  it("builds one request per artifact, all sharing the entity store", () => {
    const { entities, requests } = buildCedarRequests(
      activationOf("R"),
      "permit(principal, action, resource);",
    );
    expect(entities).toHaveLength(5);
    expect(entities[0]?.uid).toEqual({ type: "Axiom::Manifest", id: file.manifestDigest });
    expect(requests).toHaveLength(4);
    for (const req of requests) {
      expect(req.principal).toEqual({ type: "Axiom::Plan", id: "demo" });
      expect(req.action.type).toBe("Axiom::Action");
      expect(req.resource.type).toBe("Axiom::Artifact");
      expect(req.entities).toBe(entities);
    }
    const util = entities.find((e) => e.uid.id === "src/util.ts");
    expect(util?.attrs).toMatchObject({
      ext: "ts",
      dir: "src",
      op: "overwrite",
      bytes: 300000,
      exists: false,
    });
    expect(util?.attrs.text).toBeUndefined();
    expect(util?.parents).toEqual([{ type: "Axiom::Manifest", id: file.manifestDigest }]);
    expect(requests[0]?.context).toMatchObject({ repo: { gitDirty: false } });
  });
});

describe("expr.cedar predicate through runChecks", () => {
  const bundle = makeBundle([
    { path: "src/a.ts", content: "export const a = 1;" },
    { path: "src/big.bin", content: new Uint8Array(1024).fill(0xff) },
    { path: ".env", content: "AWS_KEY=AKIAAAAAAAAAAAAAAAAA" },
    { path: "old.js", op: "delete" },
  ]);
  const one = (params: unknown, severity: "error" | "warn" | "info" = "error") =>
    profileWith([{ id: "cedar", predicate: "expr.cedar", params: params as never, severity }]);

  it("is registered (17 built-ins) and requires only manifest + content", () => {
    const reg = builtinRegistry();
    expect(reg.list()).toContain("expr.cedar");
    expect(reg.list()).toHaveLength(17);
    expect(exprCedar.requires).toEqual(["manifest", "content"]);
  });

  it("passes when no forbid applies", async () => {
    const r = await runChecks({
      bundle,
      profile: one({
        policies: 'forbid(principal, action, resource) when { resource.ext == "py" };',
      }),
    });
    expect(r.verdict, JSON.stringify(r.findings)).toBe("pass");
    expect(r.findings).toEqual([]);
  });

  it("emits one finding per denied artifact with path, reason and the custom message", async () => {
    const r = await runChecks({
      bundle,
      profile: one({
        policies: [
          '@id("no-dotenv") forbid(principal, action, resource) when { resource.ext == "env" };',
          'forbid(principal, action == Axiom::Action::"delete", resource);',
        ].join("\n"),
        message: "blocked by policy",
      }),
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.path)).toEqual([".env", "old.js"]);
    for (const f of r.findings) {
      expect(f.predicate).toBe("expr.cedar");
      expect(f.id).toBe("expr.cedar");
      expect(f.message).toBe("blocked by policy");
      expect(f.facts.__provider).toBeUndefined();
      expect(f.facts.mode).toBe("forbid");
    }
    expect(r.findings[0]?.facts.reason).toEqual(["policy0"]);
    expect(r.findings[1]?.facts.reason).toEqual(["policy1"]);
  });

  it("sees blob text (UTF-8 only) — a secret-shaped line in .env is denied", async () => {
    const r = await runChecks({
      bundle,
      profile: one({
        policies:
          'forbid(principal, action, resource) when { resource has text && resource.text like "*AKIA*" };',
      }),
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.path)).toEqual([".env"]);
    expect(r.findings[0]?.message).toMatch(/denied by cedar policy policy0/);
  });

  it("permit mode denies everything not explicitly permitted", async () => {
    const r = await runChecks({
      bundle,
      profile: one({
        mode: "permit",
        policies: 'permit(principal, action, resource) when { resource.dir == "src" };',
      }),
    });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.path)).toEqual([".env", "old.js"]);
    expect(r.findings[0]?.facts.reason).toEqual([]);
    expect(r.findings[0]?.message).toMatch(/default deny/);
  });

  it("re-labels denials with the check severity (warn → verdict pass)", async () => {
    const r = await runChecks({
      bundle,
      profile: one({ policies: "forbid(principal, action, resource);" }, "warn"),
    });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toHaveLength(4);
    expect(r.findings.every((f) => f.severity === "warn")).toBe(true);
  });

  it("returns verdict error (not pass) on parse error and on an evaluation error", async () => {
    for (const policies of [
      "forbid(principal action resource);",
      "forbid(principal, action, resource) when { resource.bytes > 0 };",
    ]) {
      const r = await runChecks({ bundle, profile: one({ policies }) });
      expect(r.verdict, policies).toBe("error");
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.facts.__provider).toBe(true);
      expect(["ERR_PREDICATE_PARAMS", "ERR_PROVIDER_FAILED"]).toContain(r.findings[0]?.facts.code);
    }
  });

  it("rejects params that break the Zod contract (over-long policy text, unknown key, bad mode)", async () => {
    const long = await runChecks({
      bundle,
      profile: one({ policies: `// ${"x".repeat(CEDAR_POLICY_MAX_CHARS)}` }),
    });
    expect(long.verdict).toBe("error");
    expect(long.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
    const extra = await runChecks({
      bundle,
      profile: one({ policies: "permit(principal, action, resource);", nope: 1 }),
    });
    expect(extra.verdict).toBe("error");
    expect(extra.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
    const mode = await runChecks({
      bundle,
      profile: one({ policies: "permit(principal, action, resource);", mode: "allow" }),
    });
    expect(mode.verdict).toBe("error");
    expect(mode.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
  });

  it("errors when `exists` is referenced without a root, evaluates it with one", async () => {
    const policies =
      'forbid(principal, action == Axiom::Action::"create", resource) when { resource.exists };';
    const noRoot = await runChecks({ bundle, profile: one({ policies }) });
    expect(noRoot.verdict).toBe("error");
    expect(noRoot.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");

    const root = await mkdtemp(join(tmpdir(), "axiom-cedar-"));
    try {
      await writeFile(join(root, ".env"), "old");
      const withRoot = await runChecks({ bundle, root, profile: one({ policies }) });
      expect(withRoot.verdict, JSON.stringify(withRoot.findings)).toBe("fail");
      expect(withRoot.findings.map((f) => f.path)).toEqual([".env"]);
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
          artifactCount: 4,
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
      exprCedar.run(ctx, {
        policies: 'forbid(principal, action, resource) when { resource.text like "*" };',
        mode: "forbid",
      }),
    ).rejects.toThrow(/blob store down/);
  });
});

describe("expr.cedar without the optional dependency", () => {
  afterEach(() => __setCedarModuleForTests(null));

  it("is a provider error (verdict error), never a pass", async () => {
    __setCedarModuleForTests(undefined);
    const bundle = makeBundle([{ path: "a.txt", content: "x" }]);
    const r = await runChecks({
      bundle,
      profile: profileWith([
        {
          id: "cedar",
          predicate: "expr.cedar",
          params: { policies: "permit(principal, action, resource);" } as never,
          severity: "error",
        },
      ]),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");
    expect(r.findings[0]?.message).toMatch(/@cedar-policy\/cedar-wasm/);
  });

  it("resolves the real module again after the seam is reset", async () => {
    __setCedarModuleForTests(null);
    const mod = await cedarModule();
    expect(mod?.getCedarVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("classifies every loader's not-installed rejection, including a Node SEA (D-27)", () => {
    const withCode = (code: string) => Object.assign(new Error(code), { code });
    expect(isCedarMissingError(withCode("ERR_MODULE_NOT_FOUND"))).toBe(true);
    expect(isCedarMissingError(withCode("MODULE_NOT_FOUND"))).toBe(true);
    expect(isCedarMissingError(withCode("ERR_UNKNOWN_BUILTIN_MODULE"))).toBe(true);
    // A broken install (e.g. the .wasm failing to instantiate) must still surface.
    expect(isCedarMissingError(withCode("ERR_INVALID_ARG_TYPE"))).toBe(false);
    expect(isCedarMissingError(new Error("boom"))).toBe(false);
    expect(isCedarMissingError(undefined)).toBe(false);
  });
});
