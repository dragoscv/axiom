# AXIOM integration research — report

*Dated record (2026-09-18) — see [Design & research](../README.md#design--research).*

Note on method: no terminal tool is available in this mode, so `rg` could not be run across the sibling repos; findings below come from directory listings and targeted file reads (VERIFIED where stated). Items requiring a true text sweep (3, 5) are marked as partial.

## 1. MCP configuration / consumption per repo

| Repo | MCP config file | Servers declared | MCP packages (server side) |
|---|---|---|---|
| **brivio** | `E:\gh\brivio\.vscode\mcp.json` (VERIFIED) | `postgres-local` (stdio, `@modelcontextprotocol/server-postgres` → dev DB on `dragos:22432`), `sentry` (http, `https://mcp.sentry.dev/mcp`) | `apps/mcp` = `@brivio/mcp` v0.3.0 — uses `@modelcontextprotocol/sdk` (catalog), Hono http transport, OTel. 4 meta-tools over the gateway OpenAPI (`brivio_api_search/details/read/write`) + curated tools; **writes disabled by default** (`BRIVIO_MCP_DISABLE_WRITE`). README: `E:\gh\brivio\apps\mcp\README.md` |
| **metu** | none (`.vscode/` has extensions/launch/settings/tasks only) | none | `apps/mcp-server` = `@metu/mcp-server` 0.0.1, `@modelcontextprotocol/sdk` (catalog), depends on `@metu/core` (Conductor tools), `@metu/db`, `@metu/auth` |
| **mmo** | none (`.vscode/settings.json`, `tasks.json` only) | none | `packages/ai-mcp` = `@mmo/ai-mcp` — stdio / HTTP+SSE / WS transports, PAT scopes (`daw:read`, `generate:audio`…); README says "Scaffolded in P0" |
| **codai** | none (`.vscode/`: extensions, settings, tasks — settings.json has no `mcp` key) | none | No `*mcp*` package; but `apps/desktop/mcp/` exists (`codai-phone-mcp.mjs` per `packages/agent-core/spec/tools.json` description — a phone-control MCP shim) |
| **money** | none | none | none |
| **vmui** | none (no `.github/` dir at all) | none | none |

User-level MCP config: `C:\Users\vladu\.copilot\mcp-config.json` declares `tavily`, `sentry`, `context7`, `microsoft-learn`, `chrome-devtools`, `phone-chrome` (+ more past line 60). **This is the most plausible place to register AXIOM as a local stdio server** (`"type":"local","command":"npx","args":["-y","@codai/axiom-mcp"]`). Note: that file contains live secrets inline (Tavily, Sentry tokens) — not reproduced here.

Repo-level instruction files that mention MCP: `E:\gh\brivio\.copilot-ripple.json` explicitly names `apps/mcp/src/tools.ts` (68 hand-written tools) as a surface that must be mirrored manually — a documented, unmet automation gap.

## 2. codai — tools / agents / sandbox concepts

VERIFIED from listings + reads:

- **`apps/sandbox`** (`@codai/sandbox`, Hono): "Frontier v3 B4 — the containment leg". A Cloud Run service with zero secrets/IAM that runs UNTRUSTED code: `POST /exec { language: 'python'|'shell', code, timeoutSeconds }`, auth via `x-sandbox-token`. It is an *execution* sandbox, not a plugin/tool host — AXIOM does not fit *inside* it, but AXIOM's `apply` step could target a sandbox workspace. Files: `E:\gh\codai\apps\sandbox\src\server.ts`, `package.json`.
- **`packages/agent-core`** — shared agent-loop contract: `spec/agent-core.json`, `spec/tools.json`, `spec/tools-v2.json`, `spec/capabilities.json`. Defines `RiskClass` (`READ|ACT|SENSITIVE`), `AutonomyMode` (`strict|assisted|autopilot`), `APPROVAL_MATRIX`, safety prefixes (`NEEDS_APPROVAL:`, `REFUSED:`, `BLOCKED:`, `DRY-RUN:`). **This is the closest thing to a tool registry** (`E:\gh\codai\packages\agent-core\src\index.ts`, `spec/tools.json`). An AXIOM tool set (`axiom.check`, `axiom.apply`) would need a `risk` class here (`apply` = ACT).
- **`packages/policy-engine`** — spend mandates for agent payments (`Mandate`, `Intent`, `Decision = allow|deny|needs_approval`, reason codes `OVER_DAILY_CAP`, `DENYLISTED`…). Money-only; not code policy. `E:\gh\codai\packages\policy-engine\src\types.ts`.
- **`packages/rules-core`** — signed rules manifests: JCS canonicalization, DSSE envelope (`application/vnd.codai.rules+json;v=1`), `floor.ts`, `catalogue.ts`, `glob.ts`. This is the "rules layer" the user's `guard-rules-surface.ps1` hook enforces. AXIOM's policy profiles (`profiles/*.json`) would ideally be expressed/signed the same way.
- **`packages/swe-harness`** — SWE eval harness with `file-tool.ts` (text-protocol `READ:` requests, path-escape rejection), `workspace.ts`, `sandbox-env.ts`, `verdict.ts`, `pipeline.ts`; `apps/swe-exec-runner` executes it. Closest analogue to AXIOM's "apply files to a repo" step.
- **`packages/verify`** — eval verification (task-validity, verifier-score), not file verification.
- Other relevant apps: `apps/desktop` (Tauri, has `mcp/` dir), `apps/mobile-agent`, `apps/phone-android`, `apps/agent-pay`.
- `.github/copilot-instructions.md` lists no MCP/tool-registry convention; `.agents/` is empty.

## 3. Existing codegen / scaffolding

Partial (no rg sweep). VERIFIED by listing:

- **brivio**: `scripts/sdk/generate-sdks.mjs` + `openapi-sync.mjs` (OpenAPI → TS/PHP/Python/Go/Java/.NET SDKs, `packages/sdk-*/generated/`); `scripts/codemods/` (4 jscodeshift-style codemods: `font-size-to-scale`, `pulse-to-skeleton`, `suspense-reveal`, `z-index-to-scale`); `scripts/gen-tenant-tables.ts`; `generate-*.mjs` (icons, OG PNG, inventory, VAPID keys). No plop/hygen/turbo-gen seen.
- **codai**: `packages/agent-core/scripts/` (`gen-*.mjs` generators reading `spec/*.json` per the index.ts comment).
- **metu**: `.github/skills/add-app-page`, `add-db-migration`, `add-agent-tool`, `add-sdk-endpoint`, `add-integration`, `add-inngest-function` — **prompt-driven scaffolding recipes** (SKILL.md), not tooling. This is the direct conceptual overlap with AXIOM's intent DSL → scaffold: metu already encodes "how to add X" as skills for agents to execute by hand.
- money, mmo, vmui: none found in listings.

Verdict: no generic scaffolder exists; AXIOM would not duplicate tooling, but AXIOM's emitters (Next.js 14 pages + React 18, node:http) are off-stack for every repo (Next 16 App Router, Hono 4, Drizzle) — per repo memory `axiom-overview.md`.

## 4. Existing policy / compliance / PII checks

- **brivio `packages/compliance`**: fiscal-only — `bon-fiscal.ts`, `state-machine.ts`, `fiscal-printer/{datecs,tremol}.ts`. Not PII/code policy.
- **brivio `packages/trust`**: `engine/{evidence,health,signature,timestamp,validation}.ts`, `crypto/`, `signers/`, `archive/`, `identity/`, `tenant/` — document trust/e-signature, not code policy.
- **brivio `packages/safe-mode`**, `scripts/safe-mode/scan-real-emails.mjs` — env-gating + a real-PII scan of seed data (closest PII analogue).
- **brivio `scripts/check-*.mjs`** (~75 guards, run via `scripts/run-guards.mjs`, pre-commit + CI): `check-audit-coverage`, `check-org-context`, `check-consent-gating`, `check-ropa`, `check-sub-processors`, `check-hardcoded-strings`, `check-egress-guard`, `check-licenses`, `check-vacuous-assertions`, `check-sdk-coverage`… **This is the repo's real policy layer**; AXIOM's `check()` would duplicate it unless AXIOM calls into these guards or emits results in their format.
- **codai `packages/policy-engine`** — spend caps/mandates (money). `packages/rules-core` — signed rules manifests. Gateway spend caps per user (copilot-instructions). No code-PII scanner.
- **money**: `apps/quant/app/policy.py` — trading acceptance gates, unrelated.
- **metu**: `packages/core/src/agent/` ACL policy via `runTool()` (per `agent-and-conductor.instructions.md`).

Verdict: AXIOM's PII scan has no direct equivalent (only brivio's seed scan); its SLA/budget policies are unrelated to codai's spend policy-engine. Overlap risk is with brivio's `check-*.mjs` guard suite.

