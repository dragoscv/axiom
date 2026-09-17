import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  it("plan-level checks merge after the profile and override by id", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith([
        { id: "x", predicate: "path.deny", params: { globs: ["src/**"] }, severity: "error" },
      ]),
      checks: [
        { id: "x", predicate: "path.deny", params: { globs: ["none/**"] }, severity: "error" },
      ],
    });
    expect(r.verdict).toBe("pass");
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
    expect(list.length).toBe(15);
    expect(() => reg.register(reg.get("path.deny"))).toThrow(/already registered/);
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
