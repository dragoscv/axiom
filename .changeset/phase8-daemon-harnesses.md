---
"@codai/axiom-mcp": minor
"@codai/axiom-canon": minor
---

Phase 8 (D-36, D-37): a gate cheap enough for every tool call, in every harness.

- `axiom serve --hook --root <abs>…` — resident gate daemon on loopback (Origin/Host refusal, optional bearer token, `~/.axiom/daemon.json`). `axiom gate --stdin` (node and SEA) asks it first and falls back to the in-process gate when it gives no verdict; Claude Code can call it as a `type: "http"` hook with `onFailure: "block"` (no process per call, ~4–5 ms).
- Native thin client `axiom-hook` (Rust, std only) shipped as release assets, in the brew formula and the install scripts; fails closed in the harness's format when neither the daemon nor `axiom` can run.
- `axiom gate --format auto|claude|copilot|vscode|codex|cursor|windsurf|gemini|junie|cline` and payload support for Cursor, Windsurf/Devin, Codex `apply_patch`, Gemini CLI, Junie and Cline. Cursor `Delete` and Gemini/Cline `replace` tools are now write-class (they were allowed unchecked).
- `axiom init` / `axiom doctor` cover all nine harnesses; `init --daemon`; doctor checks the daemon, the global bin against gate-profile keys, and VS Code's Copilot hook log for gate runs that ended `NonBlockingError` (advisory denies).
- Gate profile `steer: off|hint|require` + `steerGlobs` (init writes `hint`) and the new MCP tool `axiom_write` (preview → apply with `confirmDigest`).
- Gate profile `record: true` → `.axiom/decisions.jsonl`; `axiom attest decisions [--sign]` emits in-toto agent-decision v0.1 Statements (`AGENT_DECISION_V0_1`, `argsHash`, `buildAgentDecisionStatement` in `@codai/axiom-canon`).

A gate profile that uses `steer`, `steerGlobs` or `record` requires axiom ≥ 2.5.0 wherever the hook runs (older gates reject unknown keys and deny every write).
