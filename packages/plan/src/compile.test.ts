import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { type AxiomError, isAxiomError, type PlanInput } from "@codai/axiom-schema";
import { afterEach, describe, expect, it } from "vitest";
import { casPath } from "./cas.js";
import { compilePlan } from "./compile.js";
import { createEmitterRegistry, type TemplateEmitter } from "./template.js";

function plan(artifacts: PlanInput["artifacts"], extra: Partial<PlanInput> = {}): PlanInput {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: "blog",
    intent: "test",
    artifacts,
    ...extra,
  };
}

const inline = (path: string, content: string): PlanInput["artifacts"][number] => ({
  path,
  source: { type: "inline", content },
});

async function expectAxiom(p: Promise<unknown>, code: string): Promise<AxiomError> {
  try {
    await p;
  } catch (err) {
    expect(isAxiomError(err)).toBe(true);
    expect((err as AxiomError).code).toBe(code);
    return err as AxiomError;
  }
  throw new Error(`expected ${code}`);
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "axiom-plan-"));
  tmpDirs.push(d);
  return d;
}

describe("compilePlan — happy path", () => {
  it("compiles inline sources into a content-addressed bundle", async () => {
    const { bundle, statement } = await compilePlan(
      plan([inline("src/a.ts", "export const a = 1;\n"), inline("README.md", "# hi\n")]),
    );
    expect(bundle.manifest.kind).toBe("Manifest");
    expect(bundle.manifest.artifacts.map((a) => a.path)).toEqual(["README.md", "src/a.ts"]);
    const a = bundle.manifest.artifacts[1]!;
    expect(a.digest?.sha256).toBe(sha256Hex("export const a = 1;\n"));
    expect(a.bytes).toBe(20);
    expect(a.origin).toBe("inline");
    expect(a.mode).toBe("0644");
    expect(a.op).toBe("create");
    expect(Object.keys(bundle.blobs)).toHaveLength(2);
    expect(bundle.blobs[`sha256:${a.digest!.sha256}`]).toEqual({
      encoding: "utf8",
      data: "export const a = 1;\n",
    });
    expect(bundle.manifest.toolchain).toEqual({ axiom: "2.0.0", emitters: {} });
    expect(bundle.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(statement.subject[0]).toEqual({
      name: "blog",
      digest: { sha256: bundle.manifestDigest.slice(7) },
    });
    expect(statement.predicate.runDetails.byproducts.map((b) => b.name)).toEqual([
      "README.md",
      "src/a.ts",
    ]);
    expect(statement.predicate.runDetails.metadata).toBeUndefined();
    expect(bundle.attestation).toEqual(statement);
  });

  it("splits toolchain into axiom + emitters and sorts checks by id", async () => {
    const { bundle } = await compilePlan(
      plan([inline("a", "x")], {
        checks: [
          { id: "zeta", predicate: "path.deny", params: {} },
          { id: "alpha", predicate: "path.allow", params: [] },
        ],
      }),
      { toolchain: { webapp: "1.2.3", axiom: "9.9.9" } },
    );
    expect(bundle.manifest.toolchain).toEqual({ axiom: "9.9.9", emitters: { webapp: "1.2.3" } });
    expect(bundle.manifest.checks.map((c) => c.id)).toEqual(["alpha", "zeta"]);
  });

  it("records metadata when a clock/invocationId is given, without touching the digest", async () => {
    const p = plan([inline("a", "x")]);
    const plain = await compilePlan(p);
    let n = 0;
    const timed = await compilePlan(p, {
      now: () => `2026-09-18T00:00:0${n++}Z`,
      invocationId: "inv-1",
    });
    expect(timed.statement.predicate.runDetails.metadata).toEqual({
      invocationId: "inv-1",
      startedOn: "2026-09-18T00:00:00Z",
      finishedOn: "2026-09-18T00:00:01Z",
    });
    expect(timed.bundle.manifestDigest).toBe(plain.bundle.manifestDigest);
  });

  it("delete op has no digest, bytes or origin and no blob", async () => {
    const { bundle } = await compilePlan(
      plan([{ path: "old.txt", op: "delete" }, inline("new.txt", "n")]),
    );
    const del = bundle.manifest.artifacts.find((a) => a.path === "old.txt")!;
    expect(del).toEqual({ path: "old.txt", op: "delete", mode: "0644" });
    expect(Object.keys(bundle.blobs)).toHaveLength(1);
    expect(bundle.attestation?.subject).toHaveLength(1);
  });

  it("100-level nesting compiles; the input plan object is not mutated", async () => {
    const p = `${Array.from({ length: 100 }, (_, i) => `d${i}`).join("/")}/leaf.ts`;
    const input = plan([inline(p, "x")]);
    const frozen = structuredClone(input);
    const { bundle } = await compilePlan(input);
    expect(bundle.manifest.artifacts).toHaveLength(1);
    expect(bundle.manifest.artifacts[0]?.path).toBe(p);
    expect(bundle.manifest.artifacts[0]?.digest?.sha256).toBe(sha256Hex("x"));
    expect(input).toEqual(frozen);
  });
});

describe("compilePlan — determinism", () => {
  it("same plan twice → identical manifestDigest and JCS body", async () => {
    const p = plan([inline("b", "2"), inline("a", "1")]);
    const x = await compilePlan(p);
    const y = await compilePlan(p);
    expect(x.bundle.manifestDigest).toBe(y.bundle.manifestDigest);
    expect(canonicalize(x.bundle.manifest)).toBe(canonicalize(y.bundle.manifest));
  });

  it("artifact order in the plan does not change the digest", async () => {
    const x = await compilePlan(plan([inline("b", "2"), inline("a", "1"), inline("c/d", "3")]));
    const y = await compilePlan(plan([inline("c/d", "3"), inline("a", "1"), inline("b", "2")]));
    expect(x.bundle.manifestDigest).toBe(y.bundle.manifestDigest);
    expect(x.bundle.manifest.planDigest).toBe(y.bundle.manifest.planDigest);
  });

  it("inline vs cas store → same manifestDigest, different blobs", async () => {
    const root = await tmp();
    const p = plan([inline("a.txt", "hello"), inline("b.bin", "world")]);
    // Both against the same root: transport must not change the digest. (Without a root the
    // manifest carries no `preImage` and therefore legitimately differs — see S-402 tests.)
    const inl = await compilePlan(p, { root });
    const cas = await compilePlan(p, { store: "cas", root });
    expect(cas.bundle.manifestDigest).toBe(inl.bundle.manifestDigest);
    expect(Object.keys(inl.bundle.blobs)).toHaveLength(2);
    expect(cas.bundle.blobs).toEqual({});
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(casPath(root, sha256Hex("hello")))).toString()).toBe("hello");
  });

  describe("pre-image binding (S-402)", () => {
    it("with a root, manifest.preImage lists every artifact path (sorted) with sha256 or absent", async () => {
      const root = await tmp();
      await writeFile(join(root, "b.txt"), "old b");
      const { bundle } = await compilePlan(
        plan([inline("b.txt", "new b"), inline("a.txt", "a"), { path: "z.txt", op: "delete" }]),
        { root },
      );
      expect(bundle.manifest.preImage).toEqual([
        { path: "a.txt", sha256: "absent" },
        { path: "b.txt", sha256: sha256Hex("old b") },
        { path: "z.txt", sha256: "absent" },
      ]);
    });
    it("without a root (and no reader) there is no preImage; the same plan against two trees has two manifestDigests but one planDigest", async () => {
      const p = plan([inline("f.txt", "x")]);
      const none = await compilePlan(p);
      expect(none.bundle.manifest.preImage).toBeUndefined();
      const r1 = await tmp();
      const r2 = await tmp();
      await writeFile(join(r2, "f.txt"), "pre-existing");
      const c1 = await compilePlan(p, { root: r1 });
      const c2 = await compilePlan(p, { root: r2 });
      expect(c1.bundle.manifest.planDigest).toBe(c2.bundle.manifest.planDigest);
      expect(c1.bundle.manifestDigest).not.toBe(c2.bundle.manifestDigest);
      expect(c1.bundle.manifestDigest).not.toBe(none.bundle.manifestDigest);
      // Same tree twice → identical manifest.
      expect((await compilePlan(p, { root: r1 })).bundle.manifestDigest).toBe(
        c1.bundle.manifestDigest,
      );
    });
    it("a directory or symlink at an artifact path counts as absent (apply rejects the write itself)", async () => {
      const root = await tmp();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(root, "dir.txt"));
      const { bundle } = await compilePlan(plan([inline("dir.txt", "x")]), { root });
      expect(bundle.manifest.preImage).toEqual([{ path: "dir.txt", sha256: "absent" }]);
    });
  });

  it("a cas source is read back, re-hashed and inlined into blobs", async () => {
    const root = await tmp();
    const hex = sha256Hex("hello");
    await compilePlan(plan([inline("a.txt", "hello")]), { store: "cas", root });
    const viaCas = await compilePlan(
      plan([{ path: "a.txt", source: { type: "cas", digest: `sha256:${hex}` } }]),
      { root },
    );
    const viaInline = await compilePlan(plan([inline("a.txt", "hello")]));
    const [casArt] = viaCas.bundle.manifest.artifacts;
    const [inlArt] = viaInline.bundle.manifest.artifacts;
    expect(casArt?.digest).toEqual(inlArt?.digest);
    expect(casArt?.bytes).toBe(inlArt?.bytes);
    // source.type is part of the plan digest (§2.3 `{type, digest}`), so it differs
    expect(casArt?.origin).toBe("cas");
    expect(viaCas.bundle.manifest.planDigest).not.toBe(viaInline.bundle.manifest.planDigest);
    expect(viaCas.bundle.blobs[`sha256:${hex}`]?.data).toBe("hello");
  });
});

