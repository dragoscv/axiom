import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProfile } from "@codai/axiom-checks";
import { AxiomError } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GATE_PROFILE, GateProfileSchema } from "./gate.js";
import {
  AXIOM_CONFIG_FILE,
  BUILTIN_GATE_DENY,
  loadAxiomConfig,
  loadLegacyAxiomConfig,
  MAX_EXTENDS_DEPTH,
  mergeConfig,
} from "./profile-v3.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

let repo: TmpRepo;
let home: TmpRepo;

async function put(rel: string, doc: unknown): Promise<void> {
  const file = join(repo.root, ...rel.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, typeof doc === "string" ? doc : JSON.stringify(doc));
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AxiomError ? err.code : `non-axiom: ${String(err)}`;
  }
}

beforeEach(async () => {
  repo = await tmpRepo("axiom-cfg-");
  home = await tmpRepo("axiom-cfg-home-");
});
afterEach(async () => {
  await repo.cleanup();
  await home.cleanup();
});

describe("loadAxiomConfig", () => {
  it("returns undefined when .axiom/axiom.json is absent", async () => {
    expect(AXIOM_CONFIG_FILE).toBe(".axiom/axiom.json");
    expect(await loadAxiomConfig(repo.root, { home: home.root })).toBeUndefined();
  });

  it("reads gate + checks of a plain file", async () => {
    await put(AXIOM_CONFIG_FILE, {
      $schema: "x",
      version: 3,
      gate: { deny: ["a/**"], mode: "warn" },
      checks: { extends: "strict", checks: [] },
    });
    const c = await loadAxiomConfig(repo.root, { home: home.root });
    expect(c?.gate).toEqual({ deny: ["a/**"], mode: "warn" });
    expect(c?.checks).toEqual({ extends: "strict", checks: [] });
    expect(c?.legacy).toBe(false);
    expect(c?.warnings).toEqual([]);
    expect(c?.sources).toHaveLength(1);
  });

  it("extends a relative file: deep merge, later wins, deny/ask/hard/allow unioned", async () => {
    await put(".axiom/base.json", {
      gate: {
        deny: ["base/**", "both/**"],
        ask: ["x/**"],
        hard: ["git.forcePush"],
        allow: ["src/**"],
        steerGlobs: ["base-only/**"],
        mode: "enforce",
        sessions: { blindOverwrite: "deny", windowMin: 30 },
      },
      checks: {
        checks: [
          { id: "deps.max", predicate: "deps.max", params: { max: 1 } },
          { id: "path.deny", predicate: "path.deny", params: { globs: ["a"] } },
        ],
      },
    });
    await put(AXIOM_CONFIG_FILE, {
      version: 3,
      extends: ["./base.json"],
      gate: {
        deny: ["both/**", "own/**"],
        hard: ["fs.*"],
        allow: ["docs/**"],
        steerGlobs: ["own-only/**"],
        mode: "warn",
        sessions: { blindOverwrite: "ask" },
      },
      checks: { checks: [{ id: "deps.max", predicate: "deps.max", params: { max: 9 } }] },
    });
    const c = await loadAxiomConfig(repo.root, { home: home.root });
    expect(c?.gate).toEqual({
      deny: ["base/**", "both/**", "own/**"],
      ask: ["x/**"],
      hard: ["git.forcePush", "fs.*"],
      allow: ["src/**", "docs/**"],
      steerGlobs: ["own-only/**"],
      mode: "warn",
      sessions: { blindOverwrite: "ask", windowMin: 30 },
    });
    const checks =
      (c?.checks as { checks: Array<{ id: string; params: unknown }> } | undefined)?.checks ?? [];
    expect(checks.map((x) => x.id)).toEqual(["deps.max", "path.deny"]);
    expect(checks[0]?.params).toEqual({ max: 9 });
    expect(c?.sources.map((s) => s.split(/[\\/]/).pop())).toEqual(["base.json", "axiom.json"]);
    expect(GateProfileSchema.safeParse(c?.gate).success).toBe(true);
  });

  it("extends a file under ~/.axiom; a file outside root and ~/.axiom → ERR_INVALID_PROFILE", async () => {
    await mkdir(join(home.root, ".axiom"), { recursive: true });
    await writeFile(
      join(home.root, ".axiom", "team.json"),
      JSON.stringify({ gate: { pii: true } }),
    );
    await put(AXIOM_CONFIG_FILE, {
      extends: [join(home.root, ".axiom", "team.json")],
      gate: {},
    });
    expect((await loadAxiomConfig(repo.root, { home: home.root }))?.gate).toEqual({ pii: true });

    await writeFile(join(home.root, "outside.json"), "{}");
    await put(AXIOM_CONFIG_FILE, { extends: [join(home.root, "outside.json")] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
    await put(AXIOM_CONFIG_FILE, { extends: ["../../nope.json"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
  });

  it("built-in packs: axiom:strict brings the strict check profile and the gate pack", async () => {
    await put(AXIOM_CONFIG_FILE, {
      version: 3,
      extends: ["axiom:strict"],
      gate: { deny: ["mine/**"] },
    });
    const c = await loadAxiomConfig(repo.root, { home: home.root });
    const gate = GateProfileSchema.parse(c?.gate);
    expect(gate.deny).toEqual([...BUILTIN_GATE_DENY, ".github/workflows/**", "mine/**"]);
    expect(gate.commands?.pack).toBe("house");
    expect(c?.sources[0]).toBe("axiom:strict");
    const p = await loadProfile("default", { config: c?.checks });
    expect(p.checks.map((x) => x.id)).toContain("manifest.noDeletes");
    await put(AXIOM_CONFIG_FILE, { extends: ["axiom:nope"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
  });

  it("the builtin gate deny list mirrors DEFAULT_GATE_PROFILE", () => {
    expect([...BUILTIN_GATE_DENY]).toEqual(DEFAULT_GATE_PROFILE.deny);
  });

  it("npm pack @codai/axiom-pack-x resolves from node_modules (exports or package.json#axiomPack)", async () => {
    const dir = join(repo.root, "node_modules", "@codai", "axiom-pack-x");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@codai/axiom-pack-x",
        version: "1.0.0",
        exports: { "./axiom-pack.json": "./pack/axiom-pack.json" },
      }),
    );
    await mkdir(join(dir, "pack"));
    await writeFile(
      join(dir, "pack", "axiom-pack.json"),
      JSON.stringify({ gate: { deny: ["from-pack/**"], record: true } }),
    );
    const dir2 = join(repo.root, "node_modules", "@codai", "axiom-pack-y");
    await mkdir(dir2, { recursive: true });
    await writeFile(
      join(dir2, "package.json"),
      JSON.stringify({ name: "@codai/axiom-pack-y", axiomPack: "policy.json" }),
    );
    await writeFile(join(dir2, "policy.json"), JSON.stringify({ gate: { deny: ["from-y/**"] } }));
    await put(AXIOM_CONFIG_FILE, {
      extends: ["@codai/axiom-pack-x", "@codai/axiom-pack-y"],
      gate: { deny: ["own/**"], record: false },
    });
    const c = await loadAxiomConfig(repo.root, { home: home.root });
    expect(c?.gate).toEqual({ deny: ["from-pack/**", "from-y/**", "own/**"], record: false });
    expect(c?.sources).toContain("npm:@codai/axiom-pack-x");
  });

  it("npm packs outside @codai need allowNpmPacks; a missing pack is never installed", async () => {
    const dir = join(repo.root, "node_modules", "evil-pack");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "evil-pack", axiomPack: "p.json" }),
    );
    await writeFile(join(dir, "p.json"), JSON.stringify({ gate: { outside: "allow" } }));
    await put(AXIOM_CONFIG_FILE, { extends: ["evil-pack"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
    expect(
      (await loadAxiomConfig(repo.root, { home: home.root, allowNpmPacks: true }))?.gate,
    ).toEqual({ outside: "allow" });
    await put(AXIOM_CONFIG_FILE, { allowNpmPacks: true, extends: ["evil-pack"] });
    expect((await loadAxiomConfig(repo.root, { home: home.root }))?.gate).toEqual({
      outside: "allow",
    });
    await put(AXIOM_CONFIG_FILE, { extends: ["@codai/axiom-pack-missing"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
  });

  it("an extends cycle (self or a↔b) → ERR_INVALID_PROFILE", async () => {
    await put(".axiom/a.json", { extends: ["./b.json"] });
    await put(".axiom/b.json", { extends: ["./a.json"] });
    await put(AXIOM_CONFIG_FILE, { extends: ["./a.json"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
    await put(AXIOM_CONFIG_FILE, { extends: ["./axiom.json"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
  });

  it(`depth ${MAX_EXTENDS_DEPTH} is fine, ${MAX_EXTENDS_DEPTH + 1} → ERR_INVALID_PROFILE`, async () => {
    const chain = async (n: number) => {
      for (let i = 1; i <= n; i++) {
        await put(
          `.axiom/l${i}.json`,
          i < n ? { extends: [`./l${i + 1}.json`] } : { gate: { pii: true } },
        );
      }
      await put(AXIOM_CONFIG_FILE, { extends: ["./l1.json"] });
    };
    await chain(MAX_EXTENDS_DEPTH);
    expect((await loadAxiomConfig(repo.root, { home: home.root }))?.gate).toEqual({ pii: true });
    await chain(MAX_EXTENDS_DEPTH + 1);
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
  });

  it("version 4 → ERR_PROFILE_VERSION, also inside an extended file", async () => {
    await put(AXIOM_CONFIG_FILE, { version: 4, gate: {} });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_PROFILE_VERSION",
    );
    await put(".axiom/new.json", { version: 4 });
    await put(AXIOM_CONFIG_FILE, { version: 3, extends: ["./new.json"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_PROFILE_VERSION",
    );
  });

  it("unknown keys warn and are ignored; bad JSON / mistyped keys → ERR_INVALID_PROFILE", async () => {
    await put(AXIOM_CONFIG_FILE, { version: 3, gate: { pii: true }, telemetry: { on: true } });
    const c = await loadAxiomConfig(repo.root, { home: home.root });
    expect(c?.gate).toEqual({ pii: true });
    expect(c?.warnings).toHaveLength(1);
    expect(c?.warnings[0]).toContain('"telemetry"');
    await put(AXIOM_CONFIG_FILE, "{ nope");
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
    await put(AXIOM_CONFIG_FILE, { extends: "axiom:strict" });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
    await put(AXIOM_CONFIG_FILE, { extends: ["not a ref!"] });
    expect(await codeOf(loadAxiomConfig(repo.root, { home: home.root }))).toBe(
      "ERR_INVALID_PROFILE",
    );
  });
});

describe("loadLegacyAxiomConfig", () => {
  it("reads gate-profile.json + profiles/<name>.json with a deprecation warning", async () => {
    await put(".axiom/gate-profile.json", { deny: ["x/**"] });
    await put(".axiom/profiles/web.json", {
      apiVersion: "axiom.dev/v2",
      kind: "Profile",
      name: "web",
      extends: "default",
      checks: [],
    });
    const c = await loadLegacyAxiomConfig(repo.root, "web");
    expect(c?.legacy).toBe(true);
    expect(c?.gate).toEqual({ deny: ["x/**"] });
    expect(c?.checks).toEqual({ name: "web", extends: "default", checks: [] });
    expect(c?.warnings[0]).toMatch(
      /^deprecated: .axiom\/gate-profile.json \+ .axiom\/profiles\/web.json/,
    );
    expect(await loadLegacyAxiomConfig(repo.root, "other")).toMatchObject({ checks: {} });
  });
  it("undefined when neither legacy file exists", async () => {
    expect(await loadLegacyAxiomConfig(repo.root, "web")).toBeUndefined();
  });
});

describe("mergeConfig", () => {
  it("unions only policy arrays, replaces scalars/other arrays, keeps inputs intact", () => {
    const a = { deny: ["a"], steerGlobs: ["a"], n: 1, o: { k: 1 } };
    const b = { deny: ["a", "b"], steerGlobs: ["b"], n: 2, o: { j: 2 } };
    expect(mergeConfig(a, b)).toEqual({
      deny: ["a", "b"],
      steerGlobs: ["b"],
      n: 2,
      o: { k: 1, j: 2 },
    });
    expect(a.deny).toEqual(["a"]);
  });
});
