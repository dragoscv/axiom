---
"@codai/axiom-mcp": major
"@codai/axiom-apply": major
"@codai/axiom-plan": major
"@codai/axiom-checks": major
"@codai/axiom-canon": major
"@codai/axiom-schema": major
---

Security hardening from the 2026-10-19 reality check (D-41, S-1301..S-1308, S-1313):

- **Gate.** One shell lexer (`shell-lex.ts`) splits on newlines, strips quotes and PowerShell backticks, folds git global options and decodes `-EncodedCommand`. Force push, reset --hard, clean -f and worktree remove --force are detected semantically (`-uf`, `+refspec`, `--mirror`, `git -C . push -f`, ...). New `house.pushDelete`, `house.stashDrop`, `house.undecodable`. Every command rule is evaluated: a hard code wins regardless of order. Whole-tree `git clean` / `reset --hard` is `git.destructiveTree` (hard when reset/clean are) and is judged before containment. Globs are case-insensitive on Windows/macOS, 8.3 short names are refused, `\\?\` system paths are recognised.
- **Overrides.** `axiom-override: <reason>` is read only from explanation/goal/description/reason or a trailing shell comment outside quotes and heredocs; never from file content or an apply_patch body; the reason needs ≥ 3 words and ≥ 12 letters. Every relaxed decision is journaled.
- **Profiles.** Unknown keys warn instead of denying; `version` newer than the binary → `ERR_PROFILE_VERSION`; broken profiles → `ERR_INVALID_PROFILE`; profile errors are never covered by `--fail-open`. A linked worktree inherits the main clone's profile when its own is missing or older. `axiom init` writes enforce + the house pack + four hard codes.
- **Daemon protocol 2.** Mandatory per-start key, HMAC-signed responses, nonce, no bearer, argv allowlist, payload roots checked after normalisation, bounded body; protocol-1 clients get 426 and spawn.
- **Apply.** `.axiom/` is reserved under any case / NFC / 8.3 / junction alias (`ERR_PATH_RESERVED_DIR`); journal backup paths are contained (`ERR_JOURNAL_CORRUPT`); rollback is a no-op on an already rolled-back digest, refuses drift (`ERR_PREIMAGE_CHANGED`, `force`) and missing backups (`ERR_ROLLBACK`); dry-run writes nothing.
- **Plan / checks.** A `ref` CAS hit is re-hashed (`casGetUnverified` is the raw reader); pre-image and repo-fact reads no longer follow junctions out of the root.
- **Misc.** Empty stdin allows with a warning (oversize stays fail-closed); JSON parse errors never echo the payload; `noSecretsExclude` for PII-class findings; `create_and_run_task` is scanned; rename/move/mkdir tools are writes; Claude denies emit only `hookSpecificOutput`; Junie gets `ask`; new `kiro` format.