describe("compilePlan — encoding", () => {
  it("utf8 text stays utf8; bytes with NUL go base64", async () => {
    const bin = Buffer.from([0x00, 0x01, 0xff, 0x41]);
    const { bundle } = await compilePlan(
      plan([
        inline("t.txt", "héllo ✓"),
        {
          path: "b.bin",
          source: { type: "inline", content: bin.toString("base64"), encoding: "base64" },
        },
      ]),
    );
    const t = bundle.blobs[`sha256:${sha256Hex("héllo ✓")}`];
    expect(t).toEqual({ encoding: "utf8", data: "héllo ✓" });
    const b = bundle.blobs[`sha256:${sha256Hex(bin)}`];
    expect(b).toEqual({ encoding: "base64", data: bin.toString("base64") });
  });

  it("base64 that decodes to valid text becomes a utf8 blob", async () => {
    const { bundle } = await compilePlan(
      plan([
        {
          path: "x",
          source: {
            type: "inline",
            content: Buffer.from("plain").toString("base64"),
            encoding: "base64",
          },
        },
      ]),
    );
    expect(bundle.blobs[`sha256:${sha256Hex("plain")}`]).toEqual({
      encoding: "utf8",
      data: "plain",
    });
  });

  it("invalid utf8 without NUL goes base64", async () => {
    const bin = Buffer.from([0xc3, 0x28]);
    const { bundle } = await compilePlan(
      plan([
        {
          path: "x",
          source: { type: "inline", content: bin.toString("base64"), encoding: "base64" },
        },
      ]),
    );
    expect(bundle.blobs[`sha256:${sha256Hex(bin)}`]?.encoding).toBe("base64");
  });
});

