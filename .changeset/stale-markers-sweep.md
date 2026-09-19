---
"@codai/axiom-schema": patch
"@codai/axiom-canon": patch
"@codai/axiom-plan": patch
"@codai/axiom-axm-lsp": patch
"@codai/axiom-mcp": patch
---

Doc/code drift sweep (S-410): the `template` source is no longer described as
"reserved for v2.1 / compile rejects" in the Plan JSON schema, the `.axm` LSP
hover and the docs — it has been rendered by registered emitters since 2.1.0.
`VerifyResult.signed` documents that structural verification never verifies
signatures (use `axiom verify --root` or the `signature.*` predicates). v1-era
docs (`ir_spec`, `plugin_api`, `reverse_ir_spec`, `MCP-ONLY-PUBLIC-SURFACE`)
moved to `docs/archive/v1/`. New repo guard `check-stale-markers` fails on any
forward-looking "planned for vX.Y" note whose version is already released.
