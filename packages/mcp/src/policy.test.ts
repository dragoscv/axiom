/**
 * `resolvePolicy` (4.0, S-1407): the ONE resolver every consumer reads the repository policy
 * through. Each test names the finding it locks down (A2-1, A2-11, A2-12, A2-14, CN-15, CN-16,
 * DX-8, EN-7, EN-8, EN-9, A2-27), so a regression is attributable.
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@codai/axiom-canon";
import { AXIOM_CONFIG_PATH } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GATE_PROFILE } from "./gate-profile.js";
import { resolvePolicy } from "./policy.js";
import { type TmpRepo, tmpRepo } from "./test-helpers.js";

let repo: TmpRepo;
let home: TmpRepo;
let savedOrg: string | undefined;
let savedProgramData: string | undefined;

const AXIOM_JSON = AXIOM_CONFIG_PATH;

async function put(dir: string, rel: string, doc: unknown): Promise<string> {
  const file = join(dir, ...rel.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

/** Temp root with a plain `.git` so root discovery and the ancestor walk stop somewhere sane. */
async function repoRoot(prefix: string): Promise<TmpRepo> {
  const r = await tmpRepo(prefix);
  await mkdir(join(r.root, ".git"), { recursive: true });
  await writeFile(join(r.root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return r;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

const policy = (root: string) => resolvePolicy(root, { home: home.root });

beforeEach(async () => {
  repo = await repoRoot("axiom-policy-");
  home = await tmpRepo("axiom-policy-home-");
  savedOrg = process.env.AXIOM_ORG_POLICY;
  savedProgramData = process.env.ProgramData;
  delete process.env.AXIOM_ORG_POLICY;
  // Keep the ORG layer hermetic: nothing may exist at the platform path in a test.
  process.env.ProgramData = join(home.root, "programdata");
});

afterEach(async () => {
  if (savedOrg === undefined) delete process.env.AXIOM_ORG_POLICY;
  else process.env.AXIOM_ORG_POLICY = savedOrg;
  if (savedProgramData === undefined) delete process.env.ProgramData;
  else process.env.ProgramData = savedProgramData;
  await repo.cleanup();
  await home.cleanup();
});

describe("resolvePolicy — an axiom.json without a gate never switches the gate off (A2-1)", () => {
  it("falls through to a strict gate-profile.json (the P0: .env and force push were ALLOWed)", async () => {
    await put(repo.root, ".axiom/gate-profile.json", {
      version: 3,
      deny: ["secret/**"],
      mode: "enforce",
      hard: ["house.forcePush"],
    });
    await put(repo.root, AXIOM_JSON, { version: 3 });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("secret/**");
    expect(p.gate.deny.length).toBeGreaterThan(0);
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.hard).toContain("house.forcePush");
    expect(p.source.endsWith("gate-profile.json")).toBe(true);
  });

  it("gate: {} falls through the same way, and a schema-default gate is never empty", async () => {
    await put(repo.root, ".axiom/gate-profile.json", { deny: ["secret/**"] });
    await put(repo.root, AXIOM_JSON, { version: 3, gate: {} });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("secret/**");

    const bare = await repoRoot("axiom-policy-bare-");
    try {
      const q = await resolvePolicy(bare.root, { home: home.root });
      expect(q.source).toBe("builtin");
      expect(q.gate.deny).toEqual(DEFAULT_GATE_PROFILE.deny);
      expect(q.gate.deny.length).toBeGreaterThan(0);
      // A2-11: the built-in default covers a NESTED repository's own .git / .axiom too.
      expect(q.gate.deny).toContain("**/.git/**");
      expect(q.gate.deny).toContain("**/.axiom/**");
    } finally {
      await bare.cleanup();
    }
  });

  it("with no v3 file at all the legacy repo file still decides", async () => {
    await put(repo.root, ".axiom/gate-profile.json", { deny: ["legacy/**"] });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("legacy/**");
    expect(p.sources.at(-1)?.endsWith("gate-profile.json")).toBe(true);
  });
});

describe("resolvePolicy — layers merge strictest-wins", () => {
  it("repo < user: deny/ask/hard union, mode enforce, override false, maxBytes min, allow intersect", async () => {
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      gate: {
        deny: ["repo/**"],
        ask: ["ask1/**"],
        mode: "warn",
        override: true,
        maxBytes: 4096,
        allow: ["src/**", "docs/**"],
        pii: false,
        outside: "allow",
      },
    });
    await put(home.root, AXIOM_JSON, {
      version: 3,
      gate: {
        deny: ["user/**"],
        hard: ["house.forcePush"],
        mode: "enforce",
        override: false,
        maxBytes: 64,
        allow: ["src/**", "tools/**"],
        pii: true,
        outside: "warn",
      },
    });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("repo/**");
    expect(p.gate.deny).toContain("user/**");
    expect(p.gate.ask).toContain("ask1/**");
    expect(p.gate.hard).toContain("house.forcePush");
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.override).toBe(false);
    expect(p.gate.maxBytes).toBe(64);
    expect(p.gate.allow).toEqual(["src/**"]);
    expect(p.gate.pii).toBe(true);
    expect(p.gate.outside).toBe("warn");
    expect(p.source).toBe(await realpath(join(home.root, ...AXIOM_JSON.split("/"))));
  });

  it("checks are carried through, merged from every layer that names one", async () => {
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      gate: { deny: ["r/**"] },
      checks: { name: "web", extends: "default", checks: [] },
    });
    const p = await policy(repo.root);
    expect(p.checks).toEqual({ name: "web", extends: "default", checks: [] });
    const bare = await repoRoot("axiom-policy-nochecks-");
    try {
      expect((await resolvePolicy(bare.root, { home: home.root })).checks).toBeUndefined();
    } finally {
      await bare.cleanup();
    }
  });

  it("the org layer (AXIOM_ORG_POLICY) outranks the repo and the user", async () => {
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { deny: ["repo/**"], mode: "warn" } });
    const org = await put(home.root, "org/policy.json", {
      version: 3,
      gate: { deny: ["org/**"], mode: "enforce", hard: ["house.resetHard"] },
    });
    process.env.AXIOM_ORG_POLICY = org;
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("org/**");
    expect(p.gate.deny).toContain("repo/**");
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.hard).toContain("house.resetHard");
    expect(p.source).toBe(await realpath(org));
  });

  it("optional fields stay absent; the built-in default is the floor, not a ceiling", async () => {
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { allow: ["src/**"] } });
    const p = await policy(repo.root);
    expect(p.gate.allow).toEqual(["src/**"]);
    expect(p.gate.deny).toEqual(DEFAULT_GATE_PROFILE.deny);
    expect(p.gate.maxBytes).toBeUndefined();
    expect(p.source.endsWith("axiom.json")).toBe(true);
  });
});