describe("compilePlan — limits", () => {
  it("utf8 content > 256 KiB as bytes → ERR_BLOB_TOO_LARGE", async () => {
    // 200k chars of a 2-byte glyph: passes the schema string-length cap, exceeds the byte cap
    const content = "é".repeat(200 * 1024);
    await expectAxiom(compilePlan(plan([inline("big", content)])), "ERR_BLOB_TOO_LARGE");
  });

  it("base64 decoding to exactly 192 KiB is accepted; one byte more is rejected", async () => {
    const ok = Buffer.alloc(192 * 1024, 7).toString("base64");
    const { bundle } = await compilePlan(
      plan([{ path: "big", source: { type: "inline", content: ok, encoding: "base64" } }]),
    );
    expect(bundle.manifest.artifacts[0]?.bytes).toBe(192 * 1024);
    // 192 KiB + 1 byte encodes to > 256 KiB chars, so PlanSchema's string cap fires first
    const tooBig = Buffer.alloc(192 * 1024 + 1, 7).toString("base64");
    const err = await expectAxiom(
      compilePlan(
        plan([{ path: "big", source: { type: "inline", content: tooBig, encoding: "base64" } }]),
      ),
      "ERR_INVALID_PLAN",
    );
    expect(JSON.stringify(err.details)).toContain("too_big");
  });

  it("malformed base64 → ERR_INVALID_PLAN", async () => {
    await expectAxiom(
      compilePlan(
        plan([{ path: "x", source: { type: "inline", content: "!!!", encoding: "base64" } }]),
      ),
      "ERR_INVALID_PLAN",
    );
  });

  it("inline blobs over 4 MiB total → ERR_BUNDLE_TOO_LARGE, but cas store is fine", async () => {
    const chunk = "a".repeat(200 * 1024);
    const arts = Array.from({ length: 22 }, (_, i) => inline(`f${i}`, chunk + String(i)));
    await expectAxiom(compilePlan(plan(arts)), "ERR_BUNDLE_TOO_LARGE");
    const root = await tmp();
    const { bundle } = await compilePlan(plan(arts), { store: "cas", root });
    expect(bundle.manifest.artifacts).toHaveLength(22);
  });
});

