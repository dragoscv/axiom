/**
 * HARD self-protection globs, denied by the built-in `default` check profile whenever a gate
 * profile is absent (4.0, D-49 / S-1410, finding A1-29): without them a plan could create
 * `.git/hooks/pre-commit` or rewrite the harness hook wiring, because `repo.noOverwriteOf`
 * skips `create` and `.github/**` was not a default deny.
 *
 * The list is a COPY of `SELF_PROTECT_GLOBS` in `packages/mcp/src/self-protect.ts`: `checks`
 * may not import `mcp` (package boundary), so the integrator adds a test asserting the two
 * lists are equal. A change to the `mcp` list must be mirrored here in the same commit.
 */
export const SELF_PROTECT_HARD_GLOBS: readonly string[] = [
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
