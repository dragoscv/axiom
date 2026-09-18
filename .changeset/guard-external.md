---
"@codai/axiom-checks": minor
"@codai/axiom-mcp": minor
---

`guard.external` is now a real predicate (S-202, v2-architecture §3.2). It spawns a repository-owned
guard — a relative `command` that must realpath inside `<root>/scripts/` (`.mjs/.js/.cjs` via the
current `node`, `.ps1` via `pwsh -NoProfile -ExecutionPolicy Bypass -File`) or an absolute executable
that exactly matches an entry of the new `guardAllowlist` — with an args array (never a shell),
`windowsHide`, a scrubbed whitelist environment plus `params.env`, `AXIOM_MANIFEST_DIGEST` and
`AXIOM_ROOT`, the JCS bundle/manifest on stdin, and a wall-clock timeout that kills the process tree
(`ERR_GUARD_TIMEOUT`). stdout must be a `GuardOutput` JSON object `{ ok, findings? }`; non-JSON stdout
on any exit code fails closed with `ERR_GUARD_OUTPUT` (stderr tail 4 KiB in facts). brivio-style
`OK`/`FAIL` text is accepted only with `legacyText: true`. Guards run only when the profile sets
`facts.allowGuards` **and** `runChecks` receives `allowGuards: true`; otherwise a single `error`
finding ("external guards disabled"). `runChecks` executes guard checks in a pool of
`min(4, os.cpus().length)` and reports the `guard` provider as `ok|skipped|error`.

`@codai/axiom-mcp`: `axiom mcp|check|apply` accept `--allow-guards` and repeatable
`--guard-allowlist <abs>`, threaded into every `runChecks` call (`createServer(policy, { guards })`).
Docs: `docs/checks.md` (contract table), `docs/integration/brivio.md` (adapter for `run-guards.mjs`).
