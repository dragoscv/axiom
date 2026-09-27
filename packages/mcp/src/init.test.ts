import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProfile } from "@codai/axiom-checks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GateProfileSchema } from "./gate.js";
import {
  CLAUDE_HOOK_ENTRY,
  COPILOT_HOOK,
  detectHarnesses,
  GITIGNORE_LINES,
  MCP_SERVER_ENTRY,
  profileNameFor,
  runInit,
} from "./init.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let outside: Awaited<ReturnType<typeof tmpRepo>>;
beforeEach(async () => {
  repo = await tmpRepo("axiom-init-");
  outside = await tmpRepo("axiom-init-outside-");
});
afterEach(async () => {
  await Promise.all([repo.cleanup(), outside.cleanup()]);
});

const readJson = async (rel: string) =>
  JSON.parse(await readFile(join(repo.root, rel), "utf8")) as Record<string, unknown>;

describe("axiom init (S-701)", () => {
  it("creates every file on a bare root (default harness copilot+vscode)", async () => {
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.harnesses).toEqual(["copilot", "vscode"]);
    expect(r.files.map((f) => [f.path, f.action])).toEqual([
      [".vscode/mcp.json", "created"],
      [".github/hooks/axiom-gate.json", "created"],
      [".axiom/profiles/demo.json", "created"],
      [".axiom/gate-profile.json", "created"],
      [".gitignore", "created"],
    ]);
    expect((await readJson(".vscode/mcp.json")).servers).toEqual({ axiom: MCP_SERVER_ENTRY });
    expect(await readJson(".github/hooks/axiom-gate.json")).toEqual(COPILOT_HOOK);
    // The profile loads through the real loader and extends default.
    const p = await loadProfile("demo", { searchDirs: [join(repo.root, ".axiom", "profiles")] });
    expect(p.name).toBe("demo");
    expect(p.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(["repo.noOverwriteOf", "content.noSecrets", "path.deny"]),
    );
    expect(GateProfileSchema.safeParse(await readJson(".axiom/gate-profile.json")).success).toBe(
      true,
    );
    const gi = (await readFile(join(repo.root, ".gitignore"), "utf8")).split("\n");
    expect(gi.filter((l) => l !== "")).toEqual(GITIGNORE_LINES);
  });

  it("second run skips every file and changes nothing", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const before = await readFile(join(repo.root, ".gitignore"), "utf8");
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.files.every((f) => f.action === "skipped")).toBe(true);
    expect(r.files).toHaveLength(5);
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe(before);
  });

  it("never overwrites an edited file without --force; --force updates it", async () => {
    await runInit({ root: repo.root, profileName: "demo" });
    const rel = ".axiom/gate-profile.json";
    await writeFile(join(repo.root, rel), '{"deny":["x/**"]}\n');
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.files.find((f) => f.path === rel)).toEqual({
      path: rel,
      action: "skipped",
      reason: "exists",
    });
    expect((await readJson(rel)).deny).toEqual(["x/**"]);
    const f = await runInit({ root: repo.root, profileName: "demo", force: true });
    expect(f.files.find((x) => x.path === rel)?.action).toBe("updated");
    expect((await readJson(rel)).deny).toContain(".git/**");
  });

  it("merges into an existing .vscode/mcp.json keeping other servers and keys", async () => {
    await mkdir(join(repo.root, ".vscode"));
    const other = { type: "stdio", command: "node", args: ["x.js"] };
    await writeFile(
      join(repo.root, ".vscode", "mcp.json"),
      JSON.stringify({ inputs: [{ id: "tok" }], servers: { other } }),
    );
    const r = await runInit({ root: repo.root, harness: "vscode", profileName: "demo" });
    expect(r.files.find((f) => f.path === ".vscode/mcp.json")?.action).toBe("merged");
    const doc = await readJson(".vscode/mcp.json");
    expect(doc.inputs).toEqual([{ id: "tok" }]);
    expect(doc.servers).toEqual({ other, axiom: MCP_SERVER_ENTRY });
    // An existing axiom entry is left alone without --force.
    const again = await runInit({ root: repo.root, harness: "vscode", profileName: "demo" });
    expect(again.files.find((f) => f.path === ".vscode/mcp.json")).toMatchObject({
      action: "skipped",
      reason: "already configured",
    });
  });

  it("skips (never rewrites) a JSONC mcp.json it cannot round-trip", async () => {
    await mkdir(join(repo.root, ".vscode"));
    const text = '{ // comment\n "servers": {} }\n';
    await writeFile(join(repo.root, ".vscode", "mcp.json"), text);
    const r = await runInit({ root: repo.root, harness: "vscode", profileName: "demo" });
    expect(r.files.find((f) => f.path === ".vscode/mcp.json")?.action).toBe("skipped");
    expect(await readFile(join(repo.root, ".vscode", "mcp.json"), "utf8")).toBe(text);
  });

  it("claude: merges hooks.PreToolUse into .claude/settings.json keeping existing entries", async () => {
    await mkdir(join(repo.root, ".claude"));
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "guard.ps1" }] };
    await writeFile(
      join(repo.root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["x"] }, hooks: { PreToolUse: [mine] } }),
    );
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.harnesses).toEqual(["claude"]);
    expect(r.files.find((f) => f.path === ".claude/settings.json")?.action).toBe("merged");
    expect(r.files.some((f) => f.path === ".github/hooks/axiom-gate.json")).toBe(false);
    const doc = await readJson(".claude/settings.json");
    expect(doc.permissions).toEqual({ allow: ["x"] });
    expect((doc.hooks as { PreToolUse: unknown[] }).PreToolUse).toEqual([mine, CLAUDE_HOOK_ENTRY]);
    const again = await runInit({ root: repo.root, profileName: "demo" });
    expect(again.files.find((f) => f.path === ".claude/settings.json")?.action).toBe("skipped");
  });

  it("appends only the missing .gitignore lines, preserving CRLF", async () => {
    await writeFile(join(repo.root, ".gitignore"), "node_modules\r\n.axiom/*");
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.files.find((f) => f.path === ".gitignore")?.action).toBe("updated");
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe(
      "node_modules\r\n.axiom/*\r\n!.axiom/profiles/\r\n!.axiom/gate-profile.json\r\n",
    );
  });

  it("auto-detects harness marker dirs", async () => {
    for (const d of [".github", ".codex"]) await mkdir(join(repo.root, d));
    expect(await detectHarnesses(repo.root)).toEqual(["copilot", "codex"]);
    expect(await detectHarnesses(repo.root, "claude")).toEqual(["claude"]);
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.notes.some((n) => n.startsWith("codex:"))).toBe(true);
  });

  it("never writes outside the root: a junction/symlinked .vscode is refused", async () => {
    await symlink(outside.root, join(repo.root, ".vscode"), "junction");
    await expect(runInit({ root: repo.root, profileName: "demo" })).rejects.toMatchObject({
      code: "ERR_SYMLINK_IN_PATH",
    });
    expect(await readdir(outside.root)).toEqual([]);
  });

  it("rejects invalid or builtin profile names with ERR_INVALID_PROFILE", async () => {
    await expect(runInit({ root: repo.root, profileName: "Bad Name" })).rejects.toMatchObject({
      code: "ERR_INVALID_PROFILE",
    });
    await expect(runInit({ root: repo.root, profileName: "default" })).rejects.toMatchObject({
      code: "ERR_INVALID_PROFILE",
    });
    expect(await readdir(repo.root)).toEqual([]);
  });

  it("profileNameFor sanitises repo dir names into ^[a-z0-9][a-z0-9._-]{0,63}$", () => {
    expect(profileNameFor("/x/My Repo (v2)")).toBe("my-repo-v2");
    expect(profileNameFor("/x/.hidden")).toBe("hidden");
    expect(profileNameFor("/x/___")).toBe("repo");
    expect(profileNameFor("/x/default")).toBe("default-repo");
    expect(profileNameFor(`/x/${"a".repeat(100)}`)).toHaveLength(64);
  });
});
