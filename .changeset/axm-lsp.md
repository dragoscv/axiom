---
"@codai/axiom-axm-lsp": minor
---

New package `@codai/axiom-axm-lsp` (bin `axiom-axm-lsp --stdio|--node-ipc`): a language server
for `.axm` that reuses the `@codai/axiom-axm` Chevrotain parser (one grammar, zero drift — PLAN.md
D-14). Diagnostics with 0-based LSP ranges and closed `ERR_*` codes, context-aware completion
(predicate ids after `using`, capabilities, `mode`/`op`/`profile` values, keyword snippets by
nesting depth), keyword/predicate hover, document symbols, `formatAxm`-based formatting (only on a
clean parse) and semantic tokens. Pure feature functions are exported for embedding. A private VS
Code extension `packages/vscode-axm` (`axiom-axm`) wires the client + TextMate grammar and packages
to a self-contained .vsix.
