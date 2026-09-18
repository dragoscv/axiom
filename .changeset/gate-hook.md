---
"@codai/axiom-mcp": minor
---

New `axiom gate --stdin [--root <dir>] [--profile <file>] [--strict] [--log-level …]` — PreToolUse hook
mode (S-203, v2-architecture §5.6). Reads one Claude Code (`tool_name`/`tool_input`/`cwd`) or Copilot CLI
(`toolName`/`toolArgs` JSON string/`cwd`) payload, extracts the write target(s) of
`Write|Edit|MultiEdit|NotebookEdit|create_file|replace_string_in_file|insert_edit_into_file|apply_patch|multi_replace_string_in_file|edit_notebook_file|write|edit`
and runs only the fast rules: realpath containment + `RelPath` validation (`..`, `CON`, NTFS ADS →
`ERR_CONTAINMENT`/`ERR_PATH_*`), `path.deny`, `path.allow`, `content.noSecrets` and `content.maxBytes`
(real `@codai/axiom-checks` predicates over a synthetic single-artifact context) from
`--profile` → `<root>/.axiom/gate-profile.json` → `~/.axiom/gate-profile.json` → built-in default.
Allow = exit 0, silent. Deny = exit 2, `AXIOM GATE DENY <code>: <reason> (<relpath>)` on stderr and the
Claude `hookSpecificOutput` deny JSON on stdout. Malformed payload / 2 s stdin timeout / internal error
fail **open** (exit 0 + warn) unless `--strict`. Ships as its own lazy chunk (`dist/gate-lazy.js`, no MCP
SDK) reached directly from `cli.js`; in-process p95 ≈ 5 ms, end-to-end ≈ 150–200 ms. New guard
`check-gate-latency` (p95 ≤ 250 ms). Wiring for Copilot CLI, VS Code and Claude Code in `docs/hooks.md`.
