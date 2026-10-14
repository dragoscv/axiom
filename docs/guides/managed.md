# Managed policy — `axiom init --managed --out <dir>`

*Write the enterprise/managed hook layers that a user or project cannot switch off: Claude Code managed settings, the Codex `requirements.toml`, Cursor's system hooks file, a Copilot policy hook and the VS Code organisation policies.*

`axiom init --managed --out <dir>` (2.6.0, S-1207) writes the files into `<dir>`. It never
writes to system paths: installing them is your MDM / endpoint tooling's job. Each file carries
the AXIOM gate entries with the harness's fail-closed setting where the harness has one. The
result lists every file as `created` (or `skipped`: up to date / exists without `--force`), and the
notes say where each file must be installed. Every managed hook calls the **global** `axiom` bin,
so run `npm install -g @codai/axiom-mcp` on each machine (never `npx` in a hook — see
[hooks.md](../getting-started/hooks.md#wiring)).

| File in `<dir>` | Install as | Source |
|---|---|---|
| `claude-code/managed-settings.json` | `managed-settings.json` in `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows; the legacy `C:\ProgramData\ClaudeCode\` is no longer read) | [Claude Code managed settings](https://code.claude.com/docs/en/managed-settings) |
| `codex/requirements.toml` | `/etc/codex/requirements.toml` (Linux, macOS) or `%ProgramData%\OpenAI\Codex\requirements.toml` (Windows) | [Codex managed configuration](https://developers.openai.com/codex/enterprise/managed-configuration) |
| `cursor/hooks.json` | `/Library/Application Support/Cursor/hooks.json` (macOS), `/etc/cursor/hooks.json` (Linux/WSL), `C:\ProgramData\Cursor\hooks.json` (Windows) | [Cursor hooks](https://cursor.com/docs/agent/hooks) |
| `github-copilot/policy.d/axiom-gate.json` | `/etc/github-copilot/policy.d/` (POSIX; root-owned, not group/world-writable) or `C:\ProgramData\GitHub\Copilot\policy.d\` (Windows) | [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) |
| `vscode/POLICY.md` | read it and set the policies through Group Policy / configuration profiles | [VS Code AI settings policies](https://code.visualstudio.com/docs/enterprise/manage-ai-settings) |

## What each file enforces

**Claude Code** — `allowManagedHooksOnly: true` (user, project and plugin hooks are skipped, so
no one can shadow the gate), `hooks.PreToolUse` = the gate with `onFailure: "block"` (a gate that
times out, cannot start, exits other than 0/2 or prints invalid output blocks the tool) and
`hooks.PostToolUse` = the post-write check. `disableAllHooks` is deliberately absent: it would
switch the gate off too, and only managed settings can disable managed hooks.

**Codex** — `[features] hooks = true` (enforced even when a user turned hooks off),
`allow_managed_hooks_only = true`, `allowed_approval_policies = ["untrusted", "on-request"]` (no
`never`), and `[[hooks.PreToolUse]]` / `[[hooks.PostToolUse]]` running `axiom gate --stdin
--format codex` (`command_windows` propagates the exit code). Codex requires a managed hook
directory (`managed_dir` / `windows_managed_dir`); AXIOM needs no scripts there, so point it at
whatever directory your tooling manages. Codex documents **no fail-closed option**: a gate that
times out or crashes is reported as a hook failure and the tool continues. Keep the gate fast.

**Cursor** — the same `preToolUse` (`Write|Delete|Shell`) and `beforeShellExecution` entries as
the project file, `failClosed: true` on both.

**Copilot policy hook** — the same document as `.github/hooks/axiom-gate.json`. Policy hooks
cannot be disabled by `disableAllHooks` and run on the host. Copilot applies them to the CLI / SDK
harness, **not** to VS Code Local sessions, and a command-hook timeout is always fail-open, even
for policy hooks.

**VS Code** — `vscode/POLICY.md` names the organisation policies that matter:

| Policy | Value | Why |
|---|---|---|
| `ChatHooks` (`chat.useHooks`) | `true` | agent hooks stay on |
| `ChatToolsAutoApprove` (`chat.tools.global.autoApprove`) | `false` | no global auto-approval |
| `ChatToolsTerminalEnableAutoApprove` | `false` | terminal commands keep their confirmation |
| `ChatAllowManagedHooksOnly` | `true` only with a managed AXIOM hook | otherwise it also disables the repo's `.github/hooks/axiom-gate.json` |

VS Code Local hooks have no fail-closed switch (timeouts, crashes and exit codes other than 0/2 are
non-blocking warnings). The fail-closed audit per harness is in
[hooks.md § Fail-closed audit](../getting-started/hooks.md#fail-closed-audit--what-each-harness-does-when-the-hook-fails-s-1203-verified-2026-10-14).

---

**See also**

- [Hooks](../getting-started/hooks.md) — the gate contract and the per-harness failure table
- [Harnesses](../integration/harnesses.md) — project-level wiring per harness