describe("resolvePolicy — locked keys (D-54)", () => {
  it("a stronger layer's `locked` drops the key from every weaker layer", async () => {
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      gate: { outside: "allow", mode: "warn", deny: ["repo/**"] },
    });
    await put(home.root, AXIOM_JSON, {
      version: 3,
      gate: { mode: "enforce", locked: ["outside"] },
    });
    const p = await policy(repo.root);
    expect(p.gate.outside).toBe("deny");
    expect(p.gate.mode).toBe("enforce");
    // The key that is NOT locked keeps the stricter of the two layers.
    expect(p.gate.deny).toContain("repo/**");
    expect(p.warnings.some((w) => w.includes("locked") && w.includes("outside"))).toBe(true);
  });
});

describe("resolvePolicy — floors: nested root and worktree, by content not mtime (A2-11, A2-12, EN-9)", () => {
  it("a nested root inherits its nearest ancestor repository's policy as a floor", async () => {
    const outer = await repoRoot("axiom-policy-outer-");
    try {
      await put(outer.root, AXIOM_JSON, {
        version: 3,
        gate: { deny: ["outer/**"], mode: "enforce", hard: ["house.forcePush"] },
      });
      const nested = join(outer.root, "scratch");
      await put(nested, ".axiom/axiom.json", { version: 3, gate: { mode: "warn" } });
      const p = await resolvePolicy(nested, { home: home.root });
      expect(p.gate.deny).toContain("outer/**");
      expect(p.gate.mode).toBe("enforce");
      expect(p.gate.hard).toContain("house.forcePush");
      // The nested directory's own file is still a layer, and it is the weakest one above the floor.
      expect(p.sources.some((s) => s.includes("scratch"))).toBe(true);
    } finally {
      await outer.cleanup();
    }
  });

  it("a linked worktree inherits the main clone's axiom.json even when its own legacy file is newer", async () => {
    const main = await repoRoot("axiom-policy-main-");
    const wt = await tmpRepo("axiom-policy-wt-");
    try {
      await put(main.root, AXIOM_JSON, {
        version: 3,
        gate: { deny: ["secrets/**"], mode: "enforce", hard: ["house.forcePush"] },
      });
      // A hand-made but VALID worktree link: `.git` file -> bare worktree dir with the back-link.
      const gitdir = join(main.root, ".git", "worktrees", "wt");
      await mkdir(gitdir, { recursive: true });
      await writeFile(join(gitdir, "gitdir"), `${join(wt.root, ".git")}\n`);
      await writeFile(join(gitdir, "commondir"), "../..\n");
      await writeFile(join(wt.root, ".git"), `gitdir: ${gitdir}\n`);
      // The slot's own legacy file is weak AND freshly written (mtime-based precedence would lose).
      await put(wt.root, ".axiom/gate-profile.json", { mode: "warn", record: true });
      const p = await resolvePolicy(wt.root, { home: home.root });
      expect(p.gate.deny).toContain("secrets/**");
      expect(p.gate.deny.length).toBeGreaterThan(0);
      expect(p.gate.mode).toBe("enforce");
      expect(p.gate.hard).toContain("house.forcePush");
      expect(p.gate.record).toBe(true);
    } finally {
      await main.cleanup();
      await wt.cleanup();
    }
  });
});

