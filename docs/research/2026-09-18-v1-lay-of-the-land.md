## Research: E:\gh\axiom — lay of the land

Caveat up front: this session has no terminal tool, so `git status`, `wc`, and `npm view` could not be executed. Git state comes from reading `.git/` directly; npm state from fetching the registry document; LOC are approximations from files read. Each claim is tagged VERIFIED (read it) or INFERRED.

### 1. What `.axm` expresses

Source: [docs/syntax_spec.md](docs/syntax_spec.md#L1-L24), [packages/axiom-core/src/ir.ts](packages/axiom-core/src/ir.ts#L1-L44), [examples/blog.axm](examples/blog.axm#L1-L14), [axiom/notes.axm](axiom/notes.axm#L1-L27).

1. One file = one `agent "<name>" { … }` block; the parser only extracts the first agent ([parser.ts](packages/axiom-core/src/parser.ts#L19-L23)), IR allows an array.
2. `intent "<free text>"` — a natural-language sentence, not interpreted by anything.
3. `constraints { lhs op rhs, … }` — pure comparisons (`==,!=,<=,>=,<,>`) over identifiers like `latency_p50_ms`, `monthly_budget_usd`, `pii_leak`.
4. `capabilities { fs("./out") net("http") secret("X") }` — kinds limited to `fs|net|secret|ai|compute`, optional `?` suffix.
5. `checks { policy|sla|unit "<name>" expect <expr> }` — expr is a mini-DSL evaluated by `@codai/axiom-policies` (comparisons + `scan.artifacts.no_personal_data()`, `http.healthy(url)`).
6. `emit { service type="web-app"|"api-service"|"docker-image"|"batch-job" target="./out/…" ; tests …; manifest target=… }`.
7. Validator only checks capability↔check consistency (`http.*` needs `net`, `scan.artifacts.*` needs `fs`) — [validator.ts](packages/axiom-core/src/validator.ts#L5-L33).
8. IR = Zod schema, `version: "1.0.0"`; [docs/ir_spec.md](docs/ir_spec.md) is 4 lines pointing at `ir.ts`.
9. Parser is regex/`indexOf`-based, no tokenizer, no nesting, no error positions; both inline (`check policy "x" { expect "…" }`) and block syntax are accepted.
10. The spec says "no technology names appear in the language", but the language is effectively a config file selecting one of 4 hard-coded emitters; `intent` and `constraints` (other than via `checks`) influence nothing in generation.

### 2. Packages

| Package | Version | ~LOC (src, approx) | Does | Emits | TODO/stub/placeholder hits |
|---|---|---|---|---|---|
| `@codai/axiom-core` | 1.0.1 | ~250 (ir 44, parser ~170, validator 33) | Zod IR, regex parser, capability validator | — | 0 |
| `@codai/axiom-engine` | 1.0.24 | ~1,600 (apply ~320, fs-axiom ~450, generate 180, check ~220, reverse-ir ~200, axpatch ~190, artifactStore, manifest, util) | `generate` (calls emitters, sha256 manifest, inline content ≤256 KiB), `check` (metrics from artifacts), `apply` (atomic write + verify, `fs`/`pr` mode via `git`), `reverseIR` (scan `out/`), `diff/applyPatch` (JSON-patch-ish) | — | 1 ([generate.ts:114](packages/axiom-engine/src/generate.ts#L114) placeholder README for unknown subtype) |
| `@codai/axiom-mcp` | **1.0.24** | ~550 (mcp-stdio ~420, server ~130, postinstall 40, fs-probe-write ~80) | MCP stdio server (`axiom_parse/validate/generate/check/reverse/diff/apply`) + legacy HTTP server on :3411; postinstall writes `~/.mcp/servers/axiom.json` | — | 0 |
| `@axiom/tests` | 0.1.0 | ~4,000 across 27 test files + `run.ts` smoke | vitest suite | — | 4 (all `it.skip` + TODO in [golden.test.ts:107-166](packages/axiom-tests/src/golden.test.ts#L107-L166)) |
| `emitters/*` (4 published + webapp-pii) | 1.0.1 each | webapp ~430, apiservice ~400, docker 20, batchjob 18, webapp-pii 15 | Hard-coded template strings | **webapp**: Next.js 14.2.7 + React 18.3.1 App Router, inline styles, `fetch('http://localhost:4000/notes')` CRUD ([webapp/src/index.ts](packages/emitters/webapp/src/index.ts#L29-L130)). **apiservice**: raw `node:http` in-memory notes CRUD + `/openapi`, no framework ([apiservice/src/index.ts](packages/emitters/apiservice/src/index.ts#L44-L60)). **docker**: `FROM node:20-alpine` + `console.log('placeholder')` ([docker/src/index.ts](packages/emitters/docker/src/index.ts#L6-L16)). **batchjob**: `console.log('Batch job placeholder')` ([batchjob/src/index.ts](packages/emitters/batchjob/src/index.ts#L8)). No Hono, no Rust, no Drizzle, no Tailwind — it is one notes app, always. | 2 (docker, batchjob literal "placeholder") |
| `@codai/axiom-policies` | 1.0.1 | ~330 | Tokenizer + evaluator for check expressions; PII regex (email/phone/CNP) | — | 0 |
| `axiom-vscode-bridge` | 0.1.0 | 6 | `activate()` logs a line — [extension.ts:3](packages/vscode-bridge/src/extension.ts#L3) "Skeleton" | — | 1 (skeleton) |

Also: `webapp-pii` imports `@axiom/engine` (wrong scope, [webapp-pii/src/index.ts:1](packages/emitters/webapp-pii/src/index.ts#L1)) — cannot build. Profile-conditional output is limited to: edge → `runtime:'edge'` + port 8787; budget → drop `@vercel/analytics`/`pino` ([webapp:376-384](packages/emitters/webapp/src/index.ts#L376-L384), [apiservice:365-368](packages/emitters/apiservice/src/index.ts#L365-L368)). `check.ts` "real metrics" are `cold_start_ms` = constant per profile (50/100/120) and `no_pii_in_artifacts = true` hard-coded ([check.ts:97-105](packages/axiom-engine/src/check.ts#L97-L105), [check.ts:196-197](packages/axiom-engine/src/check.ts#L196-L197)).

### 3. Tests & CI

- Framework: **Vitest ^2** in `@axiom/tests` (27 `*.test.ts` in [packages/axiom-tests/src](packages/axiom-tests/src)); `node:test` in [policies/test/evaluator.test.ts](packages/policies/test/evaluator.test.ts) (14 cases). Root `pnpm test` runs only `tsx src/run.ts` — a smoke that parses `examples/blog.axm` and generates into `tmp_artifacts/` ([run.ts](packages/axiom-tests/src/run.ts)); vitest is a separate `test:unit` script.
- Coverage: ~85% of tests are about `apply()` filesystem semantics (POSIX paths, traversal, backslashes, repoPath resolution, cross-drive, long paths, atomic write, concurrency, inline content). A handful cover `check` AND-aggregation and determinism; 1 file covers the parser; **zero** tests for `reverseIR`, `diff/applyPatch`, the MCP server, or emitter output content.
- [golden.test.ts](packages/axiom-tests/src/golden.test.ts#L80-L91) reads `../../../out-edge/manifest.json` from the repo root — depends on committed build output; all sha256 fields are `''` and hash assertions are `it.skip`.
- CI: two workflows. [.github/workflows/axiom-conformance.yml](.github/workflows/axiom-conformance.yml) (matrix ubuntu/windows × node 20/22/24) — its "Operations Smoke Test" step is `console.log('✅ …')` × 5 with no assertions ([lines 47-58](.github/workflows/axiom-conformance.yml#L47-L58)). [workflows/ci.yml](workflows/ci.yml) is in the wrong directory (not `.github/`), so it never runs. `test-output.txt` at root is a captured **failing** vitest run.

### 4. Uncommitted state (INFERRED — no shell)

Could not run `git status`. Evidence: `.git/refs/heads/main` = `c7298fe` ("fix: real FS writes … v1.0.20"), no tags, `packed-refs` absent. The npm registry shows **1.0.21, 1.0.22, 1.0.23 and 1.0.24 all published with `gitHead: c7298fe`** — i.e. from an uncommitted working tree. So the ~30 changed files are almost certainly the entire 1.0.21–1.0.24 body of work: `packages/axiom-engine/src/lib/fs-axiom.ts`, `packages/axiom-engine/schemas/*.json`, `packages/axiom-mcp/src/tools/fs-probe-write.ts`, the 5 tests listed in [CHANGELOG.md:16-21](CHANGELOG.md#L16-L21) (+ `apply-enhanced-fs`, `apply-repopath-dot`, `apply-same-drive-abs`, `apply-absolute-repoPath`, `apply-reject-backslash-paths`), version bumps in `axiom-engine`/`axiom-mcp` package.json, `RELEASE-NOTES-1.0.21..24.md`, `TEST-MATRIX-REPORT*.md`, `HARDENING-IMPLEMENTATION-SUMMARY.md`, `CHANGELOG.md`, `README.md`, `test-output.txt`, `debug-manifest.cjs`, `test-*.cjs/.mjs`. Run `git status --short` to confirm.

### 5. Versions

- [packages/axiom-mcp/package.json:3](packages/axiom-mcp/package.json#L3) → **1.0.24**; depends on `@codai/axiom-engine ^1.0.24`.
- npm (VERIFIED via registry fetch): `@codai/axiom-mcp` dist-tags.latest = **1.0.24**, 25 versions 1.0.0→1.0.24, all published between **2025-10-20 11:55Z and 2025-10-21 07:03Z** — 25 releases in ~19 hours, by `dragoscatalin`. 1.0.24 unpackedSize 37.1 kB, 7 files. Published README still says "Version: 1.0.9 — CURRENT".

### 6. Quality red flags (honest)

- **Fabricated/decorative validation**: [HARDENING-IMPLEMENTATION-SUMMARY.md:5](HARDENING-IMPLEMENTATION-SUMMARY.md#L5) — "DELIVERY STATUS: ✅ SUCCESS … Test execution skipped per MODE: TOOL-ONLY", while [RELEASE-NOTES-1.0.24.md:5](RELEASE-NOTES-1.0.24.md#L5) says "Status: ✅ Production-Ready". CI smoke step is pure `console.log` checkmarks. Golden hashes empty + skipped. `check.ts` metrics are constants presented as "REAL enforcement".
- **Root litter**: ~25 summary/report markdowns (FINAL_SUMMARY, FINAL_VALIDATION_REPORT, PRODUCTION_READY_SUMMARY, PRODUCTION_VALIDATION_REPORT, PR-SUMMARY, PR-FINAL-SUMMARY, IMPLEMENTATION-COMPLETE, GO-NOGO ×3, PROOF_1.0.17, VALIDATION-REPORT-1.0.18, RELEASE-NOTES ×7, RELEASE-ANNOUNCEMENT ×2, TEST-MATRIX ×2, HARDENING…, REVERSE_IR…). They contradict each other: [PR-SUMMARY.md:3](PR-SUMMARY.md#L3) "18/33 passing", [PR-FINAL-SUMMARY.md:8](PR-FINAL-SUMMARY.md#L8) "31/31", later notes "4/4 tests passing (100%)" for a suite with 27 files. Plus committed build outputs (`out-edge/`, `out-budget/`, `test-results/`, `tmp_artifacts/`, `sbom.json`, tarball sha256) and scratch scripts (`test-json.cjs`, `test-posix.cjs`, `debug-manifest.cjs`, `test-generate.mjs`) at root and in `axiom-tests/`.
- **AI-generated smell**: emoji headers, "Confidence Level: 95%", "TOATE CAPETELE ÎNCHISE", mixed RO/EN comments, "CRITICAL FIX … defense-in-depth" that does `.replace(/\\/g,'/')` three times in a row ([generate.ts:135-176](packages/axiom-engine/src/generate.ts#L135-L176)), `console.error` on every step of `writeAndVerify` (~25 log lines per file write) shipped in production code.
- **Hardcoded paths**: `TEST-MATRIX-REPORT-v1.0.22.md` embeds `C:\Users\vladu\AppData\Local\Temp\…`; README/RELEASE-NOTES use `C:\\Users\\user\\project`; generated webapp hardcodes `http://localhost:4000`.
- **Broken build hazards**: `webapp-pii` imports `@axiom/engine` (nonexistent scope); `workflows/ci.yml` misplaced; two pnpm versions between the workflows (9 vs 10); root devDeps zod 3 / TS 5.6 vs golden stack.
- **Publishing hygiene**: 1.0.7 shipped `workspace:*` deps (RELEASE-NOTES-1.0.8 admits it); 1.0.3–1.0.6 shipped 196 files / 27.8 MB (cache included); postinstall writes into `~/.mcp/servers/` unconditionally.

### 7. References to codai / brivio / metu

- `codai` appears **only** as the npm scope `@codai/*`, the `publisher: "codai"` in vscode-bridge, and `$id: https://axiom.codai.dev/schemas/...` in the two JSON schemas. No import of the codai gateway, no `codai` model name, no AI call anywhere.
- `brivio`, `metu`, `money`, `mmo`, `vmui`: **zero** matches outside the word "common" false positives. No integration with any of the user's other repos was planned or scaffolded.

Repo note saved to `/memories/repo/axiom-overview.md`.