---
"@codai/axiom-mcp": patch
---

`axiom gate --stdin` now actually blocks in VS Code on Windows, stops denying agents that work in sibling worktrees, and answers read-only tools faster (D-35).

- **A deny exits `0` with the JSON document** (`hookSpecificOutput.permissionDecision: "deny"` + flat `permissionDecision`). Previously it exited `2`; the npm `axiom.ps1` shim rewrote that to `1`, and VS Code treats `1` as a non-blocking warning — 129 of 134 production denies in one week let the tool run. Every JSON-aware harness (VS Code, Claude Code, Copilot CLI, Codex, Gemini CLI, Junie) honours the document on exit `0`. `--deny-exit 2` restores the exit-code deny for harnesses that read only the exit code (Windsurf). Usage errors still exit `2`. `axiom doctor` now detects a denied probe from the JSON as well.
- **Worktree-aware containment**: a write into another worktree of the same repository (same git common dir, verified through the worktree's `gitdir` back-link — read from disk, no `git` spawn) is judged against that worktree's root and gate profile instead of `ERR_CONTAINMENT`. Worktrees of other repositories and forged `.git` files still deny.
- **Fast path**: read-only tool calls are answered by a zero-dependency module before the gate chunk loads (Windows p50 207 → 141 ms, ≈ node's own start).
