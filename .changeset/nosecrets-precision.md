---
"@codai/axiom-checks": minor
"@codai/axiom-mcp": minor
---

`content.noSecrets`: PII patterns become opt-in and every pattern gets
corpus-derived precision (S-414).

Replaying the recent commits of 30 OSS repositories through the `default`
profile (the codai SWE-harness write gate) rejected real, harmless edits: 110 of
3240 files matched `email` (maintainer addresses in `pyproject.toml`,
`git@github.com`, `user@example.com`) and 107 matched `credentialAssignment`
(`token: str`, `token = var.set(...)`, `token: write`).

- **checks**: new param `pii: boolean` (default `false`). `cnp`, `email`,
  `phoneRo`, `card` run only with `pii: true`; `credentialAssignment`, `awsKey`,
  `githubToken`, `privateKey`, `jwt`, `slackToken` always run.
  `credentialAssignment` now requires a quoted literal ≥ 8 chars and skips
  placeholders/interpolations/identifier-shaped values (9/3240 corpus files
  left, all real quoted credentials in tests/READMEs); `email` skips RFC
  2606/6761 domains, `*@github.com`, `git@`/`noreply@` and asset
  pseudo-addresses; `cnp` validates month/day/county and the mod-11 control
  digit. `SECRET_PATTERNS[i].kind` (`"secret" | "pii"`) and
  `PII_PATTERN_NAMES` exported.
- **mcp**: gate profile gains `pii: boolean` (default `false`), forwarded to
  `content.noSecrets`.

**Behaviour change**: a profile that relied on `params: {}` catching e-mails,
CNPs, Romanian phone numbers or card numbers must set `pii: true` (brivio and
metu profiles updated alongside this release).
