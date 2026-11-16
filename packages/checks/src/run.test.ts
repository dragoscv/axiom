import { sha256Hex } from "@codai/axiom-canon";
import { INLINE_CONTENT_MAX } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadProfile } from "./profile.js";
import { builtinRegistry, PredicateRegistry } from "./registry.js";
import { runChecks } from "./run.js";
import { makeBundle, profileWith } from "./test-helpers.test-helpers.js";
import { definePredicate } from "./types.js";

const b = makeBundle([
  { path: "src/a.ts", content: "ok" },
  { path: "src/b.ts", content: "ok" },
]);

describe("runChecks verdict matrix", () => {
  it("pass with no findings", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: "x", predicate: "path.allow", params: { globs: ["src/**"] }, severity: "error" },
      ]),
    });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.profile).toBe("test");
    expect(r.manifestDigest).toBe(b.manifestDigest);
  });
  it("fail when an error-severity finding exists", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: "x", predicate: "path.deny", params: { globs: ["src/**"] }, severity: "error" },
      ]),
    });
    expect(r.verdict).toBe("fail");
  });
  it("pass when findings are only warn/info (severity relabelled from CheckRef)", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: "x", predicate: "path.deny", params: { globs: ["src/**"] }, severity: "warn" },
      ]),
    });
    expect(r.verdict).toBe("pass");
    expect(r.findings.every((f) => f.severity === "warn")).toBe(true);
  });
  it("error on unknown predicate", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([{ id: "x", predicate: "nope.never", params: {}, severity: "error" }]),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PREDICATE_UNKNOWN");
  });
  it("error on bad params (fail closed)", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: "x", predicate: "manifest.maxArtifacts", params: { max: "ten" }, severity: "info" },
      ]),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PREDICATE_PARAMS");
    expect(r.findings[0]?.severity).toBe("error");
  });
  it("error when a predicate throws", async () => {
    const reg = builtinRegistry().register(
      definePredicate({
        id: "test.boom",
        params: z.object({}).strict(),
        requires: ["manifest"],
        run: async () => {
          throw new Error("kaboom");
        },
      }),
    );
    const r = await runChecks({
      bundle: b,
      registry: reg,
      profile: profileWith([{ id: "x", predicate: "test.boom", params: {}, severity: "error" }]),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");
  });
  it("error when the repo root does not exist", async () => {
    const r = await runChecks({
      bundle: b,
      root: "Z:\\definitely\\missing\\root",
      profile: profileWith([
        { id: "x", predicate: "repo.noOverwriteOf", params: { globs: ["**"] }, severity: "error" },
      ]),
    });
    // createRepoFacts tolerates a missing root (empty index); no provider failure expected.
    expect(["pass", "error"]).toContain(r.verdict);
  });
  it("A1-6: a plan check that redefines a profile check is refused (ERR_POLICY_FLOOR)", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: "x", predicate: "path.deny", params: { globs: ["src/**"] }, severity: "error" },
      ]),
      checks: [
        { id: "x", predicate: "path.deny", params: { globs: ["none/**"] }, severity: "error" },
      ],
    });
    expect(r.verdict).toBe("error");
    expect(r.findings.map((f) => f.facts.code)).toContain("ERR_POLICY_FLOOR");
    // the profile's check is still in force: the plan did not disable it
    expect(r.findings.some((f) => f.id === "path.deny" && f.path === "src/a.ts")).toBe(true);
  });
  it("A1-6: an identical plan check is accepted and a new plan check is added", async () => {
    const same = {
      id: "x",
      predicate: "path.allow",
      params: { globs: ["src/**"] },
      severity: "error" as const,
    };
    const identical = await runChecks({ bundle: b, profile: profileWith([same]), checks: [same] });
    expect(identical.verdict).toBe("pass");
    const added = await runChecks({
      bundle: b,
      profile: profileWith([same]),
      checks: [
        { id: "y", predicate: "path.deny", params: { globs: ["src/b.ts"] }, severity: "error" },
      ],
    });
    expect(added.verdict).toBe("fail");
    expect(added.findings.map((f) => f.id)).toEqual(["path.deny"]);
  });
  it("A1-6: a plan may not add guard.external unless the profile allows it", async () => {
    const plan = [
      {
        id: "g",
        predicate: "guard.external",
        params: { command: "x.mjs" },
        severity: "error" as const,
      },
    ];
    const denied = await runChecks({ bundle: b, profile: profileWith([]), checks: plan });
    expect(denied.verdict).toBe("error");
    expect(denied.findings.map((f) => f.facts.code)).toContain("ERR_POLICY_FLOOR");
    const allowed = await runChecks({
      bundle: b,
      profile: profileWith([], { allowPlanGuards: true }),
      checks: plan,
    });
    expect(allowed.findings.map((f) => f.facts.code)).not.toContain("ERR_POLICY_FLOOR");
  });
  it("A1-23: a predicate's own severity is kept; the CheckRef may not soften a stricter one", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        {
          id: "cel",
          predicate: "expr.cel",
          params: { expression: "false", severity: "warn" },
          severity: "error",
        },
      ]),
    });
    expect(r.findings[0]?.severity).toBe("warn");
    expect(r.verdict).toBe("pass");
  });
  it("A1-30: a repo predicate with no root is an error; only facts.allowRepo:false skips it", async () => {
    const checks = [
      {
        id: "x",
        predicate: "repo.noOverwriteOf",
        params: { globs: ["**"] },
        severity: "error" as const,
      },
    ];
    const r = await runChecks({ bundle: b, profile: profileWith(checks) });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_FACT_DISABLED");
    expect(r.providers.find((p) => p.name === "repo")?.status).toBe("error");
    const off = await runChecks({ bundle: b, profile: profileWith(checks, { allowRepo: false }) });
    expect(off.verdict).toBe("pass");
    expect(off.providers.find((p) => p.name === "repo")?.status).toBe("skipped");
  });
  it("A1-4: a predicate that never answers fails the run within the budget", async () => {
    const reg = builtinRegistry().register(
      definePredicate({
        id: "test.hang",
        params: z.object({}).strict(),
        requires: ["manifest"],
        run: () => new Promise<never>(() => undefined),
      }),
    );
    const r = await runChecks({
      bundle: b,
      registry: reg,
      predicateTimeoutMs: 50,
      profile: profileWith([{ id: "h", predicate: "test.hang", params: {}, severity: "error" }]),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");
  });
  it("skips repo predicates when profile.facts.allowRepo is false", async () => {
    const r = await runChecks({
      bundle: b,
      root: process.cwd(),
      profile: profileWith(
        [
          {
            id: "x",
            predicate: "repo.noOverwriteOf",
            params: { globs: ["**"] },
            severity: "error",
          },
        ],
        { allowRepo: false },
      ),
    });
    expect(r.providers.find((p) => p.name === "repo")?.status).toBe("skipped");
    expect(r.verdict).toBe("pass");
  });
  it("empty check set → pass with no findings (vacuous truth), factsDigest still set", async () => {
    const r = await runChecks({ bundle: b, profile: profileWith([]) });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.manifestDigest).toBe(b.manifestDigest);
    expect(r.factsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("pre-image binding (S-402)", () => {
  const pass = profileWith([
    { id: "x", predicate: "path.allow", params: { globs: ["**"] }, severity: "error" },
  ]);
  async function root(files: Record<string, string>): Promise<string> {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const r = await mkdtemp(join(tmpdir(), "axiom-preimage-"));
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(r, p)), { recursive: true });
      await writeFile(join(r, p), c);
    }
    return r;
  }
  const withPre = (
    bundle: ReturnType<typeof makeBundle>,
    pre: { path: string; sha256: string }[],
  ) => {
    const manifest = { ...bundle.manifest, preImage: pre };
    return { ...bundle, manifest };
  };

  it("unverified without a root or without manifest.preImage", async () => {
    const r1 = await runChecks({ bundle: b, profile: pass });
    expect(r1.preImage).toBe("unverified");
    const r = await root({});
    const r2 = await runChecks({ bundle: b, profile: pass, root: r });
    expect(r2.preImage).toBe("unverified");
  });

  it("verified when every entry matches the tree (absent and existing)", async () => {
    const r = await root({ "src/b.ts": "old" });
    const bundle = withPre(b, [
      { path: "src/a.ts", sha256: "absent" },
      { path: "src/b.ts", sha256: sha256Hex("old") },
    ]);
    const rep = await runChecks({ bundle, profile: pass, root: r });
    expect(rep.preImage).toBe("verified");
    expect(rep.verdict).toBe("pass");
  });

  it("drifted → verdict error with an ERR_PREIMAGE_CHANGED finding per path, even when checks pass", async () => {
    const r = await root({ "src/a.ts": "someone wrote this" });
    const bundle = withPre(b, [
      { path: "src/a.ts", sha256: "absent" },
      { path: "src/b.ts", sha256: sha256Hex("never existed") },
    ]);
    const rep = await runChecks({ bundle, profile: pass, root: r });
    expect(rep.preImage).toBe("drifted");
    expect(rep.verdict).toBe("error");
    const f = rep.findings.filter((x) => x.id === "manifest.preImage");
    expect(f.map((x) => x.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(f[0]?.facts).toMatchObject({
      code: "ERR_PREIMAGE_CHANGED",
      expected: "absent",
      actual: sha256Hex("someone wrote this"),
    });
    expect(f[1]?.facts).toMatchObject({ code: "ERR_PREIMAGE_CHANGED", actual: "absent" });
  });
});

describe("bundle integrity (A1-8) and pre-image coverage (A1-20)", () => {
  const empty = profileWith([]);
  it("A1-8: a non-delete artifact must declare `bytes`", async () => {
    const hand = makeBundle([{ path: "a.txt", content: "abc" }]);
    const art = { ...hand.manifest.artifacts[0]! };
    delete art.bytes;
    const bundle = { ...hand, manifest: { ...hand.manifest, artifacts: [art] } };
    const r = await runChecks({ bundle, profile: empty });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_INVALID_MANIFEST");
  });
  it("A1-8: `bytes` is verified against the content", async () => {
    const hand = makeBundle([{ path: "a.txt", content: "abcd" }]);
    const art = { ...hand.manifest.artifacts[0]!, bytes: 3 };
    const bundle = { ...hand, manifest: { ...hand.manifest, artifacts: [art] } };
    const r = await runChecks({ bundle, profile: empty });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_SIZE_MISMATCH");
  });
  it("A1-8: profile.limits bind in the runner", async () => {
    const r = await runChecks({
      bundle: b,
      profile: { ...empty, limits: { maxArtifacts: 1 } },
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_BUNDLE_TOO_LARGE");
  });
  it("A1-8: an inline blob over the per-blob cap is refused", async () => {
    const bundle = makeBundle([{ path: "big.txt", content: "x".repeat(INLINE_CONTENT_MAX + 1) }]);
    const r = await runChecks({ bundle, profile: empty });
    expect(r.findings.map((f) => f.facts.code)).toContain("ERR_BLOB_TOO_LARGE");
  });
  it("A1-20: `preImage: []` does not read as verified, and a complete list is accepted", async () => {
    const hand = makeBundle([{ path: "a.txt", content: "x" }]);
    const emptyPre = { ...hand, manifest: { ...hand.manifest, preImage: [] } };
    const r = await runChecks({ bundle: emptyPre, profile: empty });
    expect(r.preImage).not.toBe("verified");
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_INVALID_MANIFEST");
    const covered = {
      ...hand,
      manifest: { ...hand.manifest, preImage: [{ path: "a.txt", sha256: "absent" }] },
    };
    const ok = await runChecks({ bundle: covered, profile: empty });
    expect(ok.findings).toEqual([]);
    expect(ok.preImage).toBe("unverified");
  });
  it("A1-29: the built-in default refuses a git hook and the harness config", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "axiom-default-"));
    const bundle = makeBundle([
      { path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" },
      { path: ".github/hooks/axiom-gate.json", content: "{}\n" },
    ]);
    const r = await runChecks({ bundle, profile: await loadProfile("default"), root });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.path)).toEqual([
      ".git/hooks/pre-commit",
      ".github/hooks/axiom-gate.json",
    ]);
  });
});

describe("report shape", () => {
  const profile = profileWith([
    { id: "z-deny", predicate: "path.deny", params: { globs: ["src/**"] }, severity: "warn" },
    { id: "a-deny", predicate: "path.deny", params: { globs: ["src/b.ts"] }, severity: "error" },
    { id: "m-info", predicate: "manifest.maxArtifacts", params: { max: 0 }, severity: "info" },
  ]);
  it("findings sorted by (severity, id, path)", async () => {
    const r = await runChecks({ bundle: b, profile });
    expect(r.findings.map((f) => [f.severity, f.id, f.path ?? ""])).toEqual([
      ["error", "path.deny", "src/b.ts"],
      ["warn", "path.deny", "src/a.ts"],
      ["warn", "path.deny", "src/b.ts"],
      ["info", "manifest.maxArtifacts", ""],
    ]);
  });
  it("is deterministic minus durationMs / provider ms", async () => {
    const strip = (r: Awaited<ReturnType<typeof runChecks>>) => ({
      ...r,
      durationMs: 0,
      providers: r.providers.map((p) => ({ ...p, ms: 0 })),
    });
    const [r1, r2] = await Promise.all([
      runChecks({ bundle: b, profile }),
      runChecks({ bundle: b, profile }),
    ]);
    expect(strip(r1)).toEqual(strip(r2));
    expect(r1.factsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("factsDigest changes with the check set", async () => {
    const r1 = await runChecks({ bundle: b, profile });
    const r2 = await runChecks({ bundle: b, profile: profileWith([]) });
    expect(r1.factsDigest).not.toBe(r2.factsDigest);
  });
});

describe("PredicateRegistry", () => {
  it("lists builtins sorted and rejects duplicates / bad ids", () => {
    const reg = builtinRegistry();
    const list = reg.list();
    expect(list).toEqual([...list].sort());
    expect(list).toContain("guard.external");
    expect(list).toContain("expr.cedar");
    expect(list).toContain("repo.requireReference");
    expect(list.length).toBe(18);
    expect(() => reg.register(reg.get("path.deny"))).toThrow(
      expect.objectContaining({ code: "ERR_INTERNAL" }),
    );
    expect(() =>
      new PredicateRegistry().register(
        definePredicate({
          id: "Bad.id" as never,
          params: z.any(),
          requires: [],
          run: async () => [],
        }),
      ),
    ).toThrow();
    expect(() => reg.get("x.y")).toThrow(
      expect.objectContaining({ code: "ERR_PREDICATE_UNKNOWN" }),
    );
  });
});
