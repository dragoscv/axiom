# @codai/axiom-mcp

## 2.1.0

### Minor Changes

- a483fe8: DSSE signing, key pinning and anti-rollback (PLAN.md S-302 / D-16) — see `docs/signing.md`.
  
  - **canon**: `signEnvelope(body, privateKey)`, `verifyEnvelope(env, trustedKeys)` →
    `{ ok, keyids, payload?, reason? }` with closed reasons `BAD_PAYLOAD_TYPE | NO_SIGNATURES |
    BAD_PAYLOAD | NOT_CANONICAL | UNKNOWN_KEY | BAD_SIGNATURE`; `keyidFor` (= hex sha256 of the raw
    32-byte public key), `generateKeyPair`, `privateKeyFrom` (base64 PKCS#8, raw seed or PEM),
    `publicKeyFrom`. Ed25519 via `node:crypto`, no dependency. Envelope payloadType
    `application/vnd.axiom.manifest+json`, payload `base64(JCS(body))`, DSSE PAE.
  - **schema**: `ManifestBundle.signatures?: ManifestSignature[]` (outside the canonical body —
    `manifestDigest` unchanged), `ManifestBody.counter?` and `Plan.counter?` (int ≥ 0, inside the
    hash), `TrustedKey`/`TrustStore` (`.axiom/trust/keys.json`) and `TrustState`
    (`.axiom/trust/state.json`) schemas. New closed error codes `ERR_SIGNATURE_MISSING`,
    `ERR_SIGNATURE_INVALID`, `ERR_ROLLBACK`. JSON schemas regenerated.
  - **plan**: `Plan.counter` is copied verbatim into `ManifestBody.counter`.
  - **checks**: `manifest.requireSigned` now verifies:
    `{ minSignatures?: 1, antiRollback?: false, trustFile?: ".axiom/trust/keys.json" }`. Findings
    `signature.missing | unknownKey | bad | notCanonical | rollback`; trust file missing/unreadable
    or no root → `verdict: error` (fail closed). Registry stays at 16 ids (the v2.0 presence-only
    stub is replaced).
  - **mcp**: CLI verbs `axiom keygen [--out <dir>] [--name]` (private key → file mode 0600, public
    entry → stdout), `axiom sign <bundle> [--key-file|$AXIOM_SIGNING_KEY] [-o]`,
    `axiom verify <bundle> --root <dir>` (also checks signatures), `axiom trust add|remove|list
    --root`. `axiom_manifest_verify` accepts `root` and reports `signatures: { trustFile, keyids,
    findings, ok }`. `axiom apply` / `axiom_apply` advance `lastCounter` only when the effective
    checks include `manifest.requireSigned { antiRollback: true }` and the result is `applied`.
  - Documented non-goal: cross-root replay is **not** prevented (root is deliberately not bound
    into the payload).
- f70b6d2: Template sources (S-207, D-13). `compilePlan(plan, { emitters })` now renders
  `{ type: "template", emitter, template, params }` sources through an injected
  `EmitterRegistry` (`createEmitterRegistry`, `TemplateEmitter`, `TemplateDef` exported from
  `@codai/axiom-plan`; `plan` gains no dependency). Rendered bytes follow the inline path; the
  manifest records `origin: "template"` and `toolchain.emitters[<id>] = <version>` so an emitter
  bump changes `manifestDigest`, while `params` are hashed into `planDigest`. New closed error codes
  `ERR_EMITTER_UNKNOWN`, `ERR_TEMPLATE_UNKNOWN`, `ERR_TEMPLATE_PARAMS` (template sources no longer
  raise `ERR_UNSUPPORTED_OP`).
  
  New package `@codai/axiom-emitters-web`: emitter `web@2.0.0` with seven small deterministic
  golden-stack templates — `next.route-handler`, `next.server-action`, `hono.route`,
  `drizzle.table`, `biome.config`, `tailwind.globals`, `readme.section` — each with strict Zod
  params, a committed golden file and a pinned cross-OS manifest digest. Not an app generator.
  
  `@codai/axiom-mcp` registers `web` in `axiom_plan_compile` / `axiom_plan_validate` and
  `axiom compile`, adds the `axiom emitters [--json]` verb and the static `axiom://emitters`
  resource. No tool input schema changed.
- d9bcbbe: Streamable HTTP transport: `axiom mcp --http <host:port> [--http-token-env NAME]` serves MCP at
  `POST/GET/DELETE /mcp` (+ unauthenticated `GET /health`) on plain `node:http` — one session per
  `Mcp-Session-Id`, 30-min idle eviction, 4 MiB body limit, DNS-rebinding protection on loopback,
  mandatory constant-time bearer token on any non-loopback bind (refuses to start without one).
  Loaded lazily from `dist/http-lazy.js`; stdio stays the default and the eager bundle is unchanged.
  A new private `packages/conformance` harness runs `@modelcontextprotocol/conformance` against it in
  CI with an expected-failures baseline (0 unexpected failures).
- 40d88ee: `axiom migrate v1 <manifest.json> [-o plan.json] [--profile <name>] [--cas <root>] [--content <dir>] [--overwrite]` — lift an AXIOM 1.0.x manifest into a v2 `Plan` (S-305). Paths become POSIX `RelPath`s, `contentUtf8`/`contentBase64` become `inline` sources, hash-only artifacts are read from the v1 output tree and re-verified against their `sha256` (or stored in `<root>/.axiom/cas` with `--cas`), known policy evidence and the built-in `budget`/`edge` profile constraints map to `content.noSecrets`/`deps.max`/`manifest.maxTotalBytes`/`content.maxBytes`, and every field without a v2 equivalent (`buildId`, `irHash`, `createdAt`, per-artifact `sha256`/`bytes`/`kind`, runtime evidence) is listed in `metadata.migration.dropped` with a reason — no timestamps enter the Plan. Exit 0 clean, 1 migrated with warnings (still written), 2 not a v1 manifest (`ERR_INVALID_MANIFEST`). `migrateV1()` is exported for programmatic use; the code ships as a lazy chunk (`dist/migrate-lazy.js`) so the eager CLI bundle is unchanged. See `docs/migrate.md`.
- 40d88ee: `ref` sources are resolved (PLAN.md S-303). `resolveRef(source, { root, allowNet, allowlist?,
  allowFile?, maxBytes?, timeoutMs?, fetchImpl? })` returns the bytes from `<root>/.axiom/cas` when
  the pinned digest is already there — no network, no policy — and otherwise fails closed with
  `ERR_NET_DISABLED` unless `allowNet`. With it: `https:` only (`file:` behind `allowFile`), no
  credentials in the URI, optional host allowlist with `*.example.com` wildcards
  (`ERR_NET_DENIED`), `redirect: "error"`, AbortController timeout, streamed download with a running
  sha256 and a hard byte cap (`ERR_BLOB_TOO_LARGE`), digest mismatch → `ERR_DIGEST_MISMATCH` and
  nothing stored, match → fsync + atomic rename into the CAS. Error details carry the URI redacted
  to origin + path. `compilePlan` gains `net?: RefNetOptions` (default offline); the manifest keeps
  `origin: "ref"` and ref bytes are never inlined into `blobs`. `apply` is unchanged: CAS or
  `ERR_REF_OFFLINE`.
  
  CLI: `axiom compile … --allow-net [--net-allow host[,host]] [--allow-file]`, and a new
  `axiom gc --root <dir> [--dry-run] [--older-than <n>(ms|s|m|h|d)] [--keep all-manifests|journal]`
  that removes CAS blobs no stored manifest references (plus stale `*.tmp`), under `.axiom/lock`
  (live holder → `ERR_LOCKED`), idempotent, reporting
  `{ scanned, live, missing, removed: [{sha, bytes}], skippedYoung, freedBytes }`. Neither is an MCP
  tool by design. New closed codes: `ERR_NET_DISABLED`, `ERR_NET_DENIED`, `ERR_NET_FAILED`. Docs:
  `docs/cas.md`, `docs/plan-format.md` § Ref sources.
- 40d88ee: `axiom_repo_snapshot` — deterministic, content-addressed inventory of a root (PLAN.md S-304) —
  see `docs/snapshot.md`. Successor of the v1 `reverse-ir`.
  
  - **schema**: `RepoSnapshotSchema` (`{ apiVersion, kind: "RepoSnapshot", root: { kind: "relative" },
    snapshotDigest, body: { files: [{ path, bytes, sha256?, mode, kind: "file"|"symlink" }],
    truncated, counts: { files, bytes } } }`), `RepoSnapshotBodySchema`, `RepoSnapshotEntrySchema`.
    `schemas/RepoSnapshot.schema.json` emitted.
  - **mcp**: READ tool `axiom_repo_snapshot { root?, include?, exclude?, maxFiles? (20000, cap 50000),
    maxBytes? (64 MiB), respectGitignore?, withContentDigest? }` → `RepoSnapshot` with
    `snapshotDigest = sha256(JCS(body))`; no timestamps or absolute paths, files sorted by
    `compareUtf8`, `.git/` and `.axiom/` always skipped, root `.gitignore` honoured, symlinks recorded
    but never followed (target hashed only when inside the root), globs containing `..` →
    `ERR_CONTAINMENT`. Truncated results are a deterministic sorted prefix. CLI verbs
    `axiom snapshot --root <dir> [-o] [--include] [--exclude] [--max-files] [--max-bytes] [--no-gitignore]
    [--no-digest]` and `axiom snapshot-diff <a.json> <b.json>` (pure `diffSnapshots` →
    `{ added, removed, changed }`). `axiom schema RepoSnapshot` and `axiom://schema/RepoSnapshot`.
    The server now exposes 11 tools.

### Patch Changes

- Updated dependencies [5d1d33f]
- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-checks@2.1.0
  - @codai/axiom-canon@2.1.0
  - @codai/axiom-schema@2.1.0
  - @codai/axiom-plan@2.1.0
  - @codai/axiom-emitters-web@2.1.0
  - @codai/axiom-apply@2.1.0
  - @codai/axiom-axm@2.1.0

## 2.0.0

### Major Changes

- 23d80d5: New `@codai/axiom-mcp` 2.0.0: stdio MCP server (`McpServer.registerTool` with annotations, Zod v4 input/output
  schemas, `structuredContent`), 9 tools (`axiom_plan_validate|plan_compile|manifest_verify|check|apply_dry_run|apply|rollback|manifest_diff|roots_list`),
  5 resource templates (`axiom://manifest|report|applied|profile|schema`), frozen `--root` allowlist with no
  env/cwd fallback, stderr-only JSON-lines logging, 4 MiB payload guard, `spec/tools.json` generated from the
  registry, and an `axiom` CLI (`compile|verify|check|apply|rollback|diff|schema|mcp`) bundled into a single
  self-contained `dist/cli.js`.

### Minor Changes

- f2e60b0: Git PR mode (S-201, design §4.3). `apply({ mode: "pr", branch?, commitMessage? })`
  creates a branch (default `axiom/<name>/<digest12>`, deterministic), runs the
  ordinary two-phase fs apply, stages exactly the touched paths with
  `git add -- <paths>` and commits with the message on stdin (`-F -`). Every git
  call is `spawn("git", args, { shell: false })` with a scrubbed env
  (`GIT_DIR`/`GIT_WORK_TREE` dropped, `GIT_TERMINAL_PROMPT=0`); branch names are
  checked by regex and `git check-ref-format --branch`. Result carries
  `git: { branch, commit, compareUrl? }` (GitHub/GitLab compare URL from `origin`).
  No push, no PR creation, hooks honoured. New closed error codes:
  `ERR_GIT_NOT_FOUND`, `ERR_GIT_NOT_REPO`, `ERR_GIT_DIRTY`, `ERR_GIT_BRANCH_EXISTS`,
  `ERR_GIT_BRANCH_INVALID`, `ERR_GIT_FAILED`. MCP `axiom_apply` accepts
  `mode: "fs" | "pr"`, `branch`, `commitMessage`.
- c629d26: New `@codai/axiom-axm`: the `.axm` v2 front-end (S-204). Chevrotain 13 lexer + CST parser implementing the
  §6 EBNF (`axiom "2"`, `plan Ident { intent | profile | capabilities [..] | artifact String {..} | check Ident using
  QualIdent [Json] | meta Json }`, sources `inline <<HEREDOC | template | cas | ref`) compiled 1:1 into a
  `PlanSchema`-validated `Plan`. `parseAxm(source)` never throws and returns `{ plan?, diagnostics[] }` with
  1-based `{line, column}` ranges and closed `ERR_*` codes (lexer, parser with expected-token messages, semantic:
  duplicate artifact path / unknown capability / Zod issues mapped back to source). `formatAxm(plan)` is the
  deterministic inverse (`parseAxm(formatAxm(p)).plan` deep-equals `p`, property-tested). CRLF input is normalised
  to LF; heredoc terminators must be alone on their line.
  
  `@codai/axiom-mcp`: new read-only tool `axiom_axm_parse { source } → { plan?, diagnostics[] }` and
  `axiom compile <plan.axm>` (parses first; on errors prints diagnostics JSON and exits 2). The parser is a
  lazily imported chunk, so `cli.js + cli-main.js` stay inside the 950 KB budget and cold start is unchanged.
- 04ec4ab: Emit `spec/codai-tools.json` — the 9 MCP tools in the entry shape of codai's
  `packages/agent-core/spec/tools-v2.json` (`{ name, risk, description, parameters }`) so codai agents can
  gate them under `APPROVAL_MATRIX`; generated by `build:spec` alongside `spec/tools.json` and pinned by the
  parity test. `axiom_plan_compile` is now annotated `readOnlyHint: false` (risk `ACT`): with `store: cas` or
  a `root` it writes under `<root>/.axiom/`. See `docs/integration/codai.md`.
- f2e60b0: New `axiom gate --stdin [--root <dir>] [--profile <file>] [--strict] [--log-level …]` — PreToolUse hook
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
- fc679b9: `guard.external` is now a real predicate (S-202, v2-architecture §3.2). It spawns a repository-owned
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

### Patch Changes

- Updated dependencies [f258a6e]
- Updated dependencies [f2e60b0]
- Updated dependencies [c629d26]
- Updated dependencies [fc679b9]
  - @codai/axiom-apply@2.0.0
  - @codai/axiom-schema@2.0.0
  - @codai/axiom-axm@2.0.0
  - @codai/axiom-checks@2.0.0
  - @codai/axiom-plan@2.0.0
  - @codai/axiom-canon@2.0.0
