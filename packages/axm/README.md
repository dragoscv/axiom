# @codai/axiom-axm

The `.axm` v2 front-end for AXIOM: a Chevrotain 13 lexer + CST parser that compiles the DSL
**1:1** into a `PlanSchema`-validated `Plan`, plus the deterministic inverse printer.

```ts
import { formatAxm, parseAxm } from "@codai/axiom-axm";

const { plan, diagnostics } = parseAxm(source); // never throws
// diagnostics: { severity, code: ERR_*, message, range: { start: {line, column}, end } }[]
if (plan) console.error(formatAxm(plan) === source); // canonical form roundtrips
```

`plan` is present only when there are no error diagnostics. Positions are 1-based. CRLF input is
normalised to LF before lexing (heredoc contents included). Full semantics: `docs/syntax_spec.md`.

## Grammar

```ebnf
File        = Header, { Statement } ;
Header      = "axiom", Version ;                      Version = '"2"' ;
Statement   = PlanDecl ;
PlanDecl    = "plan", Ident, "{", { PlanItem } "}" ;
PlanItem    = "intent", String
            | "profile", Ident
            | "capabilities", "[", [ Cap { "," Cap } ], "]"
            | "artifact", String, ArtifactBody
            | "check", Ident, "using", QualIdent, [ Json ]
            | "meta", Json ;
Cap         = "fs" | "net" | "secret" | "ai" | "compute" | "git" ;
ArtifactBody= "{", { "mode", ("0644"|"0755") | "op", ("create"|"overwrite"|"delete") | Source }, "}" ;
Source      = "inline", HereDoc | "template", QualIdent, String, [ Json ] | "cas", Digest | "ref", String, Digest ;
HereDoc     = "<<", Ident, NEWLINE, { ANY }, NEWLINE, Ident ;
QualIdent   = Ident, { ".", Ident } ;          Digest = '"sha256:' 64*HEXDIG '"' ;
Json        = ? RFC 8259 object or array ? ;   Comment = "//" … EOL | "/*" … "*/" ;
```

Heredoc: the terminator must be alone on its line at column 1; the content excludes the newline
before it (`<<EOF\nEOF` → `""`; add an empty line for a trailing `\n`). `formatAxm` uses `EOF`,
or `EOF_n` when a content line equals the terminator.

## Example (`examples/notes.axm`)

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

  meta {"ticket":"S-204","tags":["example","golden"]}
}
```

`examples/notes.plan.json` is the compiled `Plan`, pinned by the golden test.

## Errors

Every diagnostic carries a code from the closed `ERROR_CODES` enum — lexer/parser/semantic
errors are `ERR_INVALID_PLAN`; schema issues keep their own code (e.g. `ERR_PATH_SEGMENT`).
Unknown predicate ids are **not** an error here — the checks registry decides at runtime.

## Integration

MCP: `axiom_axm_parse { source } → { plan?, diagnostics[] }` (read-only). CLI:
`axiom compile plan.axm` parses first and exits 2 with the diagnostics as JSON on any error. Both
load this package lazily so the CLI cold start and bundle budget are unaffected.

Depends only on `@codai/axiom-schema` and `chevrotain`.
