import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProfile } from "@codai/axiom-checks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GateProfileSchema } from "./gate.js";
import {
  CLAUDE_HOOK_ENTRY,
  CLAUDE_HTTP_HOOK_ENTRY,
  CODEX_MCP_TOML,
  COPILOT_HOOK,
  COPILOT_HOOK_DAEMON,
  CURSOR_MCP_ENTRY,
  clineHookPs1,
  clineHookSh,
  codexHookEntry,
  cursorHooks,
  detectHarnesses,
  GATE_PROFILE,
  GITIGNORE_LINES,
  geminiHookEntry,
  type HarnessName,
  isAxiomGateEntry,
  JUNIE_GUIDELINES_MARKER,
  MCP_SERVER_ENTRY,
  PROJECT_MCP_ENTRY,
  profileNameFor,
  runInit,
  windsurfHooks,
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
  it("works when --root is an alias of the real dir (macOS /var → /private/var, Windows RUNNER~1)", async () => {
    // CI 36299852786: every init/doctor test failed ERR_CONTAINMENT on macOS + Windows runners
    // because the tmp root was not its own realpath. A junction/symlink gives the same shape.
    const alias = join(outside.root, "alias");
    await symlink(repo.root, alias, process.platform === "win32" ? "junction" : "dir");
    const r = await runInit({ root: alias, profileName: "demo" });
    expect(r.files.map((f) => f.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
      "created",
    ]);
    expect((await readJson(".vscode/mcp.json")).servers).toEqual({ axiom: MCP_SERVER_ENTRY });
  });

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

const pathsOf = (r: Awaited<ReturnType<typeof runInit>>) =>
  r.files.filter((f) => f.action !== "skipped").map((f) => f.path);

async function initTwice(harness: HarnessName, daemon = false) {
  const first = await runInit({ root: repo.root, harness, profileName: "demo", daemon });
  const second = await runInit({ root: repo.root, harness, profileName: "demo", daemon });
  return { first, second };
}

describe("axiom init — every harness", () => {
  it("cursor: hooks.json (failClosed, --format cursor) + mcp.json; idempotent", async () => {
    const { first, second } = await initTwice("cursor");
    expect(pathsOf(first)).toEqual(
      expect.arrayContaining([".cursor/hooks.json", ".cursor/mcp.json"]),
    );
    const hooks = await readJson(".cursor/hooks.json");
    expect(hooks).toEqual(cursorHooks());
    expect(JSON.stringify(hooks)).toContain("axiom gate --stdin --format cursor");
    expect((await readJson(".cursor/mcp.json")).mcpServers).toEqual({ axiom: CURSOR_MCP_ENTRY });
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("cursor: merges into an existing hooks.json keeping foreign hooks; claude+cursor notes the double run", async () => {
    await mkdir(join(repo.root, ".cursor"));
    await mkdir(join(repo.root, ".claude"));
    const mine = { command: "./guard.sh" };
    await writeFile(
      join(repo.root, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { preToolUse: [mine] } }),
    );
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.harnesses).toEqual(["claude", "cursor"]);
    expect(r.files.find((f) => f.path === ".cursor/hooks.json")?.action).toBe("merged");
    const doc = (await readJson(".cursor/hooks.json")) as { hooks: Record<string, unknown[]> };
    const fresh = cursorHooks() as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.preToolUse).toEqual([mine, fresh.hooks.preToolUse?.[0]]);
    expect(doc.hooks.beforeShellExecution).toEqual(fresh.hooks.beforeShellExecution);
    expect(r.notes.some((n) => n.startsWith("cursor:"))).toBe(true);
  });

  it("windsurf: writes .windsurf/hooks.json, or .devin/hooks.json when .devin exists", async () => {
    const { first, second } = await initTwice("windsurf");
    expect(pathsOf(first)).toContain(".windsurf/hooks.json");
    expect(await readJson(".windsurf/hooks.json")).toEqual(windsurfHooks());
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
    expect(
      first.notes.some((n) => n.startsWith("windsurf:") && n.includes("Restricted Mode")),
    ).toBe(true);
    await mkdir(join(repo.root, ".devin"));
    const devin = await runInit({ root: repo.root, profileName: "demo" });
    expect(devin.harnesses).toContain("windsurf");
    expect(pathsOf(devin)).toContain(".devin/hooks.json");
  });

  it("codex: .codex/hooks.json PreToolUse + an appended [mcp_servers.axiom] TOML block; idempotent", async () => {
    await mkdir(join(repo.root, ".codex"));
    const toml = 'model = "o5"\r\n[mcp_servers.other]\r\ncommand = "x"';
    await writeFile(join(repo.root, ".codex", "config.toml"), toml);
    const { first, second } = await initTwice("codex");
    expect((await readJson(".codex/hooks.json")).hooks).toEqual({ PreToolUse: [codexHookEntry()] });
    expect(first.files.find((f) => f.path === ".codex/config.toml")?.action).toBe("merged");
    expect(await readFile(join(repo.root, ".codex", "config.toml"), "utf8")).toBe(
      `${toml}\r\n\r\n${CODEX_MCP_TOML.join("\r\n")}\r\n`,
    );
    expect(first.notes.some((n) => n.startsWith("codex:") && n.includes("/hooks"))).toBe(true);
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("codex: an existing [mcp_servers.axiom] table is never touched", async () => {
    await mkdir(join(repo.root, ".codex"));
    const toml = '[mcp_servers.axiom]\ncommand = "axiom"\n';
    await writeFile(join(repo.root, ".codex", "config.toml"), toml);
    const r = await runInit({
      root: repo.root,
      harness: "codex",
      profileName: "demo",
      force: true,
    });
    expect(r.files.find((f) => f.path === ".codex/config.toml")?.action).toBe("skipped");
    expect(await readFile(join(repo.root, ".codex", "config.toml"), "utf8")).toBe(toml);
  });

  it("gemini: merges hooks.BeforeTool and mcpServers.axiom into .gemini/settings.json", async () => {
    await mkdir(join(repo.root, ".gemini"));
    await writeFile(join(repo.root, ".gemini", "settings.json"), JSON.stringify({ theme: "x" }));
    const { first, second } = await initTwice("gemini");
    expect(first.files.find((f) => f.path === ".gemini/settings.json")?.action).toBe("merged");
    const doc = await readJson(".gemini/settings.json");
    expect(doc.theme).toBe("x");
    expect(doc.hooks).toEqual({ BeforeTool: [geminiHookEntry()] });
    expect(doc.mcpServers).toEqual({ axiom: PROJECT_MCP_ENTRY });
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("junie: project MCP file + append-only guidelines + a note with the user-level hook", async () => {
    await mkdir(join(repo.root, ".junie"));
    await writeFile(join(repo.root, ".junie", "guidelines.md"), "# Rules\n- be nice\n");
    const { first, second } = await initTwice("junie");
    expect((await readJson(".junie/mcp/mcp.json")).mcpServers).toEqual({
      axiom: PROJECT_MCP_ENTRY,
    });
    const md = await readFile(join(repo.root, ".junie", "guidelines.md"), "utf8");
    expect(md.startsWith("# Rules\n- be nice\n\n")).toBe(true);
    expect(md.split("\n").filter((l) => l === JUNIE_GUIDELINES_MARKER)).toHaveLength(1);
    const note = first.notes.find((n) => n.startsWith("junie:"));
    expect(note).toContain("~/.junie/config.json");
    expect(note).toContain("axiom gate --stdin --format junie");
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("cline: POSIX (0755, shebang, LF) + PowerShell hooks that print a cancel when the gate cannot run", async () => {
    const { first, second } = await initTwice("cline");
    expect(pathsOf(first)).toEqual(
      expect.arrayContaining([".clinerules/hooks/PreToolUse", ".clinerules/hooks/PreToolUse.ps1"]),
    );
    const sh = await readFile(join(repo.root, ".clinerules", "hooks", "PreToolUse"), "utf8");
    expect(sh).toBe(clineHookSh());
    expect(sh.startsWith("#!/usr/bin/env sh\n")).toBe(true);
    expect(sh).not.toContain("\r");
    expect(sh).toContain("axiom gate --stdin --format cline");
    expect(sh).toContain('{"cancel":true');
    const ps1 = await readFile(join(repo.root, ".clinerules", "hooks", "PreToolUse.ps1"), "utf8");
    expect(ps1).toBe(clineHookPs1());
    expect(ps1).not.toContain("\r");
    expect(ps1).toContain("[Console]::In.ReadToEnd()");
    expect(ps1).toContain('{"cancel":true');
    if (process.platform !== "win32") {
      const mode = (await stat(join(repo.root, ".clinerules", "hooks", "PreToolUse"))).mode;
      expect(mode & 0o777).toBe(0o755);
    }
    expect(first.notes.some((n) => n.startsWith("cline:") && n.includes("Enable Hooks"))).toBe(
      true,
    );
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("auto-detects every new marker dir (.devin and .windsurf map to one windsurf)", async () => {
    for (const d of [".cursor", ".windsurf", ".devin", ".gemini", ".junie", ".clinerules"]) {
      await mkdir(join(repo.root, d));
    }
    expect(await detectHarnesses(repo.root)).toEqual([
      "cursor",
      "windsurf",
      "gemini",
      "junie",
      "cline",
    ]);
  });

  it("--daemon: claude http hook, axiom-hook in every command hook, daemon note", async () => {
    for (const d of [".github", ".claude", ".cursor", ".codex", ".gemini", ".windsurf"]) {
      await mkdir(join(repo.root, d));
    }
    const r = await runInit({ root: repo.root, profileName: "demo", daemon: true });
    expect(await readJson(".github/hooks/axiom-gate.json")).toEqual(COPILOT_HOOK_DAEMON);
    const claude = (await readJson(".claude/settings.json")) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(claude.hooks.PreToolUse).toEqual([CLAUDE_HTTP_HOOK_ENTRY]);
    expect(CLAUDE_HTTP_HOOK_ENTRY.hooks[0]?.url).toBe("http://127.0.0.1:47861/v1/hook/claude");
    expect(await readJson(".cursor/hooks.json")).toEqual(cursorHooks("axiom-hook"));
    expect((await readJson(".codex/hooks.json")).hooks).toEqual({
      PreToolUse: [codexHookEntry("axiom-hook")],
    });
    expect((await readJson(".gemini/settings.json")).hooks).toEqual({
      BeforeTool: [geminiHookEntry("axiom-hook")],
    });
    expect(await readJson(".windsurf/hooks.json")).toEqual(windsurfHooks("axiom-hook"));
    expect(r.notes.some((n) => n.includes("axiom serve --hook --root"))).toBe(true);
    // A daemon re-run recognises the http entry as ours; a plain run recognises axiom-hook.
    const again = await runInit({ root: repo.root, profileName: "demo", daemon: true });
    expect(again.files.every((f) => f.action === "skipped")).toBe(true);
    const plain = await runInit({ root: repo.root, profileName: "demo" });
    expect(plain.files.find((f) => f.path === ".claude/settings.json")?.action).toBe("skipped");
    expect(plain.files.find((f) => f.path === ".cursor/hooks.json")?.action).toBe("skipped");
  });

  it("isAxiomGateEntry accepts axiom, axiom-hook and the daemon http hook, nothing else", () => {
    expect(isAxiomGateEntry(CLAUDE_HOOK_ENTRY)).toBe(true);
    expect(isAxiomGateEntry(CLAUDE_HTTP_HOOK_ENTRY)).toBe(true);
    expect(isAxiomGateEntry(codexHookEntry("axiom-hook"))).toBe(true);
    expect(isAxiomGateEntry({ hooks: [{ type: "command", command: "guard.ps1" }] })).toBe(false);
    expect(isAxiomGateEntry({ hooks: [{ type: "http", url: "http://x/other" }] })).toBe(false);
  });

  it("the gate profile opts into steering hints", () => {
    expect(GATE_PROFILE.steer).toBe("hint");
  });
});
