---
"@codai/axiom-mcp": minor
---

Gate v2 (S-404, D-18) — `axiom gate --stdin`:

- **Fail-closed by default.** Malformed payload, empty/oversized/timed-out stdin,
  unreadable profile or any internal error now **deny** (`ERR_INTERNAL`, exit 2)
  with a reason. `--fail-open` restores the 2.1 behaviour; `--strict` is
  accepted and ignored.
- **Unknown write → deny.** A write-class tool whose target cannot be determined
  (no recognised path key / V4A body) is denied `ERR_UNSUPPORTED_OP` instead of
  silently allowed.
- **Shell scan.** `Bash`, `run_in_terminal`, `execute_command`, PowerShell and
  friends are scanned for write primitives (`>`, `>>`, `tee`, `rm`, `mv`, `cp`,
  `sed -i`, `dd of=`, `git checkout|restore|reset|rm|mv|stash|clean`,
  `Set-Content`/`Remove-Item`/…); their operands go through the same
  containment + profile checks. Documented heuristic; `--no-shell-scan` opts out.
- **Root discovery.** The payload `cwd` is walked up to the nearest `.git` or
  repository `.axiom/` (never the home directory), so a sub-directory cwd still
  sees `.git/**` and `.env` in the profile and loads the repo's gate profile.
  Relative targets stay relative to `cwd`. `--no-root-discovery` opts out.
- **One deny document** on stdout: Claude `hookSpecificOutput`, Copilot flat
  `permissionDecision`/`permissionDecisionReason`, and `axiom.verdict` in the
  OWASP Agent Control Standard v0.1 vocabulary (`allow|deny|modify|ask|defer`)
  plus `code`, `path`, `toolClass`.
- `GateResult` gains `verdict`, `toolClass`, `root`; `extractTargets` now returns
  `{ cls, targets, undetermined }`.
- Measured e2e p50 89 ms / p95 104 ms (15 spawns, Windows, Node 26); gate chunk
  283 KB, still SDK-free.