describe("compilePlan — invalid input", () => {
  it("invalid plan → ERR_INVALID_PLAN with zod issues", async () => {
    const err = await expectAxiom(
      compilePlan({ apiVersion: "axiom.dev/v2", kind: "Plan", name: "Bad Name", artifacts: [] }),
      "ERR_INVALID_PLAN",
    );
    const issues = err.details?.issues as Array<{ path: unknown[] }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path[0] === "name")).toBe(true);
  });

  it("non-object → ERR_INVALID_PLAN", async () => {
    await expectAxiom(compilePlan(null), "ERR_INVALID_PLAN");
  });

  it("duplicate path → ERR_INVALID_PLAN", async () => {
    const err = await expectAxiom(
      compilePlan(plan([inline("a", "1"), inline("a", "2")])),
      "ERR_INVALID_PLAN",
    );
    expect(err.path).toBe("a");
  });

  it("duplicate check id → ERR_INVALID_PLAN", async () => {
    await expectAxiom(
      compilePlan(
        plan([inline("a", "1")], {
          checks: [
            { id: "c", predicate: "path.deny", params: {} },
            { id: "c", predicate: "path.allow", params: {} },
          ],
        }),
      ),
      "ERR_INVALID_PLAN",
    );
  });

  it("delete with a source / create without one → ERR_INVALID_PLAN", async () => {
    await expectAxiom(
      compilePlan(plan([{ path: "a", op: "delete", source: { type: "inline", content: "x" } }])),
      "ERR_INVALID_PLAN",
    );
    await expectAxiom(compilePlan(plan([{ path: "a" }])), "ERR_INVALID_PLAN");
  });

  it("bad RelPath → ERR_INVALID_PLAN", async () => {
    await expectAxiom(compilePlan(plan([inline("../x", "1")])), "ERR_INVALID_PLAN");
    await expectAxiom(compilePlan(plan([inline("C:/x", "1")])), "ERR_INVALID_PLAN");
  });
});

