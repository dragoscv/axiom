---
"@codai/axiom-mcp": major
---

Harness wiring for 3.0: `axiom init --harness kiro` (`.kiro/hooks/axiom-gate.json`, PreToolUse
`write|shell|@mcp`, `--format kiro`) and `--harness opencode` (`.opencode/plugins/axiom-gate.js`,
fail-closed `tool.execute.before` plugin), both picked by `--harness auto`; `axiom init --dry-run`
(I-19) prints the unified diff of every write and writes nothing; the ACP adapter
(`acpPermissionDecision`, `runAcpProxy`) for Agent Client Protocol clients. Hook commands that run
through `powershell -Command` / `bash -c` on exit-2-only harnesses (VS Code Local, Windsurf/Devin)
now map a crash or missing node to exit 2; Codex `commandWindows` is the bare `axiom.cmd gate …`;
Windsurf/Devin also gate `pre_mcp_tool_use`; the Junie user-level snippet pins `--root`.
