import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compilePlan } from "@codai/axiom-plan";
import { AxiomError, type Plan, PlanSchema } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { findClockKeys, migrateV1, normaliseV1Path, V1ManifestSchema } from "./migrate.js";
import { tmpRepo } from "./test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "fixtures", "v1");
const CLI = join(here, "..", "dist", "cli.js");
const execFileP = promisify(execFile);

interface V1Artifact {
  path: string;
  kind?: string;
  sha256: string;
  bytes: number;
  contentUtf8?: string;
  contentBase64?: string;
}
interface V1 {
  profile?: string;
  artifacts: V1Artifact[];
  evidence?: unknown[];
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function loadFixture(rel: string): Promise<{ raw: V1; file: string; dir: string }> {
  const file = join(FIXTURES, rel);
  return { raw: JSON.parse(await readFile(file, "utf8")) as V1, file, dir: dirname(file) };
}

/** Reads sidecar bytes (`<fixture dir>/<path>`) — the v1 output tree next to its manifest. */
function sidecarResolver(dir: string) {
  return async (rel: string): Promise<Uint8Array | undefined> => {
    try {
      return new Uint8Array(await readFile(join(dir, rel)));
    } catch {
      return undefined;
    }
  };
}

/** Fixtures whose content is fully available (inline or via a sidecar tree). */
const ROUNDTRIP = [
  "manifest-notes-inline.json",
  "out-budget.manifest.json",
  "out-edge/manifest.json",
];

describe("migrateV1 — fixture round-trips (S-305 acceptance)", () => {
  for (const rel of ROUNDTRIP) {
    it(`${rel}: PlanSchema-valid, compiles, every path + byte digest preserved`, async () => {
      const { raw, dir } = await loadFixture(rel);
      const { plan, report } = await migrateV1(raw, {
        version: "test",
        resolveContent: sidecarResolver(dir),
      });
      expect(report.ok, JSON.stringify(report.warnings)).toBe(true);
      const parsed = PlanSchema.safeParse(plan);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

      const { bundle } = await compilePlan(plan);
      const byPath = new Map(bundle.manifest.artifacts.map((a) => [a.path, a]));
      const files = raw.artifacts.filter((a) => a.kind !== "dir");
      expect(bundle.manifest.artifacts).toHaveLength(files.length);
      for (const a of files) {
        const p = normaliseV1Path(a.path);
        const out = byPath.get(p);
        expect(out, p).toBeDefined();
        expect(out?.digest?.sha256, p).toBe(a.sha256);
        expect(out?.bytes, p).toBe(a.bytes);
      }
      // Directories are dropped with a reason, never silently.
      for (const d of raw.artifacts.filter((a) => a.kind === "dir")) {
        expect(report.dropped.some((x) => x.field.includes(normaliseV1Path(d.path)))).toBe(true);
      }
    });

    it(`${rel}: metadata.migration present, no clock keys anywhere, idempotent`, async () => {
      const { raw, dir } = await loadFixture(rel);
      const opts = { version: "test", resolveContent: sidecarResolver(dir) };
      const a = await migrateV1(raw, opts);
      const b = await migrateV1(raw, opts);
      expect(a.plan).toStrictEqual(b.plan);
      expect(a.report).toStrictEqual(b.report);
      const m = (a.plan.metadata as { migration: Record<string, unknown> }).migration;
      expect(m).toMatchObject({ from: "v1", tool: "axiom migrate", version: "test" });
      expect(Array.isArray(m.dropped)).toBe(true);
      expect(Array.isArray(m.warnings)).toBe(true);
      // Every v1 top-level field with no v2 home is in `dropped` — createdAt above all.
      const droppedFields = (m.dropped as { field: string }[]).map((d) => d.field);
      expect(droppedFields).toContain("createdAt");
      expect(droppedFields).toContain("buildId");
      expect(droppedFields).toContain("irHash");
      expect(findClockKeys(a.plan)).toEqual([]);
      // And the round-trip via JSON (what the CLI writes) is the same object.
      expect(JSON.parse(JSON.stringify(a.plan))).toStrictEqual(a.plan);
    });
  }

  it("migrating the migrated output is rejected (v2 Plan is not a v1 manifest)", async () => {
    const { raw } = await loadFixture("out-budget.manifest.json");
    const { plan } = await migrateV1(raw, { version: "test" });
    await expect(migrateV1(plan, { version: "test" })).rejects.toMatchObject({
      code: "ERR_INVALID_MANIFEST",
    });
  });
});

describe("migrateV1 — field mapping", () => {
  it("policy evidence no_personal_data → content.noSecrets; sla/unit evidence dropped with reason", async () => {
    const { raw } = await loadFixture("manifest-notes-inline.json");
    const { plan, report } = await migrateV1(raw, { version: "test" });
    const checks = plan.checks ?? [];
    expect(checks.map((c) => c.predicate)).toEqual(["content.noSecrets"]);
    expect(checks[0]?.id).toBe("no-pii");
    const dropped = report.dropped.map((d) => d.field);
    expect(dropped.some((f) => f.startsWith("evidence[1] (p50)"))).toBe(true);
    expect(dropped.some((f) => f.startsWith("evidence[2] (api-health)"))).toBe(true);
    const p50 = report.dropped.find((d) => d.field.startsWith("evidence[1]"));
    expect(p50?.reason).toMatch(/runtime measurement/);
  });

  it("budget profile → deps.max + manifest.maxTotalBytes; no_analytics/no_telemetry dropped", async () => {
    const { raw } = await loadFixture("out-budget.manifest.json");
    const { plan, report } = await migrateV1(raw, { version: "test" });
    const byPred = new Map((plan.checks ?? []).map((c) => [c.predicate, c.params]));
    expect(byPred.get("deps.max")).toEqual({ max: 5 });
    expect(byPred.get("manifest.maxTotalBytes")).toEqual({ max: 500 * 1024 });
    const dropped = report.dropped.map((d) => d.field);
    expect(dropped).toContain("profile.budget.no_analytics");
    expect(dropped).toContain("profile.budget.no_telemetry");
    // Windows-style paths in the fixture set? none here — but backslashes must be gone everywhere.
    for (const a of plan.artifacts) expect(a.path).not.toContain("\\");
  });

  it("edge profile → content.maxBytes 50 MiB; timeout/memory/cold_start dropped", async () => {
    const { raw, dir } = await loadFixture("out-edge/manifest.json");
    const { plan, report } = await migrateV1(raw, {
      version: "test",
      resolveContent: sidecarResolver(dir),
    });
    const maxBytes = (plan.checks ?? []).find((c) => c.predicate === "content.maxBytes");
    expect(maxBytes?.params).toEqual({ max: 50 * 1024 * 1024 });
    const dropped = report.dropped.map((d) => d.field);
    for (const k of ["timeout_ms", "memory_mb", "cold_start_ms", "no_fs_heavy"])
      expect(dropped).toContain(`profile.edge.${k}`);
  });

  it("v1 backslash paths become POSIX; `./` prefix stripped", () => {
    expect(normaliseV1Path("out\\web\\notes\\README.md")).toBe("out/web/notes/README.md");
    expect(normaliseV1Path("./a/b.txt")).toBe("a/b.txt");
  });

  it("contentBase64 → inline base64 with identical bytes", async () => {
    const { raw } = await loadFixture("out-budget.manifest.json");
    const { plan } = await migrateV1(raw, { version: "test" });
    const logo = plan.artifacts.find((a) => a.path === "out/smoke/logo.bin");
    expect(logo?.source).toMatchObject({ type: "inline", encoding: "base64" });
    const v1 = raw.artifacts.find((a) => a.path === "out/smoke/logo.bin") as V1Artifact;
    const src = logo?.source as { content: string };
    expect(sha(Buffer.from(src.content, "base64"))).toBe(v1.sha256);
  });

  it("--overwrite sets op on every artifact; name/profile options are honoured", async () => {
    const { raw } = await loadFixture("out-budget.manifest.json");
    const { plan } = await migrateV1(raw, {
      version: "test",
      overwrite: true,
      name: "My Legacy App!",
      profile: "strict",
    });
    expect(plan.artifacts.every((a) => a.op === "overwrite")).toBe(true);
    expect(plan.name).toBe("my-legacy-app");
    expect(plan.profile).toBe("strict");
  });
});

describe("migrateV1 — content resolution", () => {
  it("hash-only artifacts with no resolvable bytes → cas source + warning, report.ok=false, compile ERR_BLOB_MISSING", async () => {
    const { raw } = await loadFixture("manifest.json"); // the real archived edge manifest
    const { plan, report } = await migrateV1(raw, { version: "test" });
    expect(report.ok).toBe(false);
    expect(report.artifacts.unresolved).toBe(1);
    expect(plan.artifacts[0]?.source).toEqual({
      type: "cas",
      digest: `sha256:${raw.artifacts[0]?.sha256}`,
    });
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(findClockKeys(plan)).toEqual([]);
    const repo = await tmpRepo("axiom-migrate-");
    try {
      await expect(compilePlan(plan, { root: repo.root })).rejects.toMatchObject({
        code: "ERR_BLOB_MISSING",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("with casRoot, resolved bytes land in <root>/.axiom/cas and compile from there", async () => {
    const { raw, dir } = await loadFixture("out-edge/manifest.json");
    const repo = await tmpRepo("axiom-migrate-cas-");
    try {
      const { plan, report } = await migrateV1(raw, {
        version: "test",
        casRoot: repo.root,
        resolveContent: sidecarResolver(dir),
      });
      expect(report.artifacts).toMatchObject({ cas: 3, inline: 0, unresolved: 0 });
      expect(plan.artifacts.every((a) => a.source?.type === "cas")).toBe(true);
      const shards = await readdir(join(repo.root, ".axiom", "cas", "sha256"));
      expect(shards.length).toBeGreaterThan(0);
      const { bundle } = await compilePlan(plan, { root: repo.root, store: "cas" });
      for (const a of raw.artifacts) {
        const out = bundle.manifest.artifacts.find((x) => x.path === normaliseV1Path(a.path));
        expect(out?.digest?.sha256).toBe(a.sha256);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("resolved sidecar bytes that contradict the declared sha256 → ERR_DIGEST_MISMATCH", async () => {
    const { raw } = await loadFixture("out-edge/manifest.json");
    await expect(
      migrateV1(raw, {
        version: "test",
        resolveContent: async () => new TextEncoder().encode("tampered\n"),
      }),
    ).rejects.toMatchObject({ code: "ERR_DIGEST_MISMATCH" });
  });

  it("inline content that contradicts its declared sha256 is a warning (content wins), not an error", async () => {
    const { raw } = await loadFixture("manifest-notes-inline.json");
    const tampered: V1 = structuredClone(raw);
    (tampered.artifacts[0] as V1Artifact).sha256 = "0".repeat(64);
    const { report } = await migrateV1(tampered, { version: "test" });
    expect(report.ok).toBe(false);
    expect(report.warnings[0]).toMatch(/declared sha256/);
  });
});

describe("migrateV1 — invalid input", () => {
  const bad: [string, unknown][] = [
    ["not an object", 42],
    ["v2 plan", { apiVersion: "axiom.dev/v2", kind: "Plan" }],
    ["version 2.x", { version: "2.0.0", artifacts: [{ path: "a" }] }],
    ["empty artifacts", { version: "1.0.0", artifacts: [] }],
    ["artifact without path", { version: "1.0.0", artifacts: [{ sha256: "a".repeat(64) }] }],
    ["bad sha256", { version: "1.0.0", artifacts: [{ path: "a", sha256: "zz" }] }],
  ];
  for (const [label, input] of bad) {
    it(`${label} → ERR_INVALID_MANIFEST`, async () => {
      expect(V1ManifestSchema.safeParse(input).success).toBe(false);
      await expect(migrateV1(input, { version: "test" })).rejects.toSatisfy(
        (e: unknown) => e instanceof AxiomError && e.code === "ERR_INVALID_MANIFEST",
      );
    });
  }

  it("artifact with neither content nor sha256 → ERR_BLOB_MISSING", async () => {
    await expect(
      migrateV1({ version: "1.0.0", artifacts: [{ path: "a.txt" }] }, { version: "test" }),
    ).rejects.toMatchObject({ code: "ERR_BLOB_MISSING" });
  });

  it("path that is not a v2 RelPath (absolute / `..`) → ERR_PATH_NOT_RELATIVE_POSIX", async () => {
    for (const p of ["/etc/passwd", "../x", "C:\\x"]) {
      await expect(
        migrateV1(
          { version: "1.0.0", artifacts: [{ path: p, contentUtf8: "x" }] },
          { version: "test" },
        ),
      ).rejects.toMatchObject({ code: "ERR_PATH_NOT_RELATIVE_POSIX" });
    }
  });

  it("two v1 paths that collide after normalisation → ERR_INVALID_PLAN", async () => {
    await expect(
      migrateV1(
        {
          version: "1.0.0",
          artifacts: [
            { path: "a\\b.txt", contentUtf8: "1" },
            { path: "a/b.txt", contentUtf8: "2" },
          ],
        },
        { version: "test" },
      ),
    ).rejects.toMatchObject({ code: "ERR_INVALID_PLAN" });
  });

  it("only dir artifacts → ERR_INVALID_PLAN (nothing to write)", async () => {
    await expect(
      migrateV1(
        { version: "1.0.0", artifacts: [{ path: "a", kind: "dir", sha256: "0".repeat(64) }] },
        { version: "test" },
      ),
    ).rejects.toMatchObject({ code: "ERR_INVALID_PLAN" });
  });
});

describe("findClockKeys", () => {
  it("flags *At, timestamp and date keys at any depth, ignores values", () => {
    expect(
      findClockKeys({ a: { createdAt: 1, list: [{ timestamp: 2 }, { Date: 3 }] }, updatedat: 4 }),
    ).toEqual(["a.createdAt", "a.list[0].timestamp", "a.list[1].Date", "updatedat"]);
    expect(findClockKeys({ data: "2025-10-19T21:19:09Z", atlas: 1 })).toEqual([]);
  });
});

describe.skipIf(!existsSync(CLI))("axiom migrate v1 (dist/cli.js)", () => {
  async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("clean fixture → exit 0, writes -o plan.json that `compile` accepts with matching digests", async () => {
    const repo = await tmpRepo("axiom-migrate-cli-");
    try {
      const planFile = join(repo.root, "plan.json");
      const r = await run([
        "migrate",
        "v1",
        join(FIXTURES, "manifest-notes-inline.json"),
        "-o",
        planFile,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const summary = JSON.parse(r.stdout) as {
        ok: boolean;
        artifacts: { inline: number };
        out: string;
      };
      expect(summary.ok).toBe(true);
      expect(summary.artifacts.inline).toBe(5);
      const plan = JSON.parse(await readFile(planFile, "utf8")) as Plan;
      expect(PlanSchema.safeParse(plan).success).toBe(true);
      expect((plan.metadata as { migration: { version: string } }).migration.version).toMatch(
        /^\d+\.\d+\.\d+/,
      );
      expect(findClockKeys(plan)).toEqual([]);
      const c = await run(["compile", planFile]);
      expect(c.code, c.stderr).toBe(0);
      const bundle = JSON.parse(c.stdout) as {
        manifest: { artifacts: { path: string; digest: { sha256: string } }[] };
      };
      const { raw } = await loadFixture("manifest-notes-inline.json");
      for (const a of raw.artifacts) {
        const out = bundle.manifest.artifacts.find((x) => x.path === normaliseV1Path(a.path));
        expect(out?.digest.sha256, a.path).toBe(a.sha256);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("sidecar tree is read from the manifest's directory by default; --cas writes blobs under <root>/.axiom/cas", async () => {
    const repo = await tmpRepo("axiom-migrate-cli-cas-");
    try {
      const planFile = join(repo.root, "plan.json");
      const r = await run([
        "migrate",
        "v1",
        join(FIXTURES, "out-edge", "manifest.json"),
        "-o",
        planFile,
        "--cas",
        repo.root,
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(existsSync(join(repo.root, ".axiom", "cas", "sha256"))).toBe(true);
      const c = await run(["compile", planFile, "--store", "cas", "--root", repo.root]);
      expect(c.code, c.stderr).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("hash-only manifest without content → exit 1, still writes the plan (warnings in the report)", async () => {
    const repo = await tmpRepo("axiom-migrate-cli-warn-");
    try {
      const planFile = join(repo.root, "plan.json");
      const r = await run(["migrate", "v1", join(FIXTURES, "manifest.json"), "-o", planFile]);
      expect(r.code).toBe(1);
      const summary = JSON.parse(r.stdout) as { ok: boolean; warnings: string[] };
      expect(summary.ok).toBe(false);
      expect(summary.warnings[0]).toMatch(/content unavailable/);
      expect(existsSync(planFile)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("invalid v1 input → exit 2 with ERR_INVALID_MANIFEST on stderr; bad source format → exit 2", async () => {
    const repo = await tmpRepo("axiom-migrate-cli-bad-");
    try {
      const bad = join(repo.root, "bad.json");
      await writeFile(bad, JSON.stringify({ apiVersion: "axiom.dev/v2", kind: "Plan" }));
      const r = await run(["migrate", "v1", bad]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("ERR_INVALID_MANIFEST");
      expect((await run(["migrate", "v0", bad])).code).toBe(2);
      expect((await run(["migrate", "v1"])).code).toBe(2);
    } finally {
      await repo.cleanup();
    }
  });

  it("migrate code is a lazy chunk: dist/migrate-lazy.js exists and cli-main.js does not import it statically", async () => {
    const dist = join(here, "..", "dist");
    expect(existsSync(join(dist, "migrate-lazy.js"))).toBe(true);
    const mainText = await readFile(join(dist, "cli-main.js"), "utf8");
    expect(mainText).not.toMatch(/^import\b[^\n]*?from\s+["']\.\/migrate-lazy/m);
    expect(mainText).toMatch(/import\(["']\.\/migrate-lazy\.js["']\)/);
  });
});
