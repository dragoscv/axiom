# @codai/axiom-axm

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
