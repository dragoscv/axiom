---
"@codai/axiom-schema": minor
"@codai/axiom-mcp": minor
---

`axiom_repo_snapshot` — deterministic, content-addressed inventory of a root (PLAN.md S-304) —
see `docs/snapshot.md`. Successor of the v1 `reverse-ir`.

- **schema**: `RepoSnapshotSchema` (`{ apiVersion, kind: "RepoSnapshot", root: { kind: "relative" },
  snapshotDigest, body: { files: [{ path, bytes, sha256?, mode, kind: "file"|"symlink" }],
  truncated, counts: { files, bytes } } }`), `RepoSnapshotBodySchema`, `RepoSnapshotEntrySchema`.
  `schemas/RepoSnapshot.schema.json` emitted.
- **mcp**: READ tool `axiom_repo_snapshot { root?, include?, exclude?, maxFiles? (20000, cap 50000),
  maxBytes? (64 MiB), respectGitignore?, withContentDigest? }` → `RepoSnapshot` with
  `snapshotDigest = sha256(JCS(body))`; no timestamps or absolute paths, files sorted by
  `compareUtf8`, `.git/` and `.axiom/` always skipped, root `.gitignore` honoured, symlinks recorded
  but never followed (target hashed only when inside the root), globs containing `..` →
  `ERR_CONTAINMENT`. Truncated results are a deterministic sorted prefix. CLI verbs
  `axiom snapshot --root <dir> [-o] [--include] [--exclude] [--max-files] [--max-bytes] [--no-gitignore]
  [--no-digest]` and `axiom snapshot-diff <a.json> <b.json>` (pure `diffSnapshots` →
  `{ added, removed, changed }`). `axiom schema RepoSnapshot` and `axiom://schema/RepoSnapshot`.
  The server now exposes 11 tools.
