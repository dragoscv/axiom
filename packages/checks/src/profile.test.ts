import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinProfiles, loadProfile } from "./profile.js";

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
});

describe("file profiles", () => {
  let dir: string;
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
