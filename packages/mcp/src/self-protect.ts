/**
 * Built-in self-protection set (4.0, D-49 / S-1410): the files that decide whether AXIOM runs
 * and what it enforces. Reality check #2: under the default policy an agent could rewrite the
 * policy file, the hook wiring and `~/.axiom/daemon.json` with one allowed write, and warn mode
 * relaxed the deny that covered the policy file.
 *
 * Two tiers, the same in every mode (`enforce`, `warn`, `override`, `shadow`):
 *   - HARD (`self.protect`): files only AXIOM and the human own. Never relaxed, never overridden.
 *   - ASK  (`self.harnessConfig`): harness configuration shared with other tools. The human
 *     confirms (a deny on formats without an ask prompt).
 *
 * Dependency-free on purpose: the gate, `check`/`apply` (policy floor), `init` and `doctor` all
 * read this one list.
 */

/** Rule id of a write to a file only AXIOM and the human own. */
export const SELF_PROTECT_CODE = "self.protect";
/** Rule id of a write to harness configuration shared with other tools. */
export const SELF_ASK_CODE = "self.harnessConfig";
/** Rule id of a recursive delete of the home directory, a filesystem root, the repository root or one of its ancestors, or `.git`. */
export const SELF_TREE_DELETE_CODE = "self.treeDelete";

/**
 * Root-relative globs (picomatch, `dot: true`, case-insensitive), tier HARD. The entries that
 * start with a double-star segment cover a policy planted in a sub-directory, which would
 * otherwise become a root of its own.
 */
export const SELF_PROTECT_GLOBS: readonly string[] = [
  ".axiom/axiom.json",
  ".axiom/gate-profile.json",
  ".axiom/profiles/**",
  ".axiom/trust/**",
  ".axiom/mcp-pins.json",
  "**/.axiom/axiom.json",
  "**/.axiom/gate-profile.json",
  "**/.axiom/profiles/**",
  "**/.axiom/trust/**",
  ".github/hooks/axiom-gate.json",
  ".kiro/hooks/axiom-gate.json",
  ".opencode/plugins/axiom-gate.js",
  ".clinerules/hooks/PreToolUse",
  ".clinerules/hooks/PreToolUse.ps1",
];

/** Root-relative globs — ASK: harness hook / MCP configuration AXIOM is wired into. */
export const SELF_ASK_GLOBS: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  ".vscode/mcp.json",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".gemini/settings.json",
  ".windsurf/hooks.json",
  ".devin/hooks.json",
  ".devin/hooks.v1.json",
  ".junie/mcp/mcp.json",
  ".github/hooks/**",
  ".kiro/hooks/**",
  ".opencode/plugins/**",
  "opencode.json",
  ".clinerules/hooks/**",
];

/** Home-relative POSIX prefixes — HARD (`~/.axiom/**`: daemon state, keys, user policy). */
export const SELF_PROTECT_HOME: readonly string[] = [".axiom"];

/** Home-relative POSIX paths or prefixes — ASK: user-level harness configuration. */
export const SELF_ASK_HOME: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude.json",
  ".copilot/hooks",
  ".copilot/mcp-config.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".gemini/settings.json",
  ".codeium/windsurf/hooks.json",
  ".kiro/hooks",
  ".config/opencode",
];

function norm(p: string, win32: boolean): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return win32 ? s.toLowerCase() : s;
}

/**
 * Tier of an ABSOLUTE path under the home directory, or `undefined` when it is neither.
 * `abs` and `home` may use either separator; comparison is case-insensitive on Windows.
 */
export function selfProtectHomeTier(
  abs: string,
  home: string,
  win32: boolean = process.platform === "win32",
): "hard" | "ask" | undefined {
  const a = norm(abs, win32);
  const h = norm(home, win32);
  if (h === "" || !a.startsWith(`${h}/`)) return undefined;
  const rel = a.slice(h.length + 1);
  const under = (prefix: string): boolean => {
    const p = win32 ? prefix.toLowerCase() : prefix;
    return rel === p || rel.startsWith(`${p}/`);
  };
  if (SELF_PROTECT_HOME.some(under)) return "hard";
  if (SELF_ASK_HOME.some(under)) return "ask";
  return undefined;
}

/** True for a rule id of the built-in set that no mode, override or profile `hard` list can relax. */
export function isSelfHardCode(code: string): boolean {
  return code === SELF_PROTECT_CODE || code === SELF_TREE_DELETE_CODE || code === "self.uninstall";
}
