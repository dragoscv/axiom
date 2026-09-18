---
"@codai/axiom-checks": minor
"@codai/axiom-axm-lsp": patch
---

New predicate `expr.cel` (PLAN.md S-301 / D-15): a boolean CEL expression over `manifest`,
`artifacts`, `content` (path → `{bytes, sha256, text?}`) and `repo` (`exists` map, only with an
authorised root — referencing it without one is an `error`, never a pass). Evaluated with
`@marcbachmann/cel-js` 8 behind a lazy `import()` so the MCP eager bundle grows by 8 KB only
(872.4 → 880.2 KB). The determinism bar is enforced in the predicate: closed function allowlist
(no `timestamp`/`duration`/`now`/`base64`/`json`/`bind`), literal RE2-safe `matches()` (no
lookaround/backrefs), expression ≤ 4096 chars, AST depth ≤ 24 / ≤ 2000 nodes, 100 ms evaluation
budget, closed variable set. Parse/type/runtime errors and non-bool results are provider-style
`error` findings; `false` yields exactly one finding with the optional `message`. Ships with a
345-case vector suite, a purity test and fast-check properties. `builtinRegistry().list()` now has
16 ids; the `.axm` LSP completion list gained `expr.cel`.
