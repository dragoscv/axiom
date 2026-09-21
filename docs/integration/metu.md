# metu ← AXIOM integration (S-306)

*A profile built from `repo.requireCompanion` rules transcribed from metu's own skills, plus gate profile, MCP server and Copilot hook — with the proof runs.*

**Status 2026-09-18:** wired and proven end-to-end in dry-run; files staged in
`E:\gh\metu` (not committed — owner commits). Sibling of
[brivio.md](brivio.md); the difference is that metu has no guard runner, so the
profile leans entirely on `repo.requireCompanion` rules transcribed from the
repo's own skills.

## What was added to metu

| File | Purpose |
|---|---|
| `.github/skills/axiom-plan-apply/SKILL.md` | The loop Plan → `axiom_plan_compile` → `axiom_check` (profile `metu`) → `axiom_apply_dry_run` → `axiom_apply {confirmDigest}`; table of every `metu.ripple` rule and the skill it came from; worked add-app-page Plan (JSON + `.axm`); what to do on `fail` / `rolled-back` / `ERR_PRECONDITION` / `ERR_LOCKED`; rule "never raw multi-file writes when AXIOM is available". |
| `.github/skills/{add-app-page,add-agent-tool,add-db-migration,add-inngest-function,add-integration,add-sdk-endpoint}/SKILL.md` | 5–7 line "Land it through AXIOM" footer appended to each, pointing at axiom-plan-apply and naming the `repo.requireCompanion` rule that enforces that skill's ripple. |
| `.axiom/profiles/metu.json` | Profile `metu` extends `default`, `facts.allowRepo: true`, `allowGuards: false`. Checks: `repo.noOverwriteOf` (`.git/**`, `.axiom/**`, `.github/**`, `pnpm-lock.yaml`, `**/*.lock`, `**/drizzle/meta/**`, `.env*`, `**/.env*`), `content.noSecrets`, `path.deny` (`node_modules`, `.next`, `dist`, `.turbo`), `metu.ripple` = 8 `repo.requireCompanion` rules (below). |
| `.axiom/gate-profile.json` | PreToolUse gate: deny `.git/**`, `.axiom/**`, `.github/**`, lockfiles, `.env*` at any depth, `node_modules`, `.next`, `dist`, `drizzle/**/meta/**`; `noSecrets`; `maxBytes` 262144. |
| `.vscode/mcp.json` | Server `axiom`: stdio `node E:/gh/axiom/packages/mcp/dist/cli.js mcp --root ${workspaceFolder}` (→ `npx -y @codai/axiom-mcp` after the npm publish). `.vscode/` had no `mcp.json` before; `settings/launch/tasks/extensions` untouched. |
| `.github/hooks/axiom-gate.json` | Copilot CLI PreToolUse hook → `axiom gate --stdin` via the global bin (5 s timeout; p50 157 ms). Same shape as brivio's; the gate resolves `<cwd>/.axiom/gate-profile.json` itself. |
| `.gitignore` | `.axiom/*` runtime state ignored, `!.axiom/profiles/` + `!.axiom/gate-profile.json` tracked; `!.vscode/mcp.json` added (the file had `.vscode/*` ignoring everything not allow-listed). |

## `metu.ripple` — the skills' checklists as rules

| `when` | `expect` | from skill |
|---|---|---|
| `apps/web/src/app/\(app\)/**/page.tsx` | `…/**/__tests__/*.test.tsx` · `apps/web/src/lib/i18n/messages/*.json` · `apps/web/e2e/**/*.spec.ts` | add-app-page |
| `apps/web/src/app/actions/*.ts` | `apps/web/src/lib/__tests__/*.test.ts` | add-app-page §5 |
| `packages/db/src/schema/*.ts` | `packages/db/drizzle/*.sql` · `packages/db/drizzle/meta/_journal.json` | add-db-migration |
| `packages/core/src/agent/tools.ts` | `packages/core/src/agent/__tests__/*.test.ts` | add-agent-tool |
| `apps/web/src/app/api/sdk/v1/**/route.ts` | `…/**/__tests__/*.test.ts` · `packages/protocol/src/*.ts` · `packages/sdk/src/*.ts` | add-sdk-endpoint |
| `apps/web/src/inngest/functions/*.ts` | `…/functions/__tests__/*.test.ts` · `apps/web/src/app/api/inngest/route.ts` · `apps/web/src/inngest/client.ts` | add-inngest-function |
| `packages/db/src/schema/integrations.ts` | `packages/types/src/index.ts` · `packages/db/src/queries/integrations.ts` · `docs/integrations.md` | add-integration |
| `apps/web/src/app/api/webhooks/**/route.ts` | `apps/web/src/proxy.ts` | add-integration §6 |