describe("compilePlan — sources", () => {
  it("ref → ERR_REF_OFFLINE", async () => {
    await expectAxiom(
      compilePlan(
        plan([
          {
            path: "v.bin",
            source: {
              type: "ref",
              uri: "https://example.com/v.bin",
              digest: `sha256:${sha256Hex("v")}`,
            },
          },
        ]),
      ),
      "ERR_REF_OFFLINE",
    );
  });

  it("template without a registry → ERR_EMITTER_UNKNOWN", async () => {
    const err = await expectAxiom(
      compilePlan(
        plan([{ path: "t", source: { type: "template", emitter: "webapp", template: "page" } }]),
      ),
      "ERR_EMITTER_UNKNOWN",
    );
    expect(err.details).toEqual({ emitter: "webapp", available: [] });
  });

  it("cas missing → ERR_BLOB_MISSING (with and without root)", async () => {
    const digest = `sha256:${sha256Hex("nope")}` as const;
    const p = plan([{ path: "a", source: { type: "cas", digest } }]);
    await expectAxiom(compilePlan(p), "ERR_BLOB_MISSING");
    await expectAxiom(compilePlan(p, { root: await tmp() }), "ERR_BLOB_MISSING");
  });

  it("cas content not matching its name → ERR_DIGEST_MISMATCH", async () => {
    const root = await tmp();
    const hex = sha256Hex("expected");
    const { mkdir } = await import("node:fs/promises");
    const target = casPath(root, hex);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "tampered");
    await expectAxiom(
      compilePlan(plan([{ path: "a", source: { type: "cas", digest: `sha256:${hex}` } }]), {
        root,
      }),
      "ERR_DIGEST_MISMATCH",
    );
  });
});

