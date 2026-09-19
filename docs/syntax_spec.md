# `.axm` syntax — v2

`.axm` is the human-writable front-end of AXIOM v2. A file compiles **1:1** into a
[`Plan`](plan-format.md) (`apiVersion: axiom.dev/v2, kind: Plan`); nothing expressible in `.axm` is
outside `PlanSchema`, and every `Plan` with `inline`/`cas`/`ref` sources has a canonical `.axm`
form (`formatAxm`). The parser is `@codai/axiom-axm` (Chevrotain 13); the MCP tool is
`axiom_axm_parse`; the CLI accepts `axiom compile plan.axm`. The v1 grammar
(`agent "…" { … }`) is archived at `archive/v1/syntax_spec-v1.md` and is not accepted.

## Grammar (EBNF)

```ebnf
File        = Header, { Statement } ;
Header      = "axiom", Version ;                      Version = '"2"' ;
Statement   = PlanDecl ;                              (* exactly one per file *)
PlanDecl    = "plan", Ident, "{", { PlanItem } "}" ;
PlanItem    = "intent", String                        (* required, once *)
            | "profile", Ident                        (* default "default", once *)
            | "capabilities", "[", [ Cap { "," Cap } ], "]"   (* once; no duplicates *)
            | "artifact", String, ArtifactBody        (* ≥ 1; paths unique *)
            | "check", Ident, "using", QualIdent, [ Json ]
            | "meta", Json ;                          (* JSON object, once *)
Cap         = "fs" | "net" | "secret" | "ai" | "compute" | "git" ;
ArtifactBody= "{", { "mode", ("0644"|"0755") | "op", ("create"|"overwrite"|"delete") | Source }, "}" ;
Source      = "inline", HereDoc | "template", QualIdent, String, [ Json ] | "cas", Digest | "ref", String, Digest ;
HereDoc     = "<<", Ident, NEWLINE, { ANY }, NEWLINE, Ident ;
QualIdent   = Ident, { ".", Ident } ;          Digest = '"sha256:' 64*HEXDIG '"' ;
Ident       = ? [A-Za-z0-9_][A-Za-z0-9_-]* ? ; String = ? JSON string ? ;
Json        = ? RFC 8259 object or array ? ;   Comment = "//" … EOL | "/*" … "*/" ;
```

Whitespace and comments are insignificant except inside a `HereDoc`. Keywords are also valid
where `Ident` is expected (`plan check { … }` names a plan `check`).

## Semantics

| Syntax | `Plan` field | Notes |
|---|---|---|
| `plan NAME` | `name` | must match `^[a-z0-9][a-z0-9-]{0,63}$` (schema) |
| `intent "…"` | `intent` | ≤ 2000 chars |
| `profile NAME` | `profile` | `default` when omitted |
| `capabilities [a, b]` | `capabilities` | `[]` when omitted |
| `artifact "p" { … }` | `artifacts[]` | `mode` → `"0644"` default, `op` → `"create"` default |
| `inline <<T … T` | `source: {type:"inline", encoding:"utf8", content}` | see heredoc rules |
| `cas "sha256:…"` | `source: {type:"cas", digest}` | |
| `ref "uri" "sha256:…"` | `source: {type:"ref", uri, digest}` | `file:`/`https:` only |
| `template e.m "t" {…}` | `source: {type:"template", emitter, template, params}` | rendered at compile time by a registered emitter (see [emitters.md](emitters.md)) |
| `check ID using g.name {…}` | `checks[]: {id, predicate, params, severity:"error"}` | params default `{}`; unknown predicate ids are accepted here — the checks registry decides at runtime |
| `meta {…}` | `metadata` | `{}` when omitted |

Errors (all `severity: "error"`, closed `ERR_*` codes, 1-based `{line, column}` ranges):
lexer errors (stray characters, unterminated heredoc — reported at `<<`), parser errors
(Chevrotain's *Expecting token of type …* message at the offending token, or *at end of input*
positioned after the last token), semantic errors (duplicate `intent`/`profile`/`capabilities`/
`meta`, unknown or duplicate capability, duplicate artifact path, two sources in one artifact,
`mode` not `0644|0755`, invalid JSON in `meta`/params) and every `PlanSchema` issue mapped back to
the source range of the item that produced it (`../x` → `ERR_PATH_SEGMENT` at the path literal).

