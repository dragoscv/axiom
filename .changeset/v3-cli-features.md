---
"@codai/axiom-mcp": major
---

3.0 CLI and features (D-43, D-45, S-1309..S-1316):

- Noun command groups from one command table (`plan`, `journal`, `keys`, `hook`, `setup`) with the old verbs as hidden aliases until 4.0; per-command `--help`; usage errors print only the command's usage (`ERR_USAGE`); missing files are `ERR_NOT_FOUND`, malformed plans `ERR_INVALID_PLAN` with line/column; ASCII-only human output; `axgate` second bin.
- New commands: `axiom explain`, `axiom setup suggest-profile`, `axiom setup doctor --fleet`, `axiom journal replay`, `axiom report` (self-contained HTML), `axiom pin [--check]` (MCP config pinning), `axiom acp-proxy`, `axiom setup migrate --profile`, `axiom setup init --dry-run`, `axiom gc --decisions-older-than`.
- Decision journal: stable `id`, `enforced`, `profile_decided`; secrets in `command` / `override_reason` / `reason` redacted; the username is hashed unless `AXIOM_JOURNAL_USERNAME=1`.
- Session budget rule (`sessions.budget`), outside-root writes captured for `axiom undo`, doctor reads the real hook timeout, checks node on PATH and flags protocol-1 daemons.
