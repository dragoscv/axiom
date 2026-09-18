# @codai/axiom-axm-lsp

Language server for AXIOM `.axm` plans (docs/syntax_spec.md). Diagnostics, completion, hover,
document symbols, formatting and semantic tokens over LSP 3.18 — built on the **same**
Chevrotain parser that compiles `.axm` to a `Plan` (`@codai/axiom-axm`), so the editor and the
gate can never disagree about what is valid.

```
npx axiom-axm-lsp --stdio        # generic editors (neovim, helix, zed, …)
node dist/main.js --node-ipc     # what the VS Code client (packages/vscode-axm) uses
```

```ts
import { computeCompletions, computeDiagnostics, formatDocument } from "@codai/axiom-axm-lsp";
```

## Decision D-14: hand-written server over `vscode-languageserver`, not Langium (option B)

Two ways to get an LSP for a language already implemented in Chevrotain:

| | (A) Langium 4.4 `.langium` grammar + `langium-cli` | (B) `vscode-languageserver` + reuse `parseAxm` |
|---|---|---|
| Completion / hover / scoping | generated from the grammar | hand-written (≈300 lines, `features.ts`) |
| Grammars in the repo | **two** — `.langium` and `packages/axm/src/{lexer,parser}.ts` | **one** |
| Drift | the generated parser and the compile parser can accept different inputs; nothing detects it | impossible by construction: diagnostics come from the compile parser |
| Custom terminals (`HereDoc` with a named terminator, context-sensitive `Json`) | need a custom `TokenBuilder` + `Lexer` service anyway — the generator does not express them | already implemented in `packages/axm` |
| Runtime weight in the editor process | Langium runtime + its own Chevrotain parser | `parseAxm` + `vscode-languageserver` |

Langium 4.4 was checked (Context7 `/eclipse-langium/langium`, "Integrate Custom Parser",
"Customize Langium Services"): its services module lets you replace `Lexer`, `TokenBuilder`,
`ValueConverter` and even `LangiumParser`, but every service is *derived from the `Grammar` AST*
loaded from a `.langium` file — the grammar is the input to the DI container, not an optional
plugin. There is no supported path to hand Langium an existing `CstParser` and its token
vocabulary without also writing the grammar, so option A always means a second grammar.
The `.axm` grammar has 15 keywords, six statement kinds and no cross-references, so
completion/hover/symbols are a few hundred lines by hand — cheaper than maintaining two grammars
and a parity test between them. **B it is.**

Diagnostics and formatting call `parseAxm` / `formatAxm` directly. Everything that must also
work on a *broken* document (completion context, hover word, symbols, semantic tokens) runs on a
tolerant position-only scanner (`scan.ts`) that knows just enough (strings, comments, heredocs,
JSON blocks) to never mis-nest braces; it never claims validity.

## Features

| LSP request | Behaviour |
|---|---|
| `textDocument/publishDiagnostics` | `parseAxm` diagnostics; 1-based `{line,column}` → 0-based LSP ranges, `code` = closed `ERR_*` enum, `source: "axm"` |
| `textDocument/completion` | after `using` → 15 built-in predicate ids (with docs; qualified prefix replaced as one edit) · inside `capabilities [` → unused capability names · after `mode` → `0644`/`0755` · after `op` → `create`/`overwrite`/`delete` · after `profile` → `default`/`strict`/`permissive` · statement start → keywords valid at that nesting depth, as snippets |
| `textDocument/hover` | keyword docs; predicate docs on `using group.name` |
| `textDocument/documentSymbol` | plan (Module) → artifacts (File) + checks (Function, detail `check using <predicate>`) |
| `textDocument/formatting` | one whole-document edit with `formatAxm` output — **only when the document has zero diagnostics**, otherwise `[]` (formatting a broken file would drop what the parser skipped) |
| `textDocument/semanticTokens/full` | legend `keyword, string, number, comment, property`; multi-line tokens (heredoc, JSON, block comment) are split per line |

The predicate list lives in `vocabulary.ts` and is asserted equal to
`builtinRegistry().list()` from `@codai/axiom-checks` in the test suite (devDependency only —
the server does not load the checks engine at runtime).

## Build

`tsdown` emits `dist/index.js` (library, workspace deps external) and `dist/main.js` (bin;
workspace packages + chevrotain + zod bundled, `vscode-languageserver*` left as runtime
dependencies). Never writes to stdout except the JSON-RPC stream.
