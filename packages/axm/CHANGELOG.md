# @codai/axiom-axm

## 3.0.0

### Major Changes

- 9122967: v3 wire identity and one policy file (D-41, D-42).
  
  - New canonical `apiVersion: "axiom.codai.ro/v3"` for every document AXIOM creates (Plan, Manifest,
    CheckReport, ApplyResult, Profile, RepoSnapshot); `"axiom.dev/v2"` keeps parsing through 3.x and a
    2.x plan still compiles to its 2.x digest. New plans therefore have new `planDigest`/`manifestDigest`
    values (golden fixtures re-pinned; `plan-basic-v2` pins the 2.x digest). Schema exports
    `API_VERSION_V2`, `API_VERSIONS`, `isLegacyApiVersion`. JSON Schema `$id`s move to
    `https://dragoscv.github.io/axiom/schemas/v3/`.
  - Attestation predicate URIs move to `https://dragoscv.github.io/axiom/spec/...`
    (`AXIOM_APPLY_ATTESTATION_V1`, `AGENT_DECISION_V0_1`, build type, builder id); the 2.x URIs stay
    exported as `*_LEGACY`.
  - `.axiom/axiom.json` (`version: 3`, `gate`, `checks`, `extends`): `loadAxiomConfig` with
    relative-file, `axiom:<pack>` and installed `@codai/axiom-pack-*` extends, union of
    deny/ask/hard/allow, cycle/depth → `ERR_INVALID_PROFILE`, version > 3 → `ERR_PROFILE_VERSION`,
    unknown keys warn. `loadProfile(name, { config })` reads its `checks` section. `migrateProfile`
    folds `.axiom/gate-profile.json` + `.axiom/profiles/<name>.json` into it without deleting them.
    New `AxiomConfig` JSON Schema.
- 9122967: 3.0 (D-43 / D-45, S-1312 / S-1319):
  
  - **mcp — core toolset by default.** `createServer` / `serverFactory` take `toolset: "core" | "full"`;
    `core` (default) serves `axiom_write`, `axiom_status`, `axiom_rollback`, `axiom_check`,
    `axiom_apply`, `axiom_apply_dry_run`; `full` serves every tool. `parseToolset(value)` parses the
    `--tools core|full` flag (`ERR_USAGE` otherwise). `spec/tools.json` and `spec/codai-tools.json`
    mark each tool `"toolset": "core" | "full"` (codai spec format version 3.0.0).
  - **mcp — emitters-web is no longer bundled.** `template` sources need an emitter loaded with
    `--emitter <pkg>` (`loadEmitters(specs, root)`: package name resolved from the root's
    `node_modules`, or a path). Without one they fail `ERR_EMITTER_UNKNOWN` with
    `details.hint` "install @codai/axiom-emitters-web and pass --emitter @codai/axiom-emitters-web".
    `axiom://emitters` is empty by default.
  - **axm — language server merged in.** `@codai/axiom-axm/lsp` (+ bin `axm-lsp`) is the `.axm`
    language server; the main entry stays LSP-free. Fixed: a plan named `meta` (or any keyword) no
    longer mis-lexes its body as a JSON block; `KEYWORD_IMAGES` is exported.
  - **axm-lsp — deprecated.** Thin re-export of `@codai/axiom-axm/lsp` for 3.x; not published for 4.0.
  - **emitters-web** — banners derive from `WEB_EMITTER_VERSION` (`generatedBanner`); exports
    `emitters` for `--emitter` loading.

### Patch Changes

- Updated dependencies [9122967]
- Updated dependencies [9122967]
  - @codai/axiom-schema@3.0.0

## 2.7.0

### Patch Changes

- @codai/axiom-schema@2.7.0

## 2.6.1

### Patch Changes

- @codai/axiom-schema@2.6.1

## 2.6.0

### Patch Changes

- @codai/axiom-schema@2.6.0

## 2.5.2

### Patch Changes

- @codai/axiom-schema@2.5.2

## 2.5.1

### Patch Changes

- Updated dependencies [424297a]
  - @codai/axiom-schema@2.5.1

## 2.5.0

### Patch Changes

- @codai/axiom-schema@2.5.0

## 2.4.1

### Patch Changes

- @codai/axiom-schema@2.4.1

## 2.4.0

### Patch Changes

- Updated dependencies [77ebf23]
  - @codai/axiom-schema@2.4.0

## 2.3.1

### Patch Changes

- @codai/axiom-schema@2.3.1

## 2.3.0

### Patch Changes

- @codai/axiom-schema@2.3.0

## 2.2.1

### Patch Changes

- @codai/axiom-schema@2.2.1

## 2.2.0

### Minor Changes

- b51eb33: `patch` artifact source (S-401, D-17): `{ type: "patch", format: "unified" |
  "v4a" | "search-replace", preImage: "sha256:…" | "absent", body }`. Compile
  reads the file under the root, requires it to hash to `preImage`
  (`ERR_PATCH_PREIMAGE`), applies the diff with **exact** matching only
  (`ERR_PATCH_NO_MATCH`; malformed body → `ERR_PATCH_FORMAT`) and
  content-addresses the result, so Manifest, checks and apply never see a patch.
  A patch plan and its inline twin share `planDigest` (golden fixtures
  `plan-patch` / `plan-patch-inline`); `origin: "patch"` is recorded on the
  artifact. Three parsers (unified diff, OpenAI/Codex V4A `apply_patch` text for
  one file incl. `@@ context` anchors and `*** End of File`, Aider
  SEARCH/REPLACE) feed one applier. `.axm` gains
  `patch <format> ("sha256:…"|absent) <<HEREDOC`; the LSP completes and documents
  it. `CompileOptions.readPreImage` lets callers (gate, tests) supply pre-images
  without a filesystem root.

### Patch Changes

- Updated dependencies [801d29e]
- Updated dependencies [b51eb33]
- Updated dependencies [c8de39b]
- Updated dependencies [38ff1c0]
- Updated dependencies [02527d8]
- Updated dependencies [28a39a0]
  - @codai/axiom-schema@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-schema@2.1.0

## 2.0.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f2e60b0]
  - @codai/axiom-schema@2.0.0