describe("compilePlan — patch sources (D-17)", () => {
  const pre = "line one\nline two\nline three\n";
  const preDigest = `sha256:${sha256Hex(pre)}` as const;
  const patchArtifact = (
    body: string,
    extra: Partial<{
      preImage: string;
      format: "unified" | "v4a" | "search-replace";
      path: string;
    }> = {},
  ): PlanInput["artifacts"][number] => ({
    path: extra.path ?? "notes.txt",
    op: "overwrite",
    source: {
      type: "patch",
      format: extra.format ?? "unified",
      preImage: (extra.preImage ?? preDigest) as `sha256:${string}`,
      body,
    },
  });
  const body = "@@ -1,3 +1,3 @@\n line one\n-line two\n+LINE TWO\n line three\n";

  it("reads the pre-image from the root, applies, and content-addresses the RESULT (origin: patch)", async () => {
    const root = await tmp();
    await writeFile(join(root, "notes.txt"), pre);
    const { bundle } = await compilePlan(plan([patchArtifact(body)]), { root });
    const a = bundle.manifest.artifacts[0];
    expect(a?.origin).toBe("patch");
    const expected = "line one\nLINE TWO\nline three\n";
    expect(a?.digest?.sha256).toBe(sha256Hex(expected));
    expect(a?.bytes).toBe(Buffer.byteLength(expected));
    // the blob is the full patched content, not the diff
    const blob = bundle.blobs[`sha256:${sha256Hex(expected)}`];
    expect(blob).toMatchObject({ encoding: "utf8", data: expected });
  });

  it("planDigest equals the equivalent inline plan's; manifestDigest differs only by origin", async () => {
    const root = await tmp();
    await writeFile(join(root, "notes.txt"), pre);
    const viaPatch = await compilePlan(plan([patchArtifact(body)]), { root });
    const viaInline = await compilePlan(
      plan([
        {
          path: "notes.txt",
          op: "overwrite",
          source: { type: "inline", content: "line one\nLINE TWO\nline three\n" },
        },
      ]),
    );
    expect(viaPatch.bundle.manifest.planDigest).toBe(viaInline.bundle.manifest.planDigest);
    expect(viaPatch.bundle.manifest.artifacts[0]?.digest).toEqual(
      viaInline.bundle.manifest.artifacts[0]?.digest,
    );
  });

  it("ERR_PATCH_PREIMAGE when the file under the root differs, is absent, or no root/reader is given", async () => {
    const root = await tmp();
    await writeFile(join(root, "notes.txt"), `${pre}extra\n`);
    const e1 = await expectAxiom(
      compilePlan(plan([patchArtifact(body)]), { root }),
      "ERR_PATCH_PREIMAGE",
    );
    expect(e1.path).toBe("notes.txt");
    expect(e1.details).toMatchObject({ expected: preDigest });
    const empty = await tmp();
    const e2 = await expectAxiom(
      compilePlan(plan([patchArtifact(body)]), { root: empty }),
      "ERR_PATCH_PREIMAGE",
    );
    expect(e2.details).toMatchObject({ actual: "absent" });
    await expectAxiom(compilePlan(plan([patchArtifact(body)])), "ERR_PATCH_PREIMAGE");
    // absent declared but file exists
    await writeFile(join(empty, "notes.txt"), pre);
    await expectAxiom(
      compilePlan(plan([patchArtifact(body, { preImage: "absent" })]), { root: empty }),
      "ERR_PATCH_PREIMAGE",
    );
  });

  it("ERR_PATCH_NO_MATCH and ERR_PATCH_FORMAT carry the artifact path", async () => {
    const root = await tmp();
    await writeFile(join(root, "notes.txt"), pre);
    const nm = await expectAxiom(
      compilePlan(plan([patchArtifact("@@ -1,2 +1,2 @@\n line one\n-nope\n+x\n")]), { root }),
      "ERR_PATCH_NO_MATCH",
    );
    expect(nm.path).toBe("notes.txt");
    const fm = await expectAxiom(
      compilePlan(plan([patchArtifact("garbage", { format: "v4a" })]), { root }),
      "ERR_PATCH_FORMAT",
    );
    expect(fm.path).toBe("notes.txt");
  });

  it("injected readPreImage lets a gate compile patches without touching disk; `absent` + v4a Add File creates", async () => {
    const files = new Map<string, string>([["notes.txt", pre]]);
    const readPreImage = async (rel: string) => {
      const v = files.get(rel);
      return v === undefined ? undefined : new TextEncoder().encode(v);
    };
    const add = "*** Begin Patch\n*** Add File: new.md\n+# New\n*** End Patch\n";
    const { bundle } = await compilePlan(
      plan([
        patchArtifact(body),
        { path: "new.md", source: { type: "patch", format: "v4a", preImage: "absent", body: add } },
      ]),
      { readPreImage },
    );
    expect(bundle.manifest.artifacts.map((a) => a.path)).toEqual(["new.md", "notes.txt"]);
    expect(bundle.manifest.artifacts[0]?.digest?.sha256).toBe(sha256Hex("# New\n"));
  });

  it("ERR_PATCH_PREIMAGE when the pre-image is not UTF-8 (binary files cannot be patched)", async () => {
    const root = await tmp();
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    await writeFile(join(root, "notes.txt"), bin);
    await expectAxiom(
      compilePlan(plan([patchArtifact(body, { preImage: `sha256:${sha256Hex(bin)}` })]), { root }),
      "ERR_PATCH_PREIMAGE",
    );
  });
});

