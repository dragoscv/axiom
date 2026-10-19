import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION } from "@codai/axiom-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AXIOM_CONFIG_PROFILE_NAME, builtinProfiles, loadProfile } from "./profile.js";

describe("builtin profiles", () => {
  it("all three parse", () => {
    expect(Object.keys(builtinProfiles()).sort()).toEqual(["default", "permissive", "strict"]);
  });
  it("default has the documented checks", async () => {
    const p = await loadProfile("default");
    expect(p.checks.map((c) => c.id)).toEqual([
      "path.reservedNames",
      "content.noSecrets",
      "manifest.maxArtifacts",
      "manifest.maxTotalBytes",
      "repo.noOverwriteOf",
    ]);
    expect(p.extends).toBeUndefined();
  });
  it("strict extends default (parent checks first, then own)", async () => {
    const p = await loadProfile("strict");
    expect(p.name).toBe("strict");
    expect(p.checks.map((c) => c.id)).toEqual([
      "path.reservedNames",
      "content.noSecrets",
      "manifest.maxArtifacts",
      "manifest.maxTotalBytes",
      "repo.noOverwriteOf",
      "manifest.noDeletes",
      "deps.max",
      "path.deny",
    ]);
    expect(p.limits.maxArtifacts).toBe(2000);
  });
  it("permissive has only reservedNames", async () => {
    expect((await loadProfile("permissive")).checks.map((c) => c.id)).toEqual([
      "path.reservedNames",
    ]);
  });
  it("unknown → ERR_INVALID_PROFILE", async () => {
    await expect(loadProfile("nope")).rejects.toMatchObject({ code: "ERR_INVALID_PROFILE" });
    await expect(loadProfile("../evil")).rejects.toMatchObject({ code: "ERR_INVALID_PROFILE" });
  });
  it("D-41: resolved profiles carry the canonical v3 apiVersion", async () => {
    expect((await loadProfile("strict")).apiVersion).toBe(API_VERSION);
    expect(API_VERSION).toBe("axiom.codai.ro/v3");
  });
});

describe("axiom.json `checks` section (D-42)", () => {
  const config = {
    extends: "strict",
    checks: [{ id: "deps.max", predicate: "deps.max", params: { max: 7 } }],
    facts: { allowGuards: true },
  };
  it("answers `default` and its own name, extending builtins", async () => {
    for (const n of ["default", AXIOM_CONFIG_PROFILE_NAME]) {
      const p = await loadProfile(n, { config });
      expect(p.name).toBe(AXIOM_CONFIG_PROFILE_NAME);
      expect(p.checks.find((c) => c.id === "deps.max")?.params).toEqual({ max: 7 });
      expect(p.checks.map((c) => c.id)).toContain("manifest.noDeletes");
      expect(p.facts.allowGuards).toBe(true);
    }
  });
  it("other names still resolve normally", async () => {
    const p = await loadProfile("permissive", { config });
    expect(p.checks.map((c) => c.id)).toEqual(["path.reservedNames"]);
  });
  it("an empty section is never weaker than the builtin default", async () => {
    const builtin = await loadProfile("default");
    expect((await loadProfile("default", { config: {} })).checks).toEqual(builtin.checks);
    // An explicit empty list without extends is a deliberate choice and is honoured.
    expect((await loadProfile("default", { config: { checks: [] } })).checks).toEqual([]);
  });
  it("a config named `default` may extend the builtin `default`", async () => {
    const p = await loadProfile("default", {
      config: { name: "default", extends: "default", checks: [] },
    });
    expect(p.checks.map((c) => c.id)).toContain("repo.noOverwriteOf");
  });
  it("an invalid section → ERR_INVALID_PROFILE", async () => {
    for (const bad of [[], "x", { checks: "nope" }, { kind: "Plan" }]) {
      await expect(loadProfile("default", { config: bad })).rejects.toMatchObject({
        code: "ERR_INVALID_PROFILE",
      });
    }
  });
});

describe("file profiles", () => {
  let dir: string;
  // v2 apiVersion on purpose: 2.x profile files keep loading through 3.x (D-41).
  const base = { apiVersion: "axiom.dev/v2", kind: "Profile" };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "axiom-profiles-"));
    const w = (name: string, body: Record<string, unknown>) =>
      writeFile(join(dir, `${name}.json`), JSON.stringify({ ...base, name, ...body }));
    await w("team", {
      extends: "strict",
      checks: [
        { id: "deps.max", predicate: "deps.max", params: { max: 10 } },
        {
          id: "team.allow",
          predicate: "path.allow",
          params: { globs: ["apps/**"] },
          severity: "warn",
        },
      ],
      facts: { allowRepo: false },
    });
    await w("cyc-a", { extends: "cyc-b", checks: [] });
    await w("cyc-b", { extends: "cyc-a", checks: [] });
    await w("self", { extends: "self", checks: [] });
    await w("broken", { checks: "nope" });
    await writeFile(join(dir, "notjson.json"), "{");
    await w("misnamed", { name: "other", checks: [] });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves a 3-level chain with child overriding by id", async () => {
    const p = await loadProfile("team", { searchDirs: [dir] });
    expect(p.name).toBe("team");
    const ids = p.checks.map((c) => c.id);
    expect(ids).toContain("path.reservedNames");
    expect(ids).toContain("manifest.noDeletes");
    expect(ids.filter((i) => i === "deps.max")).toHaveLength(1);
    expect(p.checks.find((c) => c.id === "deps.max")?.params).toEqual({ max: 10 });
    expect(p.checks.find((c) => c.id === "team.allow")?.severity).toBe("warn");
    expect(p.facts.allowRepo).toBe(false);
    expect(p.facts.allowGuards).toBe(false);
  });
  it("detects cycles", async () => {
    await expect(loadProfile("cyc-a", { searchDirs: [dir] })).rejects.toMatchObject({
      code: "ERR_INVALID_PROFILE",
    });
    await expect(loadProfile("self", { searchDirs: [dir] })).rejects.toMatchObject({
      code: "ERR_INVALID_PROFILE",
    });
  });
  it("rejects invalid, non-JSON and misnamed files", async () => {
    for (const n of ["broken", "notjson", "misnamed"]) {
      await expect(loadProfile(n, { searchDirs: [dir] })).rejects.toMatchObject({
        code: "ERR_INVALID_PROFILE",
      });
    }
  });
  it("file shadows a builtin of the same name", async () => {
    await writeFile(
      join(dir, "default.json"),
      JSON.stringify({ ...base, name: "default", checks: [] }),
    );
    const p = await loadProfile("default", { searchDirs: [dir] });
    expect(p.checks).toEqual([]);
  });
});