## 5. Verified file apply / sha256 / atomic write

Partial (no rg sweep). VERIFIED:

- `E:\gh\codai\apps\sandbox\src\server.ts` — `createHash('sha256')` for constant-time token compare only.
- `E:\gh\codai\packages\rules-core\src\{canon,envelope}.ts` — `canonicalHash` (JCS + sha256) and DSSE signature envelopes for manifests. Closest match to AXIOM's manifest+sha256 verification pattern.
- `E:\gh\codai\packages\swe-harness\src\{file-tool,workspace}.ts` — repo file read/apply for evals (SEARCH/REPLACE text protocol, path-escape rejection).
- brivio: `packages/trust/src/engine/{signature,timestamp}.ts` (document hashes), audit_log hash chain (ADR-0005). No generic atomic-write/apply-patch utility found.
- User-level: `C:\Users\vladu\.copilot\hooks\guard-write.ps1` / `guard-tooluse.ps1` block clobbering whole-file writes — the house "safe apply" gate is a hook, not a library.

## 6. Agent config — house patterns

**`C:\Users\vladu\.copilot\`**
- `agents/`: `brivio-feature.md`, `codai-gateway-ops.md`, `codai-training.md`, `code-reviewer.md`, `db-change.md`, `Deep Build.md`, `Goal.agent.md`, `incident-responder.md`, `plan.md`, `Prompt.md`, `release-manager.md`, `upgrade-migrator.md`
- `instructions/`: `core.instructions.md`
- `skills/`: `codai-byok-ops/`, `gcloud-auth-verification/`, `managing-python-dependencies/`
- `hooks/`: `codai-hooks.json` (registry), gates: `guard-tooluse.ps1`, `guard-rules-surface.ps1`, `guard-command.ps1`, `guard-write.ps1`, `no-permission-stop.ps1`, `nudge-parallel.ps1`, `copilot-signal.ps1`, `session-start.ps1`; utilities: `run-build.ps1`, `who-owns-file.ps1`, `rules-ticket.ps1`, `check-ripple.ps1`, `sync-to-vm.ps1`, `audit-tools.ps1`, `measure-*.ps1`, `test-*.ps1` (one test per gate), `lib/`, `known-tools.txt`, `README.md`.

**`C:\Users\vladu\.claude\`**: `rules/` (41 files listed above, e.g. `agent-behavior.md`, `security.md`, `ripple-completeness.md`), `skills/` (42 dirs, e.g. `code-review`, `debug-detective`, `security-audit`, `skill-creator`).

**Hook/gate house pattern** (from `codai-hooks.json` + headers):
- Registered in `codai-hooks.json`: `{"version":1,"hooks":{"sessionStart":[…],"preToolUse":[…],"Stop":[…]}}`, each `{"type":"command","powershell":"C:/Users/vladu/.copilot/hooks/x.ps1","timeoutSec":N}`. Event casing `preToolUse`/`sessionStart`/`Stop` is load-bearing.
- Script contract: PowerShell `<# .SYNOPSIS / .DESCRIPTION #>` header stating the *measured incident* that motivated it; `$ErrorActionPreference='Stop'`; reads tool payload JSON on stdin; **exit 0 = allow, exit 2 = deny with reason on stderr** (RO+EN, naming a floor rule id like `codai.floor.self-modify-rules`); budget 4–15 s; each gate has a `test-*.ps1` mutation test; `test-config-integrity.ps1` after any change.
- Repo-level equivalents: brivio `.copilot-ripple.json` (overrides for `check-ripple.ps1`: `publicApi` regex, `ignorePaths`) and `scripts/run-guards.mjs` running `check-*.mjs` in pre-commit. An AXIOM repo hook should follow: `check-axiom-*.mjs` guard in `scripts/` + optional `.copilot-*.json` override file.

