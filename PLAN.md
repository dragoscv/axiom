# AXIOM v2 — Canonical Plan & Tracker

> **Single source of truth** for goals, decisions, stories and status. The machine-readable
> twin is [`TRACKER.csv`](TRACKER.csv). Every other `*SUMMARY*.md`/`*REPORT*.md` in git history
> is superseded and archived under `docs/archive/v1/`.
>
> Status legend: `todo` · `doing` · `done` · `blocked` · `dropped`. Update both files in the same commit.

Last updated: 2026-09-18 · Owner: Dragos Catalin Vladulescu · Author of plan: Copilot (research round 1)

---

## 0. Executive summary

**Diagnosis (VERIFIED 2026-09-18).** v1 (`@codai/axiom-mcp` 1.0.24) builds, but 38/95 tests fail;
three contradictory manifest schemas; `irHash` hashes `{}` for every IR (JSON.stringify replacer
bug); emitters produce one hard-coded notes app (Next 14); `check()` metrics are constants;
PR mode spawns `git` with `shell:true` and user strings; 25 npm releases in 19 h from an
uncommitted tree; ~25 AI-generated "Production-Ready" reports in root that contradict each other.

**What is actually valuable** (confirmed by web research and a red-team pass): nobody in the
2026 agent ecosystem (OpenHands, e2b, Daytona, Spec Kit, Kiro, Tessl, Claude/Copilot hooks)
offers a **transactional, set-level-checked, content-addressed, atomically-applied, recorded
write** for coding agents. Hooks are per-tool-call; AXIOM can be per-*change-set*.

**v2 thesis.** *AXIOM is the transactional write gate for multi-agent repos*: one `Plan` →
canonical `Manifest` (in-toto Statement, sha256 per file) → set-level `checks` → hash-gated,
two-phase, rollback-able `apply` → durable record. Delivered as an MCP stdio server + CLI +
PreToolUse hook + CI verifier. The `.axm` DSL becomes an optional front-end (v2.1), not the core.

---

## 1. Decisions (D-xx) — answers from the owner are recorded here

| ID | Decision | Options | Chosen | Rationale / status |
|----|----------|---------|--------|--------------------|
| D-01 | Product framing | (a) transactional write gate, (b) codai capability only, (c) DSL-first rebuild, (d) archive | **decided (2026-09-18): (a)+(c)** — identity = `.axm` DSL **and** transactional write gate; gate ships in v2.0, DSL is a *committed* v2.1 deliverable (not optional) | Owner: "Rebuild DSL-first + Transactional write gate" |
| D-02 | Keep `.axm` DSL? | kill / defer to v2.1 (Chevrotain + Langium LSP) / keep in v2.0 | **decided: defer to v2.1** | Plan schema stabilises first; grammar compiles 1:1 to Plan |
| D-03 | Check expression language | typed predicate registry (JSON) / CEL via lib / own CEL subset / JSONLogic | **decided: predicates in v2.0, CEL (`@marcbachmann/cel-js`) in v2.2** | Deterministic, offline, testable per predicate |
| D-04 | Signing (DSSE) in v2.0 | yes / defer to v2.2 as optional | **decided: v2.2**, key in CI | Unsigned in-toto Statement is still the record |
| D-05 | Git PR mode in v2.0 | yes / v2.1 | **decided: v2.1** | spawn args-array, `-F -`, no shell |
| D-06 | Toolchain | TS 7 (tsgo) + tsdown + Biome + Vitest 5 + Changesets 3 + fast-check + Stryker (scoped) + pnpm catalog | **decided: yes** | All latest stable, verified 2026-09-18 |
| D-07 | Package scope & names | keep `@codai/axiom-*` | **decided: keep** (implicit) | npm continuity; deprecate 1.x |
| D-08 | Root litter | archive to `docs/archive/v1/` (git mv) | **decided: archive** | Owner: "curata, dar arhiveaza nu sterge" |
| D-09 | Repo hygiene tooling | brivio-style `scripts/check-*.mjs` + `run-guards.mjs` + `.github/instructions` + skills | **decided: yes** | House pattern already proven in brivio/metu |
| D-10 | MCP transport in v2.0 | stdio only / stdio + streamable HTTP | **decided: stdio only; HTTP v2.1** | |
| D-11 | Bundle/perf budgets | bin < 950 KB, cold start p50 < 250 ms, gate p95 < 120 ms | **decided: yes, enforced in CI** | |
| D-12 | Minimum Node | ≥ 22.14 | **decided: yes** (implicit with D-06) | Vitest 5 / tsdown floor |
| D-13 | Template emitters | in core / v2.1 plugin (`emitters-web`, Next 16 / Hono 4) | **decided: v2.1 plugin — delivered (S-207)** | Agents generate content; templates are optional sugar. Registry is an injected interface; `plan` does not depend on `emitters-web` |
| D-14 | LSP implementation | (A) Langium 4.4 `.langium` grammar via `langium-cli` / (B) hand-written `vscode-languageserver` reusing `parseAxm` | **decided (2026-09-18): B** | Langium derives every service from a `.langium` Grammar AST (Context7 `/eclipse-langium/langium`: custom `Lexer`/`TokenBuilder`/`LangiumParser` are overrides *of* a grammar, not a way to skip one) → (A) means a second grammar that can drift from `packages/axm`. `.axm` has 15 keywords, no cross-refs; completion/hover/symbols are ~300 lines by hand. Rationale in `packages/axm-lsp/README.md` |

