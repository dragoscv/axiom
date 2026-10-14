---
"@codai/axiom-mcp": minor
---

`axiom init --upgrade` upgrades an existing wiring in place (gate profile `record`/`steer`, `axiom-hook` when a daemon runs, npx → global bin MCP entries, legacy exec hook, missing PostToolUse entries). `axiom init --managed --out <dir>` writes Claude Code managed settings, a Codex `requirements.toml`, Cursor and Copilot policy hooks and a VS Code policy note. Claude, Codex and Copilot get a PostToolUse post-write check (`postMain` in `post-write.ts`, `axiom gate --stdin --post`). `axiom doctor` adds `failopen.<harness>` warnings for harnesses whose hook failure path fails open, plus `hook.post.<harness>`. Fresh gate profiles set `record: true`.