The `(app)` route group was written as `\(app\)` because picomatch treats bare
parentheses as an extglob group; since 2.2.0 (S-408) the matcher escapes plain
route groups itself, so `app/(app)/**` works as written and the manual escape
remains valid. Existing repo files satisfy an `expect` (design: "at least one
artifact **or** one existing repo file"), so rules whose companions are stable
singletons (`client.ts`, `proxy.ts`, `_journal.json`) effectively only fire on a
fresh clone; the per-feature test globs are what bite in practice. For
schema → migration style rules set `mustChange: true` on the `expect` (2.2.0) so
the companion has to be in the plan.

## End-to-end proof (VERIFIED 2026-09-18, metu tree untouched — dry-run only)

Script: `E:\gh\axiom\.copilot-tmp\metu-e2e.ps1`; plans
`.copilot-tmp/metu-plan.json` (9 artifacts: page, toolbar, list, lib helper,
`__tests__/page.test.tsx`, `e2e/axiom-smoke.spec.ts`, `en.json` + `ro.json`
overwrite, `nav-config.ts` overwrite) and `metu-plan-negative.json` (same minus
test, e2e and both message files). Output verbatim, whitespace collapsed:

```
=== 1. compile metu-plan.json
node cli.js compile metu-plan.json -o metu-bundle.json --root E:\gh\metu
{ "manifestDigest": "sha256:04893270fd3b0a921e9f21b239f2d25f6897939bada7c6e2f4a96d6b7e8b98f6",
  "artifacts": 9 }
--- exit=0 elapsed=0.4s

=== 2. check --root E:\gh\metu --profile metu --json
{ "kind": "CheckReport", "profile": "metu", "verdict": "pass", "findings": [],
  "providers": [ manifest ok, content ok, repo ok 8ms, guard skipped ], "durationMs": 34 }
--- exit=0 elapsed=0.3s

=== 3. apply --dry-run --profile metu
{ "kind": "ApplyResult", "mode": "dry-run", "status": "applied", "root": "E:\\gh\\metu",
  "files": [
    apps/web/e2e/axiom-smoke.spec.ts                                  create written
    apps/web/src/app/(app)/axiom-smoke/__tests__/page.test.tsx        create written
    apps/web/src/app/(app)/axiom-smoke/page.tsx                       create written
    apps/web/src/components/axiom-smoke/axiom-smoke-list.tsx          create written
    apps/web/src/components/axiom-smoke/axiom-smoke-toolbar.tsx       create written
    apps/web/src/components/sidebar/nav-config.ts                     overwrite written
    apps/web/src/lib/axiom-smoke.ts                                   create written
    apps/web/src/lib/i18n/messages/en.json                            overwrite written
    apps/web/src/lib/i18n/messages/ro.json                            overwrite written ],
  "diff": "--- /dev/null\n+++ b/apps/web/e2e/axiom-smoke.spec.ts ..." }
--- exit=0 elapsed=0.5s

=== 4. NEGATIVE compile (page without companions)
{ "manifestDigest": "sha256:5d88bbdaf539ef09a76b480a7bbfd2b311ac77a10cc2c056f06d1b7c8bf2b894",
  "artifacts": 5 }
--- exit=0

=== 5. NEGATIVE check (expect repo.requireCompanion fail)
{ "verdict": "fail", "findings": [ {
    "id": "repo.requireCompanion.page-test", "severity": "error",
    "predicate": "repo.requireCompanion",
    "message": "\"apps/web/src/app/\\(app\\)/**/page.tsx\" changed but no companion matches
                \"apps/web/src/app/\\(app\\)/**/__tests__/*.test.tsx\" (page-test)",
    "facts": { "name": "page-test", "triggers": [ "apps/web/src/app/(app)/axiom-smoke/page.tsx" ] } } ] }
--- exit=1 elapsed=1s

=== 6. GATE: Copilot create_file → E:\gh\metu\.env  (expect exit 2)
echo '{"cwd":"E:\\gh\\metu","toolName":"create_file","toolArgs":"{\"filePath\":\"E:\\\\gh\\\\metu\\\\.env\",\"content\":\"X=1\"}"}'
  | node cli.js gate --stdin --root E:\gh\metu --profile E:\gh\metu\.axiom\gate-profile.json
stdout: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
         "permissionDecisionReason":"AXIOM GATE DENY path.deny: path matches a denied glob (.env)"}}
stderr: AXIOM GATE DENY path.deny: path matches a denied glob (.env)
--- exit=2 elapsed=0.3s

=== metu tree after dry-run
git -C E:\gh\metu status --short -- apps/web/src/app apps/web/src/components .env   → (empty)
```

Only `page-test` fires in step 5 because `apps/web/e2e/smoke.spec.ts` and
`apps/web/src/lib/i18n/messages/{en,ro}.json` already exist in the repo and
satisfy `e2e-spec` / `i18n-messages`. A new page still cannot land without its
own colocated test.

**A real finding surfaced on the first run of step 2:** the test fixture used
`workspaceId: '00000000-0000-0000-0000-000000000000'` and `content.noSecrets`
flagged it as `content.noSecrets.card` (a 16+-digit run looks like a PAN), so
check → `fail` and apply → `status: "failed", error.code: "ERR_CHECKS_FAILED"`
with nothing written. Changing the fixture to `'ws_fresh_test'` made it pass.
**Fixed in 2.2.0 (S-408):** `card` now requires a Luhn-valid, non-repeated digit
run outside any UUID, so the zero-UUID fixture passes as-is.

## Next (owner)

1. Review + commit the staged metu files (explicit paths; shared clone).
2. After `@codai/axiom-mcp@2.0.0` is on npm, switch `.vscode/mcp.json` and
  `.github/hooks/axiom-gate.json` to `npx -y @codai/axiom-mcp …`.

---

**See also**

- [Checks](../guides/checks.md#reporequirecompanion) — `repo.requireCompanion` and `mustChange`
- [brivio](brivio.md) — the sibling integration with a guard runner
- [Hooks](../getting-started/hooks.md) — the gate profile schema
- [Harnesses](harnesses.md) — the `mcp.json` and hook file shapes