describe("resolvePolicy — a BOM is ignored", () => {
  it("a BOM at the start of axiom.json / gate-profile.json does not break the parse", async () => {
    await put(
      repo.root,
      AXIOM_JSON,
      `\uFEFF${JSON.stringify({ version: 3, gate: { deny: ["bom/**"] } })}`,
    );
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("bom/**");
    expect(p.sources.at(-1)?.endsWith("axiom.json")).toBe(true);

    const legacy = await repoRoot("axiom-policy-bom-legacy-");
    try {
      await put(
        legacy.root,
        ".axiom/gate-profile.json",
        `\uFEFF${JSON.stringify({ deny: ["bomlegacy/**"] })}`,
      );
      const q = await resolvePolicy(legacy.root, { home: home.root });
      expect(q.gate.deny).toContain("bomlegacy/**");
    } finally {
      await legacy.cleanup();
    }
  });
});

describe("resolvePolicy — unknown keys and unknown enum values (A2-14)", () => {
  it("strips unknown keys at ANY depth with a warning instead of denying every write", async () => {
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      telemetry: { on: true },
      gate: {
        deny: ["x/**"],
        futureKnob: true,
        commands: { pack: "core", futureKnob: true },
        sessions: { foreignWrite: "deny", futureKnob: 1 },
      },
    });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("x/**");
    expect(p.gate.commands?.pack).toBe("core");
    expect(p.gate.sessions?.foreignWrite).toBe("deny");
    expect(p.warnings.some((w) => w.includes("gate.commands.futureKnob"))).toBe(true);
    expect(p.warnings.some((w) => w.includes('"telemetry"'))).toBe(true);
  });

  it("an unknown enum value warns and takes the stricter reading", async () => {
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      gate: { mode: "banana", outside: "sometimes", steer: "often", sessions: { foreignWrite: 7 } },
    });
    const p = await policy(repo.root);
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.outside).toBe("deny");
    expect(p.gate.steer).toBe("require");
    expect(p.gate.sessions?.foreignWrite).toBe("deny");
    expect(p.warnings.some((w) => w.includes("gate.mode") && w.includes("stricter"))).toBe(true);
  });
});