**Frontmatter formats (VERIFIED):**

Instructions — `E:\gh\brivio\.github\instructions\brivio-conventions.instructions.md`:
```yaml
---
description: Brivio repo conventions every change must follow
applyTo: "**"
---
```
metu variant with scoped globs — `E:\gh\metu\.github\instructions\agent-and-conductor.instructions.md`:
```yaml
---
applyTo: 'packages/core/src/agent/**,packages/core/src/goals/**,packages/ai/**,...'
description: Conductor agent — tools registry, ACL policy, planner, AI SDK v5, BYOK provider mesh.
---
```
Skills — `E:\gh\metu\.github\skills\add-agent-tool\SKILL.md`:
```yaml
---
name: add-agent-tool
description: Register a new tool the Conductor (or any agent) can call — schema, kind, undo, ACL hookup. Use when ...
---
```
(brivio `brivio-wiring-guards/SKILL.md` uses the same `name` + folded `description: >-`.) Agents (`~/.copilot/agents/*.md`) add `tools: [...]` to the frontmatter.

Repos with these dirs: brivio (`instructions/` ×2, `skills/` ×21), metu (`instructions/` ×14, `skills/` ×10), money (`skills/` ×3, no instructions). codai/mmo/vmui: none (codai has only `copilot-instructions.md`; vmui has `AGENTS.md`).
