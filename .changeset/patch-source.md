---
"@codai/axiom-schema": minor
"@codai/axiom-plan": minor
"@codai/axiom-axm": minor
"@codai/axiom-axm-lsp": minor
"@codai/axiom-mcp": minor
---

`patch` artifact source (S-401, D-17): `{ type: "patch", format: "unified" |
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
