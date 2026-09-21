# @codai/axiom-axm

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