## Heredoc rules

- `<<TERM` must be followed directly by a newline; `TERM` is an `Ident` starting with a letter or `_`.
- The block ends at the first line that is **exactly** `TERM` (column 1, no trailing spaces; a
  trailing `\r` is tolerated). `TERM` appearing elsewhere in the content is plain text.
- Content = the bytes between the two newlines with **CRLF normalised to LF**; the newline before
  the terminator is **not** part of the content. So `<<EOF\nEOF` is `""`, `<<EOF\nx\nEOF` is `"x"`,
  and a file that must end in `\n` needs an empty line before the terminator (`<<EOF\nx\n\nEOF` →
  `"x\n"`).
- Braces, quotes, `//`, `/*` inside the block are raw bytes. Only `encoding: utf8` inline sources
  have an `.axm` form; base64 sources stay in JSON.

## Canonical form (`formatAxm`)

`axiom "2"`, blank line, `plan NAME {`, then `intent`, `profile`, `capabilities` (always written,
even when default), each artifact as `artifact "p" {` / `mode` / `op` / source / `}`, then checks,
then `meta`, then `}`. 2-space indent, LF, JSON via `JSON.stringify` without whitespace, heredoc
terminator `EOF` (or `EOF_1`, `EOF_2`, … when a content line equals it), content and terminator at
column 1. `parseAxm(formatAxm(p)).plan` deep-equals `p` for every valid `Plan` (property-tested,
200 runs).

## Example

```axm
axiom "2"

plan notes-app {
  intent "Scaffold a notes CLI with a README and drop the legacy shim"
  profile strict
  capabilities [fs]

  artifact "src/notes.ts" {
    mode 0644
    op create
    inline <<TS
export interface Note { id: string; body: string }
TS
  }

  artifact "bin/notes" {
    mode 0755
    cas "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  artifact "legacy/shim.js" { op delete }

  check no-secrets using content.noSecrets {}
  check readme-with-src using repo.requireCompanion {"rules":[{"when":"src/**","expect":[{"name":"readme","match":"README.md"}]}]}

  meta {"ticket":"S-204"}
}
```

The full fixture and its compiled `Plan` live in `packages/axm/examples/notes.axm` /
`notes.plan.json` and are pinned by the golden test.

## Editor support

`@codai/axiom-axm-lsp` is a Language Server Protocol 3.18 implementation for `.axm` that reuses
`parseAxm` / `formatAxm` — the editor and the gate share one grammar (PLAN.md D-14; rationale in
`packages/axm-lsp/README.md`).

```
npx @codai/axiom-axm-lsp --stdio      # any LSP client (neovim, helix, zed, emacs, …)
```

| Capability | What you get |
|---|---|
| diagnostics | the same `ERR_*`-coded errors `axiom compile` reports, at 0-based LSP ranges, `source: axm` |
| completion | predicate ids after `using`, capability names inside `capabilities [ ]`, `mode`/`op`/`profile` values, keyword snippets valid at the current nesting level |
| hover | keyword docs; predicate docs on `using group.name` |
| document symbols | plan → artifacts + checks (outline / breadcrumbs) |
| formatting | canonical form (`formatAxm`) — applied only when the file parses without diagnostics |
| semantic tokens | `keyword`, `string`, `number`, `comment`, `property` |

**VS Code**: the private extension `packages/vscode-axm` (`codai.axiom-axm`) bundles the client, a
TextMate grammar (heredocs, digests, embedded JSON) and `language-configuration.json`. Run it with
*Run Extension* (F5), or build a .vsix with `pnpm --filter axiom-axm run package` →
`.copilot-tmp/axiom-axm-<version>.vsix`, then `code --install-extension <file>.vsix`.