describe("resolvePolicy — version gates (CN-15, EN-23)", () => {
  it("a policy version newer than this binary is ERR_PROFILE_VERSION", async () => {
    await put(repo.root, AXIOM_JSON, { version: 99, gate: {} });
    expect(await codeOf(policy(repo.root))).toBe("ERR_PROFILE_VERSION");
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { deny: ["ok/**"] } });
    await put(repo.root, AXIOM_JSON, { version: 99, gate: { deny: ["ok/**"] } });
    expect(await codeOf(policy(repo.root))).toBe("ERR_PROFILE_VERSION");
  });

  it("minAxiomVersion above this binary is ERR_PROFILE_VERSION", async () => {
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { minAxiomVersion: "99.0.0" } });
    expect(await codeOf(policy(repo.root))).toBe("ERR_PROFILE_VERSION");
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { minAxiomVersion: "1.0.0" } });
    expect((await policy(repo.root)).gate.minAxiomVersion).toBe("1.0.0");
  });

  it("a profile that is not JSON / not an object is ERR_INVALID_PROFILE, never a default", async () => {
    await put(repo.root, ".axiom/gate-profile.json", "{ nope");
    expect(await codeOf(policy(repo.root))).toBe("ERR_INVALID_PROFILE");
    await put(repo.root, ".axiom/gate-profile.json", "[]");
    expect(await codeOf(policy(repo.root))).toBe("ERR_INVALID_PROFILE");
  });
});

describe("resolvePolicy — the user layer keeps working in 4.x (CN-16, DX-8)", () => {
  it("~/.axiom/gate-profile.json is still read, with exactly ONE deprecation warning", async () => {
    await put(home.root, ".axiom/gate-profile.json", { deny: ["homesecret/**"], pii: true });
    await put(repo.root, AXIOM_JSON, { version: 3 });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("homesecret/**");
    expect(p.gate.pii).toBe(true);
    expect(p.warnings.filter((w) => w.includes("deprecated"))).toHaveLength(1);
  });

  it("both legacy files in play still produce ONE deprecation warning", async () => {
    await put(repo.root, ".axiom/gate-profile.json", { deny: ["repolegacy/**"] });
    await put(home.root, ".axiom/gate-profile.json", { deny: ["homelegacy/**"] });
    await put(repo.root, AXIOM_JSON, { version: 3 });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("repolegacy/**");
    expect(p.gate.deny).toContain("homelegacy/**");
    const dep = p.warnings.filter((w) => w.includes("deprecated"));
    expect(dep).toHaveLength(1);
    expect(dep[0]).toContain("gate-profile.json");
  });

  it("a 4.0 ~/.axiom/axiom.json outranks the legacy user file", async () => {
    await put(home.root, ".axiom/gate-profile.json", { mode: "warn" });
    await put(home.root, AXIOM_JSON, { version: 3, gate: { mode: "enforce", hard: ["x.y"] } });
    const p = await policy(repo.root);
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.hard).toContain("x.y");
  });
});

