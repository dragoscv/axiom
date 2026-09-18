import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ApplyResult, CheckReport, ManifestBundle } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness, makePlan, structured, textOf, tmpRepo } from "./test-helpers.js";
import { BUNDLE_BYTES_MAX, TOOL_DEFS } from "./tools.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let other: Awaited<ReturnType<typeof tmpRepo>>;
let h: Harness;

beforeEach(async () => {
  repo = await tmpRepo("axiom-mcp-");
  other = await tmpRepo("axiom-mcp-other-");
  h = await harness([repo.root]);
});
afterEach(async () => {
  await h.close();
  await Promise.all([repo.cleanup(), other.cleanup()]);
});

const plan = () =>
  makePlan({ "src/a.ts": "export const a = 1;\n", "README.md": "# hi\n" }, { name: "demo" });

describe("tools/list", () => {
  it("exposes 11 tools with annotations, input and output schemas", async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(11);
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_DEFS.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
    const applyTool = tools.find((t) => t.name === "axiom_apply");
    expect(applyTool?.annotations?.destructiveHint).toBe(true);
    expect(applyTool?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("full pipeline", () => {
  it("validate → compile → check → dry-run → apply → resource → rollback", async () => {
    const v = await h.call("axiom_plan_validate", { plan: plan() });
    expect(v.isError).toBeUndefined();
    expect(structured<{ ok: boolean; planDigest: string }>(v).ok).toBe(true);
    expect(structured<{ planDigest: string }>(v).planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const c = await h.call("axiom_plan_compile", { plan: plan(), root: repo.root });
    expect(c.isError).toBeUndefined();
    const bundle = structured<ManifestBundle>(c);
    const digest = bundle.manifestDigest;
    expect(bundle.manifest.artifacts.map((a) => a.path)).toEqual(["README.md", "src/a.ts"]);
    // text summary is small and never the bundle
    const summary = JSON.parse(textOf(c)) as Record<string, unknown>;
    expect(summary.manifestDigest).toBe(digest);
    expect(summary.blobs).toBe(2); // a count, never the blob map
    expect(textOf(c).length).toBeLessThan(400);
    // stored under <root>/.axiom/manifests/<hex>.json
    await expect(
      stat(join(repo.root, ".axiom", "manifests", `${digest.slice(7)}.json`)),
    ).resolves.toBeTruthy();

    const ver = await h.call("axiom_manifest_verify", { bundle });
    expect(structured<{ ok: boolean; canonical: boolean }>(ver)).toMatchObject({
      ok: true,
      canonical: true,
    });

    const chk = await h.call("axiom_check", { bundle, root: repo.root });
    expect(chk.isError).toBeUndefined();
    expect(structured<CheckReport>(chk).verdict).toBe("pass");
    expect(structured<CheckReport>(chk).profile).toBe("default");

    const dry = await h.call("axiom_apply_dry_run", { bundle, root: repo.root });
    expect(dry.isError).toBeUndefined();
    const dryRes = structured<ApplyResult>(dry);
    expect(dryRes.mode).toBe("dry-run");
    expect(dryRes.status).toBe("applied");
    await expect(stat(join(repo.root, "src", "a.ts"))).rejects.toThrow();

    const ap = await h.call("axiom_apply", { bundle, root: repo.root, confirmDigest: digest });
    expect(ap.isError).toBeUndefined();
    const apRes = structured<ApplyResult>(ap);
    expect(apRes.status).toBe("applied");
    expect(await readFile(join(repo.root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");

    // idempotent re-apply
    const again = structured<ApplyResult>(
      await h.call("axiom_apply", { bundle, root: repo.root, confirmDigest: digest }),
    );
    expect(again.status).toBe("noop");

    // resources
    const applied = await h.client.readResource({ uri: `axiom://applied/${digest.slice(7)}` });
    expect(JSON.parse(applied.contents[0]?.text as string)).toMatchObject({
      kind: "ApplyResult",
      manifestDigest: digest,
    });
    const man = await h.client.readResource({ uri: `axiom://manifest/${digest.slice(7)}` });
    expect(JSON.parse(man.contents[0]?.text as string).manifestDigest).toBe(digest);
    const rep = await h.client.readResource({ uri: `axiom://report/${digest.slice(7)}` });
    expect(JSON.parse(rep.contents[0]?.text as string).kind).toBe("CheckReport");
    const prof = await h.client.readResource({ uri: "axiom://profile/strict" });
    expect(JSON.parse(prof.contents[0]?.text as string)).toMatchObject({
      kind: "Profile",
      name: "strict",
    });
    const sch = await h.client.readResource({ uri: "axiom://schema/Plan" });
    expect(JSON.parse(sch.contents[0]?.text as string).title).toBe("Plan");
    const em = await h.client.readResource({ uri: "axiom://emitters" });
    const rows = JSON.parse(em.contents[0]?.text as string) as {
      emitter: string;
      version: string;
    }[];
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ emitter: "web", version: "2.0.0", template: "biome.config" });
    const templates = await h.client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "axiom://applied/{sha}",
      "axiom://manifest/{sha}",
      "axiom://profile/{name}",
      "axiom://report/{sha}",
      "axiom://schema/{kind}",
    ]);

    // diff by digest ref against a modified bundle
    const c2 = await h.call("axiom_plan_compile", {
      plan: makePlan({ "src/a.ts": "export const a = 2;\n", "src/b.ts": "" }, { name: "demo" }),
    });
    const d = await h.call("axiom_manifest_diff", { a: digest, b: structured<ManifestBundle>(c2) });
    expect(d.isError).toBeUndefined();
    expect(
      structured<{ added: string[]; removed: string[]; changed: { path: string }[] }>(d),
    ).toMatchObject({
      added: ["src/b.ts"],
      removed: ["README.md"],
      changed: [{ path: "src/a.ts" }],
    });

    // rollback
    const rb = await h.call("axiom_rollback", { root: repo.root, manifestDigest: digest });
    expect(rb.isError).toBeUndefined();
    expect(structured<{ status: string; phase: string }>(rb)).toMatchObject({
      status: "rolled-back",
      phase: "rolled-back",
    });
    await expect(stat(join(repo.root, "src", "a.ts"))).rejects.toThrow();
    await expect(
      stat(join(repo.root, ".axiom", "applied", `${digest.slice(7)}.json`)),
    ).rejects.toThrow();

    const roots = await h.call("axiom_roots_list");
    expect(structured<{ roots: { path: string; writable: boolean }[] }>(roots).roots).toHaveLength(
      1,
    );
    expect(structured<{ roots: { writable: boolean }[] }>(roots).roots[0]?.writable).toBe(true);
  });
});

describe("axiom_axm_parse", () => {
  const AXM =
    'axiom "2"\nplan demo {\n  intent "x"\n  artifact "src/a.ts" {\n    inline <<EOF\nexport const a = 1;\nEOF\n  }\n}\n';

  it("parses .axm text into a Plan that axiom_plan_compile accepts", async () => {
    const r = await h.call("axiom_axm_parse", { source: AXM });
    expect(r.isError).toBeUndefined();
    const out = structured<{ plan?: { name: string }; diagnostics: unknown[] }>(r);
    expect(out.diagnostics).toEqual([]);
    expect(out.plan?.name).toBe("demo");
    const c = await h.call("axiom_plan_compile", { plan: out.plan });
    expect(c.isError).toBeUndefined();
    expect(structured<ManifestBundle>(c).manifest.artifacts.map((a) => a.path)).toEqual([
      "src/a.ts",
    ]);
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, name: "demo" });
  });

  it("returns positioned diagnostics (not isError) on a syntax error", async () => {
    const r = await h.call("axiom_axm_parse", {
      source: 'axiom "2"\nplan demo {\n  intent 42\n}\n',
    });
    expect(r.isError).toBeUndefined();
    const out = structured<{
      plan?: unknown;
      diagnostics: { code: string; range: { start: { line: number; column: number } } }[];
    }>(r);
    expect(out.plan).toBeUndefined();
    expect(out.diagnostics[0]?.code).toBe("ERR_INVALID_PLAN");
    expect(out.diagnostics[0]?.range.start).toEqual({ line: 3, column: 10 });
  });

  it("oversized source → ERR_BUNDLE_TOO_LARGE", async () => {
    const r = await h.call("axiom_axm_parse", { source: "x".repeat(BUNDLE_BYTES_MAX + 1) });
    expect(r.isError).toBe(true);
    expect(structured<{ code: string }>(r).code).toBe("ERR_BUNDLE_TOO_LARGE");
  });
});

describe("error handling", () => {
  const compiled = async () =>
    structured<ManifestBundle>(await h.call("axiom_plan_compile", { plan: plan() }));

  it("apply without confirmDigest → isError ERR_CONFIRM_DIGEST_MISMATCH, nothing written", async () => {
    const bundle = await compiled();
    const r = await h.call("axiom_apply", { bundle, root: repo.root });
    expect(r.isError).toBe(true);
    expect(structured<{ code: string }>(r).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(JSON.parse(textOf(r)).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    await expect(stat(join(repo.root, "src", "a.ts"))).rejects.toThrow();
  });

  it("apply with a wrong confirmDigest → ERR_CONFIRM_DIGEST_MISMATCH", async () => {
    const bundle = await compiled();
    const r = await h.call("axiom_apply", {
      bundle,
      root: repo.root,
      confirmDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(r.isError).toBe(true);
    expect(structured<{ code: string }>(r).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
  });

  it("root outside the allowlist → ERR_ROOT_NOT_ALLOWED for every root-taking tool", async () => {
    const bundle = await compiled();
    for (const [name, args] of [
      ["axiom_plan_compile", { plan: plan(), root: other.root }],
      ["axiom_check", { bundle, root: other.root }],
      ["axiom_apply_dry_run", { bundle, root: other.root }],
      ["axiom_apply", { bundle, root: other.root, confirmDigest: bundle.manifestDigest }],
      ["axiom_rollback", { root: other.root, manifestDigest: bundle.manifestDigest }],
    ] as const) {
      const r = await h.call(name, args as Record<string, unknown>);
      expect(r.isError, name).toBe(true);
      expect(structured<{ code: string }>(r).code, name).toBe("ERR_ROOT_NOT_ALLOWED");
    }
  });

  it("no root with several allowlisted roots → ERR_ROOT_REQUIRED", async () => {
    const multi = await harness([repo.root, other.root]);
    try {
      const bundle = await compiled();
      const r = await multi.call("axiom_apply_dry_run", { bundle });
      expect(r.isError).toBe(true);
      expect(structured<{ code: string }>(r).code).toBe("ERR_ROOT_REQUIRED");
    } finally {
      await multi.close();
    }
  });

  it("oversized bundle → ERR_BUNDLE_TOO_LARGE before deeper parsing", async () => {
    const bundle = await compiled();
    const huge = {
      ...bundle,
      blobs: {
        ...bundle.blobs,
        [`sha256:${"f".repeat(64)}`]: { encoding: "utf8", data: "x".repeat(BUNDLE_BYTES_MAX) },
      },
    };
    const r = await h.call("axiom_manifest_verify", { bundle: huge });
    expect(r.isError).toBe(true);
    expect(structured<{ code: string }>(r).code).toBe("ERR_BUNDLE_TOO_LARGE");
  });

  it("bad input shape → isError result, not a thrown protocol error", async () => {
    const r1 = await h.call("axiom_check", { bundle: { nope: true }, root: repo.root });
    expect(r1.isError).toBe(true);
    expect(structured<{ code: string }>(r1).code).toBe("ERR_INVALID_MANIFEST");

    const r2 = await h.call("axiom_plan_validate", { plan: { kind: "Nope" } });
    expect(r2.isError).toBeUndefined();
    expect(structured<{ ok: boolean; errors: unknown[] }>(r2).ok).toBe(false);
    expect(structured<{ errors: unknown[] }>(r2).errors.length).toBeGreaterThan(0);

    const r3 = await h.call("axiom_plan_compile", { plan: { kind: "Nope" } });
    expect(r3.isError).toBe(true);
    expect(structured<{ code: string }>(r3).code).toBe("ERR_INVALID_PLAN");

    const r4 = await h.call("axiom_manifest_diff", {
      a: `sha256:${"a".repeat(64)}`,
      b: `sha256:${"b".repeat(64)}`,
    });
    expect(r4.isError).toBe(true);
    expect(structured<{ code: string }>(r4).code).toBe("ERR_NOT_FOUND");

    const r5 = await h.call("axiom_rollback", { root: repo.root, manifestDigest: "not-a-digest" });
    expect(r5.isError).toBe(true);
    expect(structured<{ code: string }>(r5).code).toBe("ERR_NOT_FOUND");
  });

  it("wrong argument types are rejected by the SDK input validation as isError, not a crash", async () => {
    const r = await h.call("axiom_check", { bundle: "string" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid arguments/);
  });

  it("checks failing block apply with ERR_CHECKS_FAILED and leave the tree untouched", async () => {
    const secret = makePlan(
      { ".env": "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEabcdefghijklmnopqrstu\n" },
      { name: "leak" },
    );
    const bundle = structured<ManifestBundle>(await h.call("axiom_plan_compile", { plan: secret }));
    const r = await h.call("axiom_apply", {
      bundle,
      root: repo.root,
      confirmDigest: bundle.manifestDigest,
    });
    expect(r.isError).toBeUndefined();
    const res = structured<ApplyResult>(r);
    expect(res.status).not.toBe("applied");
    expect(res.error?.code).toBe("ERR_CHECKS_FAILED");
    await expect(stat(join(repo.root, ".env"))).rejects.toThrow();
  });
});