---

## 2. Architecture (target v2)

```
packages/
  schema/   @codai/axiom-schema   Zod v4 schemas (Plan, Manifest, CheckReport, ApplyResult, Profile, errors enum) + JSON Schema export
  canon/    @codai/axiom-canon    JCS RFC 8785, sha256, in-toto Statement v1 builder, DSSE (v2.2)  — lifted from codai rules-core
  plan/     @codai/axiom-plan     Plan → ManifestBundle compiler; inline blobs / CAS store
  checks/   @codai/axiom-checks   Predicate registry, fact providers (manifest, content, repo), profiles, external guard runner (v2.1)
  apply/    @codai/axiom-apply    Containment (realpath, symlink, reserved names, case collisions), staging, 2-phase commit, journal, rollback, dry-run diff, idempotency, lock
  mcp/      @codai/axiom-mcp      THE published bin: MCP stdio server (8 tools + resources), CLI verbs, `gate --stdin` hook mode (v2.1)
  axm/      @codai/axiom-axm      (v2.1) Chevrotain parser .axm → Plan
  axm-lsp/  @codai/axiom-axm-lsp  (v2.1) Langium LSP + VS Code extension
  testkit/  private               golden fixtures, fast-check arbitraries, tmp-repo helpers
  conformance/ private            MCP conformance harness (v2.1)
```

Key invariants:
- `ManifestBody` is JCS-canonical; `manifestDigest = sha256(JCS(body))`; no timestamps inside the hash.
- Content never lives in the canonical manifest — it travels as `blobs` (≤256 KiB each, ≤4 MiB bundle), CAS (`.axiom/cas/sha256/…`), or pinned `ref`.
- `apply` requires `confirmDigest === manifestDigest`; pre-image hashes re-verified at commit (TOCTOU guard on shared trees); `.axiom/lock` single writer per root.
- All error codes are a closed enum; tests assert on codes, never on message text.
- MCP: stdout = JSON-RPC only; logs to stderr at `warn`; roots allowlist via `--root`, no `cwd` fallback; tool annotations + `outputSchema` on every tool.
- Predicate `verdict: error` when a provider cannot run — fail closed, never a constant pass.

Full design (types, containment order, journal format, tool table, EBNF for v2.1): `docs/design/v2-architecture.md`.

---

## 3. Roadmap & stories

### Phase 0 — Hygiene (before any v2 code)
| ID | Story | Status |
|----|-------|--------|
| S-001 | Commit the uncommitted 1.0.21–1.0.24 work as-is (`chore: land uncommitted 1.0.21–1.0.24 tree`) | todo |
| S-002 | `git mv` all root reports/scratch/outputs to `docs/archive/v1/`; add `.gitignore` for `out*/`, `test-results/`, `*-app/`, `.axiom/` | todo |
| S-003 | Fix `pnpm-workspace.yaml` (`allowBuilds` placeholder), move `workflows/ci.yml` under `.github/` or delete | todo |
| S-004 | Write `PLAN.md` + `TRACKER.csv` (this) | doing |
| S-005 | Tag `v1.0.24-final`; `npm deprecate` 1.x after v2.0.0 ships | todo |