describe("resolvePolicy — --profile is an extra layer that may only tighten (EN-7)", () => {
  it("accepts the flat 2.x shape and never replaces the repo layer", async () => {
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { deny: ["repo/**"] } });
    const prof = await put(repo.root, "custom.json", {
      deny: ["extra/**"],
      mode: "warn",
      override: true,
    });
    const p = await resolvePolicy(repo.root, { home: home.root, profilePath: prof });
    expect(p.gate.deny).toContain("repo/**");
    expect(p.gate.deny).toContain("extra/**");
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.override).toBe(false);
    expect(p.source).toBe(await realpath(prof));
  });

  it("accepts the axiom.json shape (extends resolved) and errors when the file is missing", async () => {
    await put(repo.root, AXIOM_JSON, { version: 3, gate: { deny: ["repo/**"] } });
    const prof = await put(repo.root, "team.json", {
      version: 3,
      extends: ["axiom:strict"],
      gate: { deny: ["fromteam/**"] },
    });
    const p = await resolvePolicy(repo.root, { home: home.root, profilePath: prof });
    expect(p.gate.deny).toContain("repo/**");
    expect(p.gate.deny).toContain("fromteam/**");
    expect(p.gate.deny).toContain(".github/workflows/**");
    expect(p.gate.outside).toBe("deny");
    expect(
      await codeOf(
        resolvePolicy(repo.root, { home: home.root, profilePath: join(repo.root, "nope.json") }),
      ),
    ).toBe("ERR_INVALID_PROFILE");
  });
});

describe("resolvePolicy — policy packs are integrity-pinned (EN-8, A2-27)", () => {
  async function pack(name: string, doc: unknown): Promise<string> {
    const dir = join(repo.root, "node_modules", "@codai", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: `@codai/${name}`, version: "1.0.0" }),
    );
    return put(repo.root, `node_modules/@codai/${name}/axiom-pack.json`, doc);
  }

  it("only the pinned bytes are accepted; a tampered pack is ERR_INVALID_PROFILE", async () => {
    const file = await pack("axiom-pack-team", { gate: { deny: ["frompack/**"] } });
    const pin = sha256Hex(new Uint8Array(await readFile(file)));
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      extends: [`@codai/axiom-pack-team@sha256:${pin}`],
      gate: { deny: ["own/**"] },
    });
    const p = await policy(repo.root);
    expect(p.gate.deny).toContain("frompack/**");
    expect(p.gate.deny).toContain("own/**");
    expect(p.sources).toContain("npm:@codai/axiom-pack-team");

    // Tamper with the pack: the pin no longer matches, so its denies must NOT quietly vanish.
    await writeFile(file, JSON.stringify({ gate: { deny: [] } }));
    expect(await codeOf(policy(repo.root))).toBe("ERR_INVALID_PROFILE");
  });

  it("an unresolvable pack is a hard error, not a silent drop of its denies", async () => {
    await put(repo.root, AXIOM_JSON, {
      version: 3,
      extends: ["@codai/axiom-pack-missing"],
      gate: { deny: ["own/**"] },
    });
    expect(await codeOf(policy(repo.root))).toBe("ERR_INVALID_PROFILE");
  });

  it("extends axiom:default is never weaker than the 4.0 preset init writes (A2-27)", async () => {
    await put(repo.root, AXIOM_JSON, { version: 3, extends: ["axiom:default"] });
    const p = await policy(repo.root);
    expect(p.gate.commands?.pack).toBe("core");
    expect(p.gate.mode).toBe("enforce");
    expect(p.gate.undo).toBe(true);
    expect(p.gate.record).toBe(true);
    expect(p.gate.deny).toEqual(DEFAULT_GATE_PROFILE.deny);
  });
});

describe("resolvePolicy — reporting", () => {
  it("policyDigest follows the effective policy, not the file layout", async () => {
    const a = await repoRoot("axiom-policy-digest-a-");
    const b = await repoRoot("axiom-policy-digest-b-");
    try {
      const gate = { deny: ["same/**"], mode: "enforce" };
      await put(a.root, AXIOM_JSON, { version: 3, gate });
      // Same effective policy reached through the LEGACY file: the digest must match.
      await put(b.root, ".axiom/gate-profile.json", gate);
      const pa = await resolvePolicy(a.root, { home: home.root });
      const pb = await resolvePolicy(b.root, { home: home.root });
      expect(pa.policyDigest).toBe(pb.policyDigest);
      expect(pa.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(pa.source).not.toBe(pb.source);

      await put(a.root, AXIOM_JSON, { version: 3, gate: { deny: ["other/**"] } });
      const changed = await resolvePolicy(a.root, { home: home.root });
      expect(changed.policyDigest).not.toBe(pa.policyDigest);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
