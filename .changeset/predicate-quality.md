---
"@codai/axiom-checks": minor
"@codai/axiom-axm-lsp": patch
---

Predicate quality (S-408).

- `content.noSecrets` `card`: a digit run is a PAN only when it passes Luhn, is
  not a single repeated digit and is not part of a UUID — zero/placeholder UUIDs
  (`00000000-0000-0000-0000-000000000000`), epoch-ms timestamps and sequential
  placeholders no longer fail the check; every real test PAN is still caught.
- `repo.requireCompanion` gains `expect[].mustChange: true`: the companion must
  be in the plan, an existing repo file no longer satisfies the rule.
- Every glob parameter auto-escapes Next.js route groups (`app/(app)/**`
  matches the literal directory); real extglobs and `\(app\)` are untouched.
- `guard.external` attaches `facts.evidence = { exitCode, stdout, stderr }`
  (2 KiB tails) to every finding it produces, including `ERR_GUARD_OUTPUT` /
  `ERR_GUARD_TIMEOUT` (which previously used ad-hoc `exitCode`/`stdout`/`stderr`
  facts).
