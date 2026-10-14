---
"@codai/axiom-mcp": minor
---

`axiom stats` (S-1211): allow/deny/ask counts, deny codes, shadow diffs and gate p50/p95 from
`.axiom/decisions.jsonl`, broken down per harness, tool and post-tool phase, plus harness-log
alarms — `gate.silent` (hooks fire for the workspace in VS Code but the axiom gate is not among
them), `gate.nonBlocking`, `gate.slow` and `decisions.empty`. Reads the VS Code hook log and, new,
the Copilot CLI `~/.copilot/session-state/*/events.jsonl` hook events (`parseCopilotCliHookRuns`,
`findCopilotCliEventLogs`); `hooklog` now exports `GATE_SILENT_MIN_RUNS` and `samePathLoose`.
