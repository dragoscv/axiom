import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "@codai/axiom-checks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GateProfileSchema } from "./gate.js";
import {
  CLAUDE_HOOK_ENTRY,
  CLAUDE_HTTP_HOOK_ENTRY,
  CLAUDE_POST_HOOK_ENTRY,
  CODEX_MCP_TOML,
  COPILOT_HOOK,
  COPILOT_HOOK_DAEMON,
  COPILOT_POST_ENTRY,
  CURSOR_MCP_ENTRY,
  clineHookPs1,
  clineHookSh,
  codexHookEntry,
  codexPostHookEntry,
  codexRequirementsToml,
  cursorHooks,
  detectHarnesses,
  GATE_PROFILE,
  GITIGNORE_LINES,
  gateCommandBash,
  gateCommandPowerShell,
  geminiHookEntry,
  gitignoreHidesPolicy,
  type HarnessName,
  HOOK_TIMEOUT_SEC,
  INIT_FILES,
  initDryRun,
  isAxiomGateEntry,
  isAxiomPostEntry,
  JUNIE_GUIDELINES_MARKER,
  junieUserHooks,
  KIRO_MATCHER,
  kiroHooks,
  MANAGED_FILES,
  MCP_SERVER_ENTRY,
  OPENCODE_PLUGIN,
  PROJECT_MCP_ENTRY,
  profileNameFor,
  runInit,
  toDaemonCommand,
  upgradeCodexToml,
  WINDSURF_EVENTS,
  windsurfHooks,
} from "./init.js";
import { tmpRepo } from "./test-helpers.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let outside: Awaited<ReturnType<typeof tmpRepo>>;
let home: Awaited<ReturnType<typeof tmpRepo>>;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeEach(async () => {
  repo = await tmpRepo("axiom-init-");
  outside = await tmpRepo("axiom-init-outside-");
  home = await tmpRepo("axiom-init-home-");
  process.env.HOME = home.root;
  process.env.USERPROFILE = home.root;
});
afterEach(async () => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await Promise.all([repo.cleanup(), outside.cleanup(), home.cleanup()]);
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
      "node_modules\r\n.axiom/*\r\n!.axiom/profiles/\r\n!.axiom/gate-profile.json\r\n!.axiom/axiom.json\r\n!.axiom/mcp-pins.json\r\n",
    );
  });

  it("notes a directory-level .axiom ignore that would hide the policy files", async () => {
    await writeFile(join(repo.root, ".gitignore"), "dist/\n.axiom/\n");
    expect(await gitignoreHidesPolicy(repo.root)).toBe(true);
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.notes.some((n) => n.includes("cannot re-include"))).toBe(true);
    await writeFile(join(repo.root, ".gitignore"), "dist/\n.axiom/*\n");
    expect(await gitignoreHidesPolicy(repo.root)).toBe(false);
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
    expect((await readJson(".codex/hooks.json")).hooks).toEqual({
      PreToolUse: [codexHookEntry()],
      PostToolUse: [codexPostHookEntry()],
    });
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
    const dirs = [".cursor", ".windsurf", ".devin", ".gemini", ".junie", ".clinerules", ".kiro"];
    for (const d of [...dirs, ".opencode"]) {
      await mkdir(join(repo.root, d));
    }
    expect(await detectHarnesses(repo.root)).toEqual([
      "cursor",
      "windsurf",
      "gemini",
      "junie",
      "cline",
      "kiro",
      "opencode",
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
      PostToolUse: [codexPostHookEntry()],
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

  it("copilot hook is visible to VS Code: command + bash + powershell, no exec (2.5.2)", () => {
    for (const doc of [COPILOT_HOOK, COPILOT_HOOK_DAEMON]) {
      const e = (doc.hooks as { preToolUse: Record<string, unknown>[] }).preToolUse[0] ?? {};
      expect(e.exec).toBeUndefined();
      expect(e.args).toBeUndefined();
      expect(String(e.command)).toMatch(/gate --stdin --format auto$/);
      expect(String(e.bash)).toMatch(/gate --stdin --format auto; rc=\$\?; .* exit \$rc$/);
      // PowerShell -Command maps exit 2 (the deny) to 1 unless the code is propagated, and a
      // missing node / crash must become 2 (VS Code Local blocks only on 2).
      expect(String(e.powershell)).toMatch(
        /^axiom(\.cmd|-hook\.exe) gate .*; if \(\$LASTEXITCODE -notin 0,2\) \{ exit 2 \} else \{ exit \$LASTEXITCODE \}$/,
      );
      expect(e.timeoutSec).toBe(HOOK_TIMEOUT_SEC);
    }
  });

  it("migrates a pre-2.5.2 exec-only axiom-gate.json without --force; leaves foreign files alone", async () => {
    await mkdir(join(repo.root, ".github", "hooks"), { recursive: true });
    const legacy = {
      version: 1,
      hooks: {
        preToolUse: [{ type: "command", exec: "axiom", args: ["gate", "--stdin"], timeoutSec: 5 }],
      },
    };
    await writeFile(join(repo.root, ".github/hooks/axiom-gate.json"), JSON.stringify(legacy));
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.files.find((f) => f.path === ".github/hooks/axiom-gate.json")).toMatchObject({
      action: "updated",
    });
    expect(await readJson(".github/hooks/axiom-gate.json")).toEqual(COPILOT_HOOK);
    // A hand-written file with command fields is not ours to rewrite.
    const mine = { version: 1, hooks: { preToolUse: [{ type: "command", command: "guard.ps1" }] } };
    await writeFile(join(repo.root, ".github/hooks/axiom-gate.json"), JSON.stringify(mine));
    const again = await runInit({ root: repo.root, profileName: "demo" });
    expect(again.files.find((f) => f.path === ".github/hooks/axiom-gate.json")?.action).toBe(
      "skipped",
    );
  });

  it("windsurf maps crashes to exit 2; codex Windows commands are the bare shim (no PowerShell suffix)", () => {
    const w = windsurfHooks() as { hooks: Record<string, { powershell: string }[]> };
    expect(w.hooks.pre_write_code?.[0]?.powershell).toBe(
      "axiom.cmd gate --stdin --format windsurf; if ($LASTEXITCODE -notin 0,2) { exit 2 } else { exit $LASTEXITCODE }",
    );
    const c = codexHookEntry() as { hooks: { commandWindows: string }[] };
    expect(c.hooks[0]?.commandWindows).toBe("axiom.cmd gate --stdin --format codex");
    const cp = codexPostHookEntry() as { hooks: { commandWindows: string }[] };
    expect(cp.hooks[0]?.commandWindows).toBe("axiom.cmd gate --stdin --post --format codex");
    const d = codexHookEntry("axiom-hook") as { hooks: { commandWindows: string }[] };
    expect(d.hooks[0]?.commandWindows).toBe("axiom-hook.exe gate --stdin --format codex");
  });

  it("claude command hook fails closed and covers shell tools", () => {
    expect(CLAUDE_HOOK_ENTRY.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell");
    expect(CLAUDE_HOOK_ENTRY.hooks[0]).toMatchObject({
      onFailure: "block",
      timeout: HOOK_TIMEOUT_SEC,
    });
    expect(CLAUDE_HOOK_ENTRY.hooks[0]?.command).toBe("axiom gate --stdin --format claude");
  });
});

describe("axiom init — shell matchers and PostToolUse (S-1205)", () => {
  it("every matcher AXIOM writes covers the harness's shell tool (PowerShell where it exists)", () => {
    expect(CLAUDE_HOOK_ENTRY.matcher.split("|")).toEqual(
      expect.arrayContaining(["Bash", "PowerShell"]),
    );
    expect(CLAUDE_POST_HOOK_ENTRY.matcher.split("|")).toEqual(
      expect.arrayContaining(["Bash", "PowerShell", "Write", "Edit", "MultiEdit"]),
    );
    // Codex matches shell + unified exec as Bash (no separate PowerShell tool name).
    expect(String(codexHookEntry().matcher)).toMatch(/\bBash\b/);
    expect(String(geminiHookEntry().matcher)).toMatch(/run_shell_command/);
    const junie = junieUserHooks() as { hooks: { PreToolUse: { matcher: string }[] } };
    expect(junie.hooks.PreToolUse[0]?.matcher).toMatch(/\bBash\b/);
    const cursor = cursorHooks() as { hooks: { preToolUse: { matcher: string }[] } };
    expect(cursor.hooks.preToolUse[0]?.matcher).toMatch(/\bShell\b/);
  });

  it("claude + codex + copilot get the post-write entry; re-run is idempotent", async () => {
    for (const d of [".github", ".claude", ".codex"]) await mkdir(join(repo.root, d));
    await runInit({ root: repo.root, profileName: "demo" });
    const claude = (await readJson(".claude/settings.json")) as {
      hooks: { PreToolUse: unknown[]; PostToolUse: unknown[] };
    };
    expect(claude.hooks.PostToolUse).toEqual([CLAUDE_POST_HOOK_ENTRY]);
    expect(claude.hooks.PreToolUse.some(isAxiomPostEntry)).toBe(false);
    expect(CLAUDE_POST_HOOK_ENTRY.hooks[0]?.command).toBe(
      "axiom gate --stdin --post --format claude",
    );
    const copilot = (await readJson(".github/hooks/axiom-gate.json")) as {
      hooks: { postToolUse: unknown[] };
    };
    expect(copilot.hooks.postToolUse).toEqual([COPILOT_POST_ENTRY]);
    const codex = (await readJson(".codex/hooks.json")) as { hooks: { PostToolUse: unknown[] } };
    expect(codex.hooks.PostToolUse).toEqual([codexPostHookEntry()]);
    const again = await runInit({ root: repo.root, profileName: "demo" });
    expect(again.files.every((f) => f.action === "skipped")).toBe(true);
  });
});

const NEW_BIN = async () => ({ path: "/usr/bin/axiom", version: "2.6.0" });
const up = (over: Partial<Parameters<typeof runInit>[0]> = {}) =>
  runInit({
    root: repo.root,
    profileName: "demo",
    upgrade: true,
    locateBin: NEW_BIN,
    daemonRunning: async () => false,
    ...over,
  });
const actionOf = (r: Awaited<ReturnType<typeof runInit>>, rel: string) =>
  r.files.find((f) => f.path === rel)?.action;

describe("axiom init --upgrade (S-1204)", () => {
  it("(a) adds record + steer to the gate profile, keeps user keys; old bin → untouched", async () => {
    await put(".axiom/gate-profile.json", { deny: ["x/**"], custom: 1 });
    const old = await up({ locateBin: async () => ({ path: "/a", version: "2.4.1" }) });
    expect(actionOf(old, ".axiom/gate-profile.json")).toBe("skipped");
    expect(old.notes.some((n) => n.includes("2.5.0"))).toBe(true);
    const r = await up();
    expect(actionOf(r, ".axiom/gate-profile.json")).toBe("updated");
    expect(await readJson(".axiom/gate-profile.json")).toEqual({
      deny: ["x/**"],
      custom: 1,
      record: true,
      steer: "hint",
    });
    await put(".axiom/gate-profile.json", { deny: [], steer: "off", record: false });
    expect(actionOf(await up(), ".axiom/gate-profile.json")).toBe("skipped");
    expect((await readJson(".axiom/gate-profile.json")).steer).toBe("off");
  });

  it("(b) a running daemon switches gate hooks to axiom-hook and Claude to the http hook", async () => {
    for (const d of [".github", ".claude", ".cursor", ".codex", ".gemini", ".windsurf"]) {
      await mkdir(join(repo.root, d));
    }
    await runInit({ root: repo.root, profileName: "demo" });
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "guard.ps1" }] };
    const claudeDoc = (await readJson(".claude/settings.json")) as {
      hooks: { PreToolUse: unknown[] };
    };
    claudeDoc.hooks.PreToolUse.unshift(foreign);
    await put(".claude/settings.json", claudeDoc);
    const r = await up({ daemonRunning: async () => true });
    for (const rel of [
      ".github/hooks/axiom-gate.json",
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".gemini/settings.json",
      ".windsurf/hooks.json",
    ]) {
      expect(actionOf(r, rel), rel).toBe("updated");
    }
    const copilot = (await readJson(".github/hooks/axiom-gate.json")) as {
      hooks: { preToolUse: unknown[]; postToolUse: unknown[] };
    };
    expect(copilot.hooks.preToolUse).toEqual(
      (COPILOT_HOOK_DAEMON.hooks as { preToolUse: unknown[] }).preToolUse,
    );
    // The post check stays on the global bin.
    expect(copilot.hooks.postToolUse).toEqual([COPILOT_POST_ENTRY]);
    const claude = (await readJson(".claude/settings.json")) as {
      hooks: { PreToolUse: unknown[]; PostToolUse: unknown[] };
    };
    expect(claude.hooks.PreToolUse).toEqual([foreign, CLAUDE_HTTP_HOOK_ENTRY]);
    expect(claude.hooks.PostToolUse).toEqual([CLAUDE_POST_HOOK_ENTRY]);
    expect(await readJson(".cursor/hooks.json")).toEqual(cursorHooks("axiom-hook"));
    expect(
      ((await readJson(".codex/hooks.json")).hooks as Record<string, unknown>).PreToolUse,
    ).toEqual([codexHookEntry("axiom-hook")]);
    expect(await readJson(".windsurf/hooks.json")).toEqual(windsurfHooks("axiom-hook"));
    expect(toDaemonCommand("axiom gate --stdin --post --format claude")).toBe(
      "axiom gate --stdin --post --format claude",
    );
    expect(toDaemonCommand("guard.ps1 gate")).toBe("guard.ps1 gate");
    // Idempotent.
    const again = await up({ daemonRunning: async () => true });
    expect(again.files.filter((f) => f.action !== "skipped")).toEqual([]);
  });

  it("(c) npx MCP entries → global bin when present; kept (with a note) when absent", async () => {
    await mkdir(join(repo.root, ".codex"));
    await put(".vscode/mcp.json", {
      servers: { axiom: MCP_SERVER_ENTRY, other: { command: "x" } },
    });
    await put(".codex/config.toml", `model = "o5"\n${CODEX_MCP_TOML.join("\n")}\n`);
    const none = await up({ locateBin: async () => undefined });
    expect(actionOf(none, ".vscode/mcp.json")).toBe("skipped");
    expect(none.notes.some((n) => n.includes("kept on npx"))).toBe(true);
    const r = await up();
    expect(actionOf(r, ".vscode/mcp.json")).toBe("updated");
    const servers = (await readJson(".vscode/mcp.json")).servers as Record<string, unknown>;
    expect(servers.axiom).toEqual({
      type: "stdio",
      command: "axiom",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the same VS Code variable is kept.
      args: ["mcp", "--root", "${workspaceFolder}"],
    });
    expect(servers.other).toEqual({ command: "x" });
    expect(actionOf(r, ".codex/config.toml")).toBe("updated");
    expect(await readFile(join(repo.root, ".codex", "config.toml"), "utf8")).toBe(
      'model = "o5"\n[mcp_servers.axiom]\ncommand = "axiom"\nargs = ["mcp", "--root", "."]\n',
    );
    expect(upgradeCodexToml('[mcp_servers.axiom]\ncommand = "axiom"\n').reasons).toEqual([]);
    const again = await up();
    expect(again.files.filter((f) => f.action !== "skipped")).toEqual([]);
  });

  it("(d) migrates the legacy exec-only Copilot hook; (e) adds missing PostToolUse wiring", async () => {
    await put(".github/hooks/axiom-gate.json", {
      version: 1,
      hooks: { preToolUse: [{ type: "command", exec: "axiom", args: ["gate", "--stdin"] }] },
    });
    const pre = { matcher: CLAUDE_HOOK_ENTRY.matcher, hooks: CLAUDE_HOOK_ENTRY.hooks };
    await put(".claude/settings.json", { hooks: { PreToolUse: [pre] } });
    await put(".codex/hooks.json", { hooks: { PreToolUse: [codexHookEntry()] } });
    const r = await up();
    expect(r.files.find((f) => f.path === ".github/hooks/axiom-gate.json")).toMatchObject({
      action: "updated",
    });
    expect(await readJson(".github/hooks/axiom-gate.json")).toEqual(COPILOT_HOOK);
    expect(actionOf(r, ".claude/settings.json")).toBe("updated");
    expect(
      ((await readJson(".claude/settings.json")).hooks as Record<string, unknown>).PostToolUse,
    ).toEqual([CLAUDE_POST_HOOK_ENTRY]);
    expect(
      ((await readJson(".codex/hooks.json")).hooks as Record<string, unknown>).PostToolUse,
    ).toEqual([codexPostHookEntry()]);
    // A bin < 2.6.0 does not get --post wiring.
    await put(".claude/settings.json", { hooks: { PreToolUse: [pre] } });
    const old = await up({ locateBin: async () => ({ path: "/a", version: "2.5.2" }) });
    expect(actionOf(old, ".claude/settings.json")).toBe("skipped");
  });

  it("never creates files that are not there and changes nothing on an up-to-date root", async () => {
    const empty = await up({ daemonRunning: async () => true });
    expect(empty.files).toEqual([]);
    expect(await readdir(repo.root)).toEqual([]);
    for (const d of [".github", ".claude", ".codex"]) await mkdir(join(repo.root, d));
    await runInit({ root: repo.root, profileName: "demo" });
    // A fresh init only lacks the npx → bin MCP switch; everything else is already current.
    const first = await up();
    expect(first.files.filter((f) => f.action !== "skipped").map((f) => f.path)).toEqual([
      ".vscode/mcp.json",
      ".codex/config.toml",
    ]);
    const second = await up();
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });
});

