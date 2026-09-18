import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@codai/axiom-canon";
import { type AxiomError, isAxiomError, type PlanInput } from "@codai/axiom-schema";
import { afterEach, describe, expect, it } from "vitest";
import { casPath } from "./cas.js";
import { compilePlan } from "./compile.js";

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
    const inl = await compilePlan(p);
    const cas = await compilePlan(p, { store: "cas", root });
    expect(cas.bundle.manifestDigest).toBe(inl.bundle.manifestDigest);
    expect(Object.keys(inl.bundle.blobs)).toHaveLength(2);
    expect(cas.bundle.blobs).toEqual({});
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(casPath(root, sha256Hex("hello")))).toString()).toBe("hello");
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

  it("template → ERR_UNSUPPORTED_OP", async () => {
    await expectAxiom(
      compilePlan(
        plan([{ path: "t", source: { type: "template", emitter: "webapp", template: "page" } }]),
      ),
      "ERR_UNSUPPORTED_OP",
    );
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