describe("compilePlan — template sources", () => {
  const strParams = {
    safeParse(input: unknown) {
      const p = input as { name?: unknown };
      if (typeof p.name === "string" && p.name.length > 0)
        return { success: true as const, data: { name: p.name } };
      return {
        success: false as const,
        error: { issues: [{ path: ["name"], message: "expected non-empty string" }] },
      };
    },
  };
  const emitter = (version: string): TemplateEmitter => ({
    id: "demo",
    version,
    templates: {
      greet: {
        description: "hello file",
        params: strParams,
        render: (p: unknown) => `hello ${(p as { name: string }).name}\n`,
      },
      bin: {
        description: "bytes",
        params: strParams,
        render: () => new Uint8Array([0, 1, 2]),
      },
    },
  });
  const tpl = (
    path: string,
    template: string,
    params: Record<string, string> = { name: "ax" },
  ): PlanInput["artifacts"][number] => ({
    path,
    source: { type: "template", emitter: "demo", template, params },
  });

  it("renders through the registry, records origin + toolchain.emitters", async () => {
    const { bundle } = await compilePlan(plan([tpl("hi.txt", "greet"), tpl("b.bin", "bin")]), {
      emitters: createEmitterRegistry([emitter("1.2.3")]),
    });
    const hi = bundle.manifest.artifacts.find((a) => a.path === "hi.txt");
    expect(hi?.origin).toBe("template");
    expect(hi?.digest?.sha256).toBe(sha256Hex("hello ax\n"));
    expect(hi?.bytes).toBe(9);
    const b = bundle.manifest.artifacts.find((a) => a.path === "b.bin");
    expect(b?.digest?.sha256).toBe(sha256Hex(new Uint8Array([0, 1, 2])));
    expect(bundle.manifest.toolchain.emitters).toEqual({ demo: "1.2.3" });
    expect(Object.keys(bundle.blobs)).toHaveLength(2);
    expect(bundle.attestation.predicate.runDetails.builder.version).toMatchObject({
      "emitter:demo": "1.2.3",
    });
  });

  it("emitter version is part of the manifest digest; params are part of the plan digest", async () => {
    const p = plan([tpl("hi.txt", "greet")]);
    const a = await compilePlan(p, { emitters: createEmitterRegistry([emitter("1.0.0")]) });
    const b = await compilePlan(p, { emitters: createEmitterRegistry([emitter("1.0.0")]) });
    const c = await compilePlan(p, { emitters: createEmitterRegistry([emitter("1.0.1")]) });
    expect(a.bundle.manifestDigest).toBe(b.bundle.manifestDigest);
    expect(c.bundle.manifestDigest).not.toBe(a.bundle.manifestDigest);
    expect(c.bundle.manifest.planDigest).toBe(a.bundle.manifest.planDigest);

    const d = await compilePlan(plan([tpl("hi.txt", "greet", { name: "bx" })]), {
      emitters: createEmitterRegistry([emitter("1.0.0")]),
    });
    expect(d.bundle.manifest.planDigest).not.toBe(a.bundle.manifest.planDigest);
  });

  it("unknown emitter / unknown template / bad params → closed error codes", async () => {
    const emitters = createEmitterRegistry([emitter("1.0.0")]);
    const e1 = await expectAxiom(
      compilePlan(
        plan([{ path: "t", source: { type: "template", emitter: "nope", template: "greet" } }]),
        { emitters },
      ),
      "ERR_EMITTER_UNKNOWN",
    );
    expect(e1.details?.available).toEqual(["demo"]);
    const e2 = await expectAxiom(
      compilePlan(plan([tpl("t", "missing")]), { emitters }),
      "ERR_TEMPLATE_UNKNOWN",
    );
    expect(e2.details?.available).toEqual(["bin", "greet"]);
    const e3 = await expectAxiom(
      compilePlan(plan([tpl("t", "greet", { name: "" })]), { emitters }),
      "ERR_TEMPLATE_PARAMS",
    );
    expect(e3.path).toBe("t");
    expect(Array.isArray(e3.details?.issues)).toBe(true);
    // prototype keys are not templates
    await expectAxiom(
      compilePlan(plan([tpl("t", "toString")]), { emitters }),
      "ERR_TEMPLATE_UNKNOWN",
    );
  });

  it("createEmitterRegistry rejects duplicate ids and lists sorted", () => {
    expect(() => createEmitterRegistry([emitter("1"), emitter("2")])).toThrow(/duplicate/);
    const r = createEmitterRegistry([{ ...emitter("1"), id: "zeta" }, emitter("1")]);
    expect(r.list()).toEqual(["demo", "zeta"]);
    expect(r.get("zeta")?.version).toBe("1");
    expect(r.get("x")).toBeUndefined();
  });
});
