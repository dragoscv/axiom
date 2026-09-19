/**
 * Static vocabulary of `.axm` v2 (docs/syntax_spec.md) as the LSP needs it: keyword docs,
 * value sets and the built-in predicate ids with one-line descriptions.
 *
 * The predicate list mirrors `BUILTIN_PREDICATES` in `@codai/axiom-checks`; a test asserts
 * parity against `builtinRegistry().list()` so the two cannot drift silently (the LSP must not
 * depend on `checks` at runtime — it would drag zod + fact providers into the editor process).
 */

export interface KeywordDoc {
  /** Nesting depth at which the keyword starts a statement: 0 = file, 1 = plan body, 2 = artifact body. */
  depth: 0 | 1 | 2;
  /** Markdown shown on hover / as completion detail. */
  doc: string;
  /** Snippet inserted on completion (LSP snippet syntax). */
  snippet: string;
}

export const KEYWORDS: Readonly<Record<string, KeywordDoc>> = {
  axiom: {
    depth: 0,
    doc: 'File header — `axiom "2"`. Exactly once, first statement.',
    snippet: 'axiom "2"',
  },
  plan: {
    depth: 0,
    doc: "`plan NAME { … }` — the single plan of the file. `NAME` must match `^[a-z0-9][a-z0-9-]{0,63}$`.",
    snippet: 'plan ${1:name} {\n\tintent "${2}"\n\t$0\n}',
  },
  intent: {
    depth: 1,
    doc: '`intent "…"` — required, once. Human-readable purpose of the plan (≤ 2000 chars).',
    snippet: 'intent "${1}"',
  },
  profile: {
    depth: 1,
    doc: "`profile NAME` — check profile (`default`, `strict`, `permissive`). Once; `default` when omitted.",
    snippet: "profile ${1|default,strict,permissive|}",
  },
  capabilities: {
    depth: 1,
    doc: "`capabilities [fs, net, …]` — declared capability set, no duplicates. Once; `[]` when omitted.",
    snippet: "capabilities [${1|fs,net,secret,ai,compute,git|}]",
  },
  artifact: {
    depth: 1,
    doc: '`artifact "path" { mode … op … source }` — one file the plan writes or deletes. Paths are unique.',
    snippet: 'artifact "${1:path}" {\n\top ${2|create,overwrite,delete|}\n\t$0\n}',
  },
  check: {
    depth: 1,
    doc: "`check ID using group.predicate { …params }` — a predicate the gate evaluates on the manifest.",
    snippet: "check ${1:id} using ${2:predicate} {$0}",
  },
  using: {
    depth: 1,
    doc: "`using group.predicate` — names the predicate of a `check`; params follow as a JSON object.",
    snippet: "using ",
  },
  meta: {
    depth: 1,
    doc: "`meta {…}` — free-form JSON object copied to `Plan.metadata`. Once.",
    snippet: "meta {$0}",
  },
  mode: {
    depth: 2,
    doc: "`mode 0644 | 0755` — target file mode. `0644` when omitted.",
    snippet: "mode ${1|0644,0755|}",
  },
  op: {
    depth: 2,
    doc: "`op create | overwrite | delete` — write operation. `create` when omitted.",
    snippet: "op ${1|create,overwrite,delete|}",
  },
  inline: {
    depth: 2,
    doc: "`inline <<TERM … TERM` — UTF-8 content as a heredoc. Terminator alone on its line at column 1.",
    snippet: "inline <<${1:EOF}\n$0\n${1:EOF}",
  },
  template: {
    depth: 2,
    doc: '`template emitter.name "template" {…}` — rendered at compile time by a registered emitter (e.g. `web.next-page` from @codai/axiom-emitters-web); the JSON object is the template `params`.',
    snippet: 'template ${1:emitter} "${2:template}" {$0}',
  },
  patch: {
    depth: 2,
    doc: '`patch unified|v4a|search-replace "sha256:<pre-image>"|absent <<TERM … TERM` — a diff applied at compile time to the file under the root, which must hash to the pre-image; exact matching only (D-17).',
    snippet: "patch ${1|unified,v4a,search-replace|} ${2:absent} <<${3:EOF}\n$0\n${3:EOF}",
  },
  cas: {
    depth: 2,
    doc: '`cas "sha256:<64 hex>"` — content addressed from the `.axiom/cas` store.',
    snippet: 'cas "sha256:${1}"',
  },
  ref: {
    depth: 2,
    doc: '`ref "uri" "sha256:<64 hex>"` — digest-pinned `file:` or `https:` reference.',
    snippet: 'ref "${1:uri}" "sha256:${2}"',
  },
};

export const CAPABILITIES: readonly string[] = ["fs", "net", "secret", "ai", "compute", "git"];
export const OP_VALUES: readonly string[] = ["create", "overwrite", "delete"];
export const MODE_VALUES: readonly string[] = ["0644", "0755"];
export const PROFILE_VALUES: readonly string[] = ["default", "strict", "permissive"];

/** Built-in predicate ids → one-line docs. Kept in parity with `@codai/axiom-checks`. */
export const PREDICATES: Readonly<Record<string, string>> = {
  "path.allow": "Every artifact path must match at least one of `globs`.",
  "path.deny": "No artifact path may match any of `globs`.",
  "path.reservedNames": "Reject Windows-reserved and otherwise unsafe file names.",
  "content.noSecrets": "Fail when inline content matches a known secret pattern (keys, tokens).",
  "content.maxBytes": "Every inline blob must be at most `max` bytes.",
  "content.encodingUtf8": "Inline content must be valid UTF-8.",
  "manifest.maxArtifacts": "The manifest may contain at most `max` artifacts.",
  "manifest.maxTotalBytes": "Sum of blob sizes must be at most `max` bytes.",
  "manifest.requireSigned":
    "≥ `minSignatures` valid DSSE signatures from `.axiom/trust/keys.json`; `antiRollback` enforces `counter` > last accepted.",
  "manifest.noDeletes": "No artifact may use `op delete`.",
  "deps.max": "A dependency manifest may declare at most `max` dependencies.",
  "deps.deny": "Reject dependencies matching `patterns`.",
  "repo.noOverwriteOf": "Existing files matching `globs` may not be overwritten.",
  "repo.requireCompanion":
    "When a path matches `when`, a companion matching `expect` must exist (in the plan or the repo; `mustChange: true` = in the plan).",
  "guard.external": "Run an allow-listed external guard script (JSON stdout contract).",
  "expr.cel":
    "A boolean CEL `expression` over `manifest`, `artifacts`, `content`, `repo` (pure, allow-listed).",
};

export const PREDICATE_IDS: readonly string[] = Object.keys(PREDICATES).sort();
