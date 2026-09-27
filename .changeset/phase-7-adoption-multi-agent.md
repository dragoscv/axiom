---
"@codai/axiom-schema": minor
"@codai/axiom-apply": minor
"@codai/axiom-checks": minor
"@codai/axiom-plan": minor
"@codai/axiom-mcp": minor
---

Phase 7 — adoption and the multi-agent promise (D-34, S-701..S-709).

- **`axiom init` / `axiom doctor`** (mcp): one command writes `.vscode/mcp.json` (merged), the PreToolUse hook for the detected harness (Copilot/VS Code file, Claude settings merge, Codex note), a repo profile extending `default`, the gate profile and the `.gitignore` rules — idempotent (`created|merged|updated|skipped`, `--force`). `doctor` checks the global bin, hook wiring (an `npx` hook is a warning), gate p95 against the 5 s harness timeout, lock/journal/chain health, profiles and `.gitignore`; exit 2 on any failure.
- **Multi-agent roots** (apply): overlapping in-flight manifests fail early with the new `ERR_CONFLICT` (`details.otherDigest`, `details.paths`) instead of a late rollback; the root lock is a fair FIFO queue; `lockTimeoutMs` / `--lock-timeout`; `lockStatus()` + MCP resource `axiom://lock`; `ApplyResult.error.details` (schema) carries machine-readable context.
- **PR mode in an isolated worktree** (apply): `.axiom/wt/<hex12>` on a new branch from HEAD; the shared working tree's HEAD, index and files are never touched.
- **Tamper-evident journal** (apply): `.axiom/journal/chain.jsonl` hash chain, `verifyChain` / `readHistory` / `journalStatus`; CLI `axiom status`, `axiom log`, `axiom verify --journal` (new code `ERR_JOURNAL_CHAIN`); MCP tool `axiom_status` (18 tools).
- **Keyless signing** (checks, schema, mcp): `axiom sign --keyless [--bound]` via Sigstore (optional lazy `sigstore` dependency) into `bundle.keylessSignatures`; `manifest.requireSigned.keyless { issuer, subjectRegex, offline }` demands "signed by this CI identity"; fail-closed; new code `ERR_KEYLESS_UNAVAILABLE`.
- **YAML Plans** (plan, mcp): `compile plan.yaml` (single document, core schema, alias cap, `$schema` key stripped) — same manifest digest as the JSON twin.
- **Backups**: `keepBackups` / `--keep-backups`, pruned by journal sequence instead of mtime.
