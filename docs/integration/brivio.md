# brivio ← AXIOM integration (S-306)

**Status 2026-09-18:** wired and proven end-to-end in dry-run; files staged in
`E:\gh\brivio` (not committed — owner commits). ADR: `brivio/docs/adr/0200-axiom-write-gate.md`.

## What was added to brivio

| File | Purpose |
|---|---|
| `scripts/axiom-guard-adapter.mjs` | `guard.external` adapter: reads the bundle from stdin, runs `scripts/run-guards.mjs --quiet <names>` (spawn, args array, no shell), maps `FAILED <guard>` headers / `FAIL` lines to AXIOM findings `brivio.<guard>`, prints `{ok, findings}`; always exit 0, 55 s internal cap. |
| `.axiom/profiles/brivio.json` | Profile `brivio` extends `default`: `repo.noOverwriteOf` (`.github/**`, lockfiles, `drizzle/**/meta/**`), `repo.requireCompanion` transcribed from `.copilot-ripple.json` (gateway route → mcp tools + CLI + TS/PHP SDK + OpenAPI; openapi.ts → JSON; actions → test; db schema → migration), `content.noSecrets`, `guard.external` running the 7 change-set-relevant guards (see below). |
| `.axiom/gate-profile.json` | PreToolUse gate: deny `.git/**`, `.axiom/**`, lockfiles, `.env*`, `node_modules`, `drizzle/**/meta/**`; `noSecrets`. |
| `.github/hooks/axiom-gate.json` | Copilot CLI hook registration → `node E:/gh/axiom/packages/mcp/dist/cli.js gate --stdin` (becomes `npx -y @codai/axiom-mcp gate --stdin` after the npm publish). |
| `.gitignore` | `.axiom/*` runtime state ignored; `profiles/` and `gate-profile.json` tracked. |

## Why only 7 guards in `guard.external`

`guard.external` caps `timeoutMs` at 60 000 and brivio's full suite (~75 guards)
takes well over that on this machine; `check-untracked-imports` alone is 64 s.
Measured per guard (host under load):

| guard | wall |
|---|---|
| org-context | 3.9 s |
| audit-coverage | 1.4 s |
| hardcoded-strings | 1.2 s |
| egress-guard | 8.1 s |
| sdk-coverage | 0.3 s |
| route-boundaries | 0.8 s |
| vacuous-assertions | 9.7 s |
| untracked-imports | **64.1 s** (excluded) |

The full suite still runs in brivio's own pre-commit / CI; AXIOM runs the subset
that speaks to a *change-set* (tenant scoping, audit, i18n, egress, SDK ripple,
route boundaries, test quality).

## End-to-end proof (VERIFIED 2026-09-18, brivio tree untouched — dry-run only)

Commands run from `E:\gh\axiom` with the built CLI (`.copilot-tmp/brivio-e2e.ps1`):

```
1. compile smoke plan (docs/axiom-smoke.md)                  exit 0   0.5 s
2. check --root E:\gh\brivio --profile brivio --allow-guards exit 1   8.8 s
   verdict=fail  providers manifest=ok content=ok repo=ok guard=ok
   - brivio.vacuous-assertions [error] vacuous-assertions: 4 assertion(s)
     that pass with the guarded code deleted
3. apply --dry-run                                           exit 1
   status=failed  message="pre-apply checks: fail"   (nothing written)
4. NEGATIVE compile (overwrite pnpm-lock.yaml)               exit 0
5. NEGATIVE check                                            exit 1
   - repo.noOverwriteOf [error] overwrite of protected existing file (pnpm-lock.yaml)
6. GATE: Copilot create_file → E:\gh\brivio\.env             exit 2
   stderr: AXIOM GATE DENY path.deny: path matches a denied glob (.env)
   stdout: {"hookSpecificOutput":{"hookEventName":"PreToolUse",
            "permissionDecision":"deny", ...}}
```

**Step 2 is a real finding, not an integration bug.** brivio's own
`check-vacuous-assertions.mjs` currently fails on 4 pre-existing assertions:

- `apps/web/src/lib/auth/__tests__/shared-device.test.ts:131`
- `packages/notifications/src/dispatch-upsert-wiring.test.ts:42`, `:43`, `:51`

AXIOM correctly refuses to apply *any* change-set while the repo's own gate is
red — that is the fail-closed behaviour the design asks for. Fix those four
assertions in brivio (or drop `vacuous-assertions` from the profile's `args`
until they are fixed) and step 2/3 go green; the guard runner and the other
six guards all returned `ok`.

## Next (owner)

1. Review + commit the staged brivio files (explicit paths; shared clone).
2. Fix the 4 vacuous assertions, re-run step 2.
3. After `@codai/axiom-mcp@2.0.0` is on npm, switch `.github/hooks/axiom-gate.json`
   to `npx -y @codai/axiom-mcp gate --stdin` and add `.vscode/mcp.json` server `axiom`.