describe("axiom init --managed (S-1207)", () => {
  it("writes the managed policy layers into --out with install notes; parses", async () => {
    const out = join(outside.root, "policy");
    const r = await runInit({ root: repo.root, managed: { out } });
    expect(r.files.map((f) => [f.path, f.action])).toEqual(
      Object.values(MANAGED_FILES).map((p) => [p, "created"]),
    );
    expect(await readdir(repo.root)).toEqual([]);
    const claude = JSON.parse(await readFile(join(out, MANAGED_FILES.claude), "utf8")) as {
      allowManagedHooksOnly: boolean;
      disableAllHooks?: boolean;
      hooks: { PreToolUse: { hooks: { onFailure: string }[] }[]; PostToolUse: unknown[] };
    };
    expect(claude.allowManagedHooksOnly).toBe(true);
    expect(claude.disableAllHooks).toBeUndefined();
    expect(claude.hooks.PreToolUse[0]?.hooks[0]?.onFailure).toBe("block");
    expect(claude.hooks.PostToolUse).toEqual([CLAUDE_POST_HOOK_ENTRY]);
    const toml = await readFile(join(out, MANAGED_FILES.codex), "utf8");
    expect(toml).toBe(codexRequirementsToml());
    for (const key of [
      "allow_managed_hooks_only = true",
      "[features]",
      "hooks = true",
      "allowed_approval_policies",
      "[[hooks.PreToolUse]]",
      "[[hooks.PostToolUse.hooks]]",
      "axiom gate --stdin --format codex",
    ]) {
      expect(toml, key).toContain(key);
    }
    expect(toml).not.toContain('"never"');
    const cursor = JSON.parse(await readFile(join(out, MANAGED_FILES.cursor), "utf8"));
    expect(cursor).toEqual(cursorHooks());
    const copilot = JSON.parse(await readFile(join(out, MANAGED_FILES.copilot), "utf8"));
    expect(copilot).toEqual(COPILOT_HOOK);
    const md = await readFile(join(out, MANAGED_FILES.vscode), "utf8");
    for (const p of ["ChatHooks", "ChatToolsAutoApprove", "ChatAllowManagedHooksOnly"]) {
      expect(md).toContain(p);
    }
    for (const h of ["claude:", "codex:", "cursor:", "copilot:", "vscode:"]) {
      expect(
        r.notes.some((n) => n.startsWith(h)),
        h,
      ).toBe(true);
    }
    expect(r.notes.some((n) => n.includes("C:\\Program Files\\ClaudeCode"))).toBe(true);
    const again = await runInit({ root: repo.root, managed: { out } });
    expect(again.files.every((f) => f.action === "skipped")).toBe(true);
  });
});