### Phase 1 — v2.0.0 (minimal shippable) — est. 9 agent-days
| ID | Story | Acceptance | Status |
|----|-------|-----------|--------|
| S-101 | Workspace reset: pnpm catalog, TS 7, tsdown, Biome, Vitest 5, Changesets, Node ≥22.14 | `pnpm lint typecheck test build` green on Win + Ubuntu | todo |
| S-102 | `schema`: Plan/Manifest/CheckReport/ApplyResult/Profile/Journal Zod v4 + errors enum + JSON Schema export | 100% schema tests; `check-schema-json-fresh` guard | todo |
| S-103 | `canon`: JCS + sha256 + in-toto Statement builder (from codai rules-core, with vectors) | RFC 8785 vectors pass; fast-check `JCS(parse(JCS(x)))==JCS(x)` | todo |
| S-104 | `plan`: compile Plan → ManifestBundle (inline + CAS) | golden digests identical on 3 OSes | todo |
| S-105 | `checks`: registry + built-in predicates (`path.allow/deny`, `path.reservedNames`, `content.noSecrets` [PII regexes from v1], `content.maxBytes`, `manifest.maxArtifacts`, `deps.max/deny`, `repo.noOverwriteOf`, `repo.requireCompanion`) + profiles | each predicate unit-tested incl. fail-closed | todo |
| S-106 | `apply`: containment, staging, 2PC, journal, rollback, idempotency, dry-run diff, lock, Windows specifics | fast-check: containment never escapes (10k), apply×2 = noop, rollback after fault at any step restores byte-identical tree | todo |
| S-107 | `mcp`: stdio server, 8 tools w/ annotations + outputSchema, resources `axiom://…`, roots allowlist, stderr-only logging; CLI verbs | in-process Client smoke; bad input → structured error; no `console.log` outside cli | done |
| S-108 | Repo guards: `check-package-deps`, `check-bundle-size`, `check-cold-start`, `check-error-codes`, `check-tool-parity`, `check-no-stdout`, `check-no-shell-spawn`, `check-vacuous-assertions`, `check-golden-digests`, `check-action-pins`, `check-changeset-present` | `pnpm guards` green; runs pre-commit + CI | done |
| S-109 | CI: ubuntu/windows/macos × node 22/24; lint→typecheck→test→build→guards→perf; npm trusted publishing (OIDC) | provenance visible on npmjs.com | done (provenance verifiable after first publish) |
| S-110 | Stryker on `canon`, `apply/contain`, `checks/predicates` ≥ 85% | weekly + on touching paths | **blocked upstream** — vitest-runner 10 not Vitest-5 aware (stryker-js#6210); measured 12.9 % with false survivors; config kept runnable, `break: null`, CI informational |
| S-111 | Docs: README (honest), `docs/mcp_api.md`, `docs/plan-format.md`, `MIGRATION.md`; `.github/instructions/*.instructions.md`; `.github/skills/{add-predicate,add-mcp-tool,add-golden-fixture,release-axiom,debug-apply-journal}` | `check-tool-parity` links docs ↔ registry | done |
| S-112 | Port v1 tests worth keeping (determinism, concurrency, long-paths, error-paths, check AND, PII) to v2 contract; delete the rest | 0 failing, 0 skipped-without-reason | done — see docs/research/2026-09-18-v1-test-audit.md |
| S-113 | Register in codai: `spec/tools.json` entries with RiskClass (`apply`=SENSITIVE, `check`=READ) generated from registry — codai's catalogue has no external-tool type, so AXIOM emits `packages/mcp/spec/codai-tools.json` in codai's `tools-v2.json` entry shape (`docs/integration/codai.md`) | parity test | done |

### Phase 2 — v2.1.0 — est. 8 agent-days
| ID | Story | Status |
|----|-------|--------|
| S-201 | Git PR mode (spawn args array, `-F -` message, branch validation, explicit `git add -- <paths>`) | done — `packages/apply/src/git.ts` (`runGit` spawn no-shell + scrubbed env, `validateBranchName` regex + `check-ref-format`, deterministic `axiom/<name>/<digest12>`), `apply({mode:"pr"})` reuses the fs 2PC then `add -- <paths>` / `commit -F -`; 6 `ERR_GIT_*` codes; MCP `axiom_apply` `mode/branch/commitMessage`; 32 tests incl. injection corpus asserting spawn is never called; no push/PR creation |
| S-202 | `guard.external` predicate (brivio `check-*.mjs` contract, JSON stdout, timeout, allowlist) | done — `packages/checks/src/predicates/guard.ts`: `spawn` args array (no shell, `windowsHide`), relative `command` realpath-contained in `<root>/scripts/` (`.mjs/.js/.cjs` via `process.execPath`, `.ps1` via `pwsh -NoProfile -ExecutionPolicy Bypass -File`) or absolute exact-match in `--guard-allowlist`; env = whitelist + `params.env` + `AXIOM_MANIFEST_DIGEST`/`AXIOM_ROOT`, `NODE_OPTIONS` cleared; JCS bundle/manifest on stdin; wall-clock timeout kills the tree (`taskkill /T /F` args array on win32) → `ERR_GUARD_TIMEOUT`; stdout must be `GuardOutput` JSON (Zod) — non-JSON on any exit → `ERR_GUARD_OUTPUT` fail closed, stderr tail 4 KiB; `legacyText: true` opts into brivio `OK`/`FAIL` lines; double gate: profile `facts.allowGuards` AND `runChecks({allowGuards})` (CLI/server `--allow-guards` on `mcp`/`check`/`apply`), else one `ERR_UNSUPPORTED_OP` error finding; guard checks run in a pool `min(4, cpus)` after sequential predicates, provider `guard` = ok/skipped/error; 26 tests on real fixture scripts copied into a tmp `scripts/`; `docs/checks.md` contract table + `docs/integration/brivio.md` (adapter `scripts/axiom-guard-adapter.mjs` text — brivio's `run-guards.mjs` has no JSON mode) |
| S-203 | `axiom gate --stdin` hook mode (Claude Code + Copilot CLI payloads, exit 0/2, <120 ms) + docs to wire into `~/.copilot/hooks` | done — `packages/mcp/src/gate.ts` (both payload casings incl. Copilot `toolArgs` JSON string; Write/Edit/MultiEdit/NotebookEdit + VS Code create_file/replace_string/insert_edit/apply_patch/multi_replace/edit_notebook; containment + RelPath → `ERR_CONTAINMENT`/`ERR_PATH_*`; `path.deny`/`path.allow`/`content.noSecrets`/`content.maxBytes` via real checks predicates on a synthetic ctx; profile `--profile` → `<root>/.axiom/gate-profile.json` → `~/.axiom/gate-profile.json` → builtin; fail open unless `--strict`); own lazy chunk `dist/gate-lazy.js` (no SDK) from `cli.ts`; measured in-process p95 5.5 ms / 1000 payloads, e2e p50 ~150–194 ms; guard `check-gate-latency` p95 ≤ 250 ms; `docs/hooks.md` wires Copilot CLI, VS Code, Claude Code |
| S-204 | `.axm` v2 grammar (Chevrotain 13) → Plan, position-bearing diagnostics | done — `packages/axm` (`parseAxm`/`formatAxm`, golden `examples/notes.axm`, 200-run roundtrip property), MCP `axiom_axm_parse`, `axiom compile <plan.axm>`; chevrotain is a lazy chunk so `cli.js+cli-main.js` stay under 950 KB |
| S-205 | LSP + VS Code extension (replaces `vscode-bridge`) | done — `packages/axm-lsp` (`@codai/axiom-axm-lsp`, bin `axiom-axm-lsp --stdio\|--node-ipc`, D-14: hand-written over `vscode-languageserver` 10, reuses `parseAxm`/`formatAxm`): diagnostics (1-based → 0-based, closed `ERR_*` codes), completion (15 predicate ids after `using` — parity test vs `builtinRegistry()`; capabilities minus used; `mode`/`op`/`profile` values; depth-aware keyword snippets), hover, document symbols, formatting only on a clean parse, semantic tokens (5-type legend); pure `compute*` functions unit-tested (32 tests, fixture `notes.axm` = 0 diagnostics, format idempotent). `packages/vscode-axm` (private ext `codai.axiom-axm`, engines `^1.138.0`): TextMate grammar (heredoc, digests, embedded JSON), language-configuration, `LanguageClient` over node-ipc resolving the workspace LSP or falling back to the bundled `dist/server.cjs`; `pnpm --filter axiom-axm run package` → self-contained `.copilot-tmp/axiom-axm-2.0.0.vsix` 309 KB (no node_modules; vsce rejects `catalog:` so the script temporarily resolves `@types/vscode`). Not published to Marketplace |
| S-206 | Streamable HTTP transport (loopback, bearer) + `@modelcontextprotocol/conformance` job | done — `packages/mcp/src/http.ts` on plain `node:http` bridging the SDK's `WebStandardStreamableHTTPServerTransport` (the node wrapper drags in `@hono/node-server`; asserted absent from `dist/http-lazy.js`): one transport + one `McpServer` per `Mcp-Session-Id` (SDK `Protocol` binds a single transport), 30-min idle eviction, `POST/GET/DELETE /mcp`, `GET /health`, 4 MiB → 413, Host allowlist (DNS rebinding) on loopback, non-loopback bind REQUIRES bearer from `--http-token-env` (default `AXIOM_HTTP_TOKEN`, sha256+`timingSafeEqual`) else `ERR_INTERNAL` exit 2; `axiom mcp --http <host:port>` (`0` = random port, URL in `http listening` stderr line); own lazy chunk keeps eager bundle 859.9/950 KB; 17 tests via SDK `StreamableHTTPClientTransport`. `packages/conformance` (private): spawns built `dist/cli.js`, runs `conformance server --url … --expected-failures baseline.yml -o … --suite active` (CLI 0.1.16 flags verified via `--help`; bin is `conformance`), 32 scenarios = 10 pass + 22 baselined by design (prompts/logging/subscribe/sampling/elicitation/progress/non-text content/`test://` fixtures), 0 unexpected, 0 stale; CI job `conformance` (ubuntu, node 24, after `quality`, uploads report) |
| S-207 | Optional `template` sources + `emitters-web` plugin (Next 16 / Hono 4 — golden-stack, not Next 14) | done — `packages/plan/src/template.ts` (`TemplateEmitter`/`TemplateDef`/`EmitterRegistry`, `createEmitterRegistry`; structural `ParamsSchema` so `plan` gains no zod dep), `compilePlan({ emitters })` renders `template` sources → inline path, `origin: "template"`, `toolchain.emitters[id] = version` (hashed into `manifestDigest`), `{emitter, template, params}` kept in `planDigest`; closed codes `ERR_EMITTER_UNKNOWN`/`ERR_TEMPLATE_UNKNOWN`/`ERR_TEMPLATE_PARAMS`. `packages/emitters-web` (`@codai/axiom-emitters-web`, deps zod only): emitter `web@2.0.0`, 7 strict-Zod templates (`next.route-handler`, `next.server-action`, `hono.route`, `drizzle.table`, `biome.config`, `tailwind.globals`, `readme.section`), goldens `src/__golden__/*.txt` + `update-golden`, pure-render/LF/no-timestamp tests, pinned 3-template `manifestDigest` `sha256:a88a1ecf…` for cross-OS CI. MCP/CLI register `web` in `axiom_plan_compile`/`axiom_plan_validate`/`axiom compile`; `axiom emitters [--json]` verb + static `axiom://emitters` resource; eager bundle 872/950 KB (strings only, no lazy chunk needed). `docs/emitters.md` (are/are-not table, catalogue, authoring). D-13 delivered |

### Phase 3 — v2.2.0 — est. 6 agent-days
| ID | Story | Status |
|----|-------|--------|
| S-301 | CEL predicates via `@marcbachmann/cel-js` (evaluate first; own subset only if it fails determinism bar) | todo |
| S-302 | DSSE signing + `manifest.requireSigned` + key pinning + anti-rollback | todo |
| S-303 | `ref` sources with `--allow-net`; CAS GC | todo |
| S-304 | `axiom_repo_snapshot` (successor of v1 `reverse-ir`) | todo |
| S-305 | `axiom migrate v1 manifest.json` → Plan | todo |
| S-306 | Integrations: brivio guards as check runner; metu skills emit Plans; codai agent-core consumes `@codai/axiom-apply` | todo |

---

## 4. Verification protocol (every phase)
1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm guards` — output pasted in the phase's closing commit message.
2. Golden digests compared across OSes in CI (never trust one machine).
3. Cold-start & bundle size measured, not estimated.
4. Reality check with owner via `askQuestions` before declaring a phase done.
5. Memory: `/memories/repo/axiom-overview.md` updated in the same turn as any non-obvious finding.

---

## 5. Research log
- 2026-09-18 R1: code inventory, build/test run, sibling-repo integration scan, web landscape (SDD tools, MCP 2026-07-28 spec, parser tech, provenance, policy langs, versions), red-team critique, architecture design. Reports archived in `docs/research/2026-09-18-*.md`.

## 6. Q&A log (owner answers)
- 2026-09-18 round 3: push main + tags → yes (done, CI on 3 OS live); publish 2.0.0 only after CI green on all OS, owner triggers `release.yml` via tag `v2.0.0`; deprecate all 1.x after 2.0.0 live (needs owner `npm login`); v2.1 order = S-204 → S-203 → S-201 → S-202 → S-205 → S-206 → S-207.
- 2026-09-18 round 2: D-01 "Rebuild DSL-first + Transactional write gate"; D-02 defer DSL to v2.1; D-03 predicates→CEL v2.2; D-04/05/10/13 all deferred as recommended; D-06 toolchain accepted; D-09/11 gates+budgets accepted; "începe Faza 0 + Faza 1 imediat".
- 2026-09-18: "Curata, dar arhiveaza nu sterge" → D-08 archive.
- 2026-09-18: wants best-in-class stack even beyond golden stack; deep research; parallel subagents; single canonical md + csv tracker; instructions/skills/hooks so errors are caught later; askQuestions before/after research and at every "done".

## 7. CI findings log (what only the matrix caught)
- Run #1 (`04ec4ab`): **apply delete was a no-op on POSIX** — backup via hardlink, then `rename(target, backup)` onto its own hardlink succeeds without unlinking. Windows never showed it. Fix `f258a6e` (`unlinkRetry`). Verified in `docker node:22 -u 1000`.
- Run #2 (`f258a6e`): **Windows runners (pwsh) passed `--filter './packages/**'` literally** → `Scope: 0 of 9`, build did nothing, tests failed to resolve `@codai/axiom-*`. Fix `7ac1732` (filter by name `"@codai/axiom-*"`).
- Run #3 (`7ac1732`): axm roundtrip property generated host `08` → WHATWG parses all-digit hosts as IPv4, `z.url()` rejects. Fix `1d8c350`.
- Golden digests identical on ubuntu/windows/macos from run #1 onward (determinism invariant holds).

## 8. Release runbook (2.0.0) — owner steps
**State 2026-09-18:** versions bumped to 2.0.0 (`4286d4f`), tag `v2.0.0` pushed, `release.yml` ran and **failed 404** (run 35322058007): npm trusted publishing is configured per package on npmjs.com and cannot authorize packages that do not exist yet. Publish metadata + sourcemap exclusion landed in `bd293fc`; packed `@codai/axiom-mcp` CLI verified to run standalone.

1. **Owner, once, interactive** (needs `npm login` + 2FA): `pwsh -NoProfile -File scripts/release-bootstrap.ps1 -Publish` — publishes the 7 packages in dependency order (dry-run without `-Publish`). Idempotent.
2. **Owner, once per package** on npmjs.com → package → Settings → Trusted publishing → GitHub Actions: owner `dragoscv`, repo `axiom`, workflow `release.yml`, allow `npm publish`. Then Publishing access → "Require 2FA and disallow tokens".
3. Verify live: `npx -y @codai/axiom-mcp@2.0.0 --version` → `2.0.0`; `npm view @codai/axiom-mcp@2.0.0 dist.attestations` (provenance appears from the first CI publish onward, i.e. 2.0.1+).
4. S-005: `npm deprecate "@codai/axiom-mcp@<2.0.0" "v1 superseded by 2.x: manifest hash was not content-bound, apply had no rollback; see MIGRATION.md"` and the same for `@codai/axiom-core`, `-engine`, `-policies`, `@codai/axiom-emitter-*`.
5. Future releases: add changesets → `pnpm changeset version` → commit → tag `vX.Y.Z` → push → `release.yml` publishes with provenance. Move/re-push the `v2.0.0` tag to `bd293fc` after step 1 if you want the GitHub release to point at the published tree.
