---
"@codai/axiom-checks": minor
---

feat(checks): add `repo.requireReference` predicate — content-level ripple.

`repo.requireCompanion` only proves a companion _path_ exists. Real ripple
rules are about content: a new MCP tool must be listed in `spec/tools.json`,
a new marketing page in the sitemap, a new gateway route in the SDK. Any of
those can drift with the companion file untouched and `requireCompanion`
green.

- `rules[]: { name, when: glob, in: relpath, mustContain: template, mustChange?,
jsonPointer? }`. For every artifact matching `when`, the companion `in`
  (plan blob first, then the repo unless `mustChange`) must contain the
  rendered template — `${path}`, `${basename}`, `${dirname}` of the
  triggering artifact.
- `jsonPointer` (RFC 6901) parses `in` as JSON and checks the pointed value:
  string → substring, array → member equality, object → own key.
- Finding id `repo.requireReference.<name>`, `path` = the triggering
  artifact, `facts: { in, expected, source: "plan" | "repo" | "absent" }`.
- Fails closed (`ERR_PROVIDER_FAILED`, `verdict: error`) when the companion
  exists but is unreadable, is not UTF-8, is not JSON while `jsonPointer` is
  set, or the pointer does not resolve to something that can contain a string.
- A plan `delete` of the companion counts as absent — the repo copy is not
  consulted, because after apply it will be gone.

18 built-ins now; `axm-lsp` vocabulary gains the entry.