async function put(rel: string, v: unknown): Promise<void> {
  const abs = join(repo.root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, typeof v === "string" ? v : JSON.stringify(v));
}

describe("axiom init — v3 harnesses (B4)", () => {
  it("kiro: .kiro/hooks/axiom-gate.json v1 PreToolUse, write|shell|@mcp, --format kiro; idempotent", async () => {
    const { first, second } = await initTwice("kiro");
    expect(pathsOf(first)).toContain(INIT_FILES.kiroHook);
    const doc = await readJson(INIT_FILES.kiroHook);
    expect(doc).toEqual(kiroHooks());
    expect(doc).toEqual({
      version: "v1",
      hooks: [
        {
          name: "axiom-gate",
          description: "AXIOM write gate (axiom init)",
          trigger: "PreToolUse",
          matcher: "write|shell|@mcp",
          action: { type: "command", command: "axiom gate --stdin --format kiro" },
          timeout: HOOK_TIMEOUT_SEC,
        },
      ],
    });
    expect(KIRO_MATCHER.split("|")).toEqual(expect.arrayContaining(["write", "shell"]));
    expect(first.notes.some((n) => n.startsWith("kiro:"))).toBe(true);
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
    const d = kiroHooks("axiom-hook") as { hooks: { action: { command: string } }[] };
    expect(d.hooks[0]?.action.command).toBe("axiom-hook gate --stdin --format kiro");
  });

  it("kiro and opencode are picked by --harness auto from their marker dirs", async () => {
    await mkdir(join(repo.root, ".kiro"));
    await mkdir(join(repo.root, ".opencode"));
    const r = await runInit({ root: repo.root, profileName: "demo" });
    expect(r.harnesses).toEqual(["kiro", "opencode"]);
    expect(pathsOf(r)).toEqual(
      expect.arrayContaining([INIT_FILES.kiroHook, INIT_FILES.opencodePlugin]),
    );
  });

  it("opencode: writes the single-file ESM plugin (tool.execute.before, spawn without a shell)", async () => {
    const { first, second } = await initTwice("opencode");
    expect(pathsOf(first)).toContain(INIT_FILES.opencodePlugin);
    const js = await readFile(join(repo.root, INIT_FILES.opencodePlugin), "utf8");
    expect(js).toBe(OPENCODE_PLUGIN);
    expect(js).toContain('"tool.execute.before"');
    expect(js).toContain('from "node:child_process"');
    expect(js).toContain('"gate", "--stdin", "--format", "claude"');
    expect(js).not.toMatch(/shell\s*:\s*true/);
    expect(js).not.toMatch(/\bexecSync?\(/);
    expect(js).toContain("15000");
    expect(js).not.toContain("\r");
    expect(first.notes.some((n) => n.startsWith("opencode:"))).toBe(true);
    expect(second.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("windsurf/devin also gate MCP tools (pre_mcp_tool_use); every event uses the crash-mapping forms", async () => {
    const doc = windsurfHooks() as {
      hooks: Record<string, { command: string; powershell: string }[]>;
    };
    expect(Object.keys(doc.hooks)).toEqual([...WINDSURF_EVENTS]);
    expect(WINDSURF_EVENTS).toContain("pre_mcp_tool_use");
    for (const ev of WINDSURF_EVENTS) {
      expect(doc.hooks[ev]?.[0]).toEqual({
        command: gateCommandBash("axiom", "windsurf"),
        powershell: gateCommandPowerShell("axiom", "windsurf"),
      });
    }
    expect(gateCommandBash("axiom", "windsurf")).toBe(
      "axiom gate --stdin --format windsurf; rc=$?; [ $rc -eq 0 ] || [ $rc -eq 2 ] || exit 2; exit $rc",
    );
  });

  it("junie: the user-level snippet pins --root to this repository", async () => {
    await mkdir(join(repo.root, ".junie"));
    const r = await runInit({ root: repo.root, profileName: "demo" });
    const note = r.notes.find((n) => n.startsWith("junie:")) ?? "";
    const snippet = JSON.parse(note.slice(note.indexOf("{"))) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const cmd = snippet.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
    expect(cmd.startsWith("axiom gate --stdin --format junie --root ")).toBe(true);
    expect(cmd).toContain(r.root.includes(" ") ? JSON.stringify(r.root) : r.root);
    expect(junieUserHooks("axiom", "/a b")).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit|Bash",
            hooks: [
              {
                type: "command",
                command: 'axiom gate --stdin --format junie --root "/a b"',
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  });

  it.runIf(process.platform === "win32")(
    "PowerShell form: gate exit 0/2 pass through, crash (1) and a missing axiom.cmd become 2",
    async () => {
      const { execFile } = await import("node:child_process");
      const bin = join(outside.root, "bin");
      await mkdir(bin);
      const run = (code: number | "missing") =>
        new Promise<number>((resolve) => {
          const dir = code === "missing" ? join(outside.root, "empty") : bin;
          const cmd = gateCommandPowerShell("axiom", "auto");
          const env = { ...process.env, PATH: `${dir};${process.env.SystemRoot}\\System32` };
          const go = async () => {
            if (code !== "missing") await writeFile(join(bin, "axiom.cmd"), `@exit /b ${code}\r\n`);
            const ps = join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            );
            execFile(
              ps,
              ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
              { env, windowsHide: true },
              (err) => resolve(err === null ? 0 : Number((err as { code?: unknown }).code)),
            );
          };
          void go();
        });
      expect(await run(0)).toBe(0);
      expect(await run(2)).toBe(2);
      expect(await run(1)).toBe(2);
      expect(await run(3)).toBe(2);
      expect(await run("missing")).toBe(2);
    },
    60_000,
  );

  it.runIf(process.platform !== "win32")(
    "bash form: gate exit 0/2 pass through, crash and command-not-found (127) become 2",
    async () => {
      const { execFile } = await import("node:child_process");
      const bin = join(outside.root, "bin");
      await mkdir(bin);
      const run = (code: number | "missing") =>
        new Promise<number>((resolve) => {
          const go = async () => {
            if (code !== "missing") {
              await writeFile(join(bin, "axiom"), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
            }
            const dir = code === "missing" ? join(outside.root, "empty") : bin;
            execFile(
              "/bin/sh",
              ["-c", gateCommandBash("axiom", "windsurf")],
              { env: { PATH: `${dir}:/usr/bin:/bin` } },
              (err) => resolve(err === null ? 0 : Number((err as { code?: unknown }).code)),
            );
          };
          void go();
        });
      expect(await run(0)).toBe(0);
      expect(await run(2)).toBe(2);
      expect(await run(1)).toBe(2);
      expect(await run("missing")).toBe(2);
    },
  );
});

describe("axiom init --dry-run (I-19)", () => {
  it("computes every file and a unified diff without writing anything", async () => {
    for (const d of [".github", ".claude", ".kiro"]) await mkdir(join(repo.root, d));
    await writeFile(join(repo.root, ".gitignore"), "node_modules\n");
    const r = await initDryRun({ root: repo.root, profileName: "demo" });
    expect(r.files.map((f) => [f.path, f.action])).toEqual([
      [".vscode/mcp.json", "created"],
      [".github/hooks/axiom-gate.json", "created"],
      [".claude/settings.json", "created"],
      [INIT_FILES.kiroHook, "created"],
      [".axiom/profiles/demo.json", "created"],
      [".axiom/gate-profile.json", "created"],
      [".gitignore", "updated"],
    ]);
    expect((await readdir(repo.root)).sort()).toEqual([
      ".claude",
      ".github",
      ".gitignore",
      ".kiro",
    ]);
    expect(await readdir(join(repo.root, ".kiro"))).toEqual([]);
    expect(await readFile(join(repo.root, ".gitignore"), "utf8")).toBe("node_modules\n");
    const diff = r.diff ?? "";
    expect(diff).toContain("--- /dev/null\n+++ b/.kiro/hooks/axiom-gate.json");
    expect(diff).toContain("--- a/.gitignore\n+++ b/.gitignore");
    expect(diff).toContain("+.axiom/*");
    expect(diff).toContain('+  "version": 3,');
    expect(r.notes.some((n) => n.startsWith("dry run:"))).toBe(true);
    // The real run then writes exactly what the dry run predicted.
    const real = await runInit({ root: repo.root, profileName: "demo" });
    expect(real.files.map((f) => [f.path, f.action])).toEqual(
      r.files.map((f) => [f.path, f.action]),
    );
    expect(real.diff).toBeUndefined();
    const again = await initDryRun({ root: repo.root, profileName: "demo" });
    expect(again.diff).toBe("");
    expect(again.files.every((f) => f.action === "skipped")).toBe(true);
  });

  it("--upgrade and --managed honour dry-run too", async () => {
    await put(".axiom/gate-profile.json", { deny: [] });
    const before = await readFile(join(repo.root, ".axiom/gate-profile.json"), "utf8");
    const up1 = await runInit({
      root: repo.root,
      profileName: "demo",
      upgrade: true,
      dryRun: true,
      locateBin: NEW_BIN,
      daemonRunning: async () => false,
    });
    expect(actionOf(up1, ".axiom/gate-profile.json")).toBe("updated");
    expect(up1.diff).toContain('+  "steer": "hint"');
    expect(await readFile(join(repo.root, ".axiom/gate-profile.json"), "utf8")).toBe(before);
    const out = join(outside.root, "policy");
    const m = await runInit({ root: repo.root, managed: { out }, dryRun: true });
    expect(m.files.map((f) => f.action)).toEqual(Object.values(MANAGED_FILES).map(() => "created"));
    expect(m.diff).toContain(`+++ b/${MANAGED_FILES.codex}`);
    expect(await readdir(outside.root)).toEqual([]);
  });
});

describe("docs snippets are generated by init (<!-- init:… --> markers)", () => {
  const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs");
  const expected: Record<string, unknown> = {
    claude: { hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY], PostToolUse: [CLAUDE_POST_HOOK_ENTRY] } },
    copilot: COPILOT_HOOK,
    codex: { hooks: { PreToolUse: [codexHookEntry()], PostToolUse: [codexPostHookEntry()] } },
    cursor: cursorHooks(),
    windsurf: windsurfHooks(),
    gemini: { hooks: { BeforeTool: [geminiHookEntry()] } },
    kiro: kiroHooks(),
    junie: junieUserHooks(),
  };

  /** Every `<!-- init:name -->` followed by a fenced json block, parsed. */
  function snippets(md: string): [string, unknown][] {
    const out: [string, unknown][] = [];
    const re = /<!-- init:([a-z]+) -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/g;
    for (const m of md.matchAll(re)) out.push([m[1] ?? "", JSON.parse(m[2] ?? "")]);
    return out;
  }

  it("harnesses.md and hooks.md carry every marked snippet exactly as init writes it", async () => {
    const seen = new Set<string>();
    for (const file of ["integration/harnesses.md", "getting-started/hooks.md"]) {
      const md = await readFile(join(DOCS, file), "utf8");
      const found = snippets(md);
      expect(found.length, file).toBeGreaterThan(0);
      // A marker whose block did not parse as fenced json would be silently skipped.
      expect((md.match(/<!-- init:[a-z]+ -->/g) ?? []).length, file).toBe(found.length);
      for (const [name, doc] of found) {
        expect(Object.keys(expected), `${file}: unknown marker init:${name}`).toContain(name);
        expect(doc, `${file} init:${name}`).toEqual(expected[name]);
        seen.add(name);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(expected).sort());
  });
});
