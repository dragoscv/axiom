# Repo snapshots — `axiom_repo_snapshot` / `axiom snapshot`

A **RepoSnapshot** is a deterministic, content-addressed inventory of a root: what files exist,
how big they are, what they hash to. It is the read-side counterpart of a `Manifest` — where a
manifest says *what will be written*, a snapshot says *what is there now*.

Story S-304. It replaces the v1 `reverse-ir` tool.

## Why (and why not v1 reverse-IR)

Agents need two things before they can write safely through the gate:

1. **Real pre-image digests.** A Plan that overwrites `src/a.ts` should be built against the
   sha256 of the `src/a.ts` that actually exists, so `apply` can refuse when the file changed
   underneath (the TOCTOU guard re-verifies pre-images at commit).
2. **A cheap way to see what changed** between two points in time — after an apply, after a
   rollback, between two machines — without diffing content.

The v1 `reverseIR` did neither. It scanned only `./out/`, guessed "service types" from
`package.json` and `Dockerfile` names, emitted hard-coded constraints, defaulted `repoPath` to the
server's `cwd`, hashed nothing, had no `.gitignore` awareness, no sort guarantee and no tests. A
snapshot records facts, not guesses, and is bound to an allowlisted root.

## Output

```jsonc
{
  "apiVersion": "axiom.dev/v2",
  "kind": "RepoSnapshot",
  "root": { "kind": "relative" },          // the root itself is never recorded
  "snapshotDigest": "sha256:…",           // sha256(JCS(body))
  "body": {
    "files": [                             // sorted by compareUtf8(path)
      { "path": "src/a.ts", "bytes": 19, "sha256": "…", "mode": "0644", "kind": "file" },
      { "path": "alias",    "bytes": 19, "sha256": "…", "mode": "0644", "kind": "symlink" }
    ],
    "truncated": false,
    "counts": { "files": 2, "bytes": 38 }
  }
}
```

Schema: `RepoSnapshotSchema` in `@codai/axiom-schema` (`packages/schema/schemas/RepoSnapshot.schema.json`,
`axiom schema RepoSnapshot`, resource `axiom://schema/RepoSnapshot`).

- `path` is a `RelPath` (relative POSIX, NFC, no reserved names). Entries whose name cannot be
  represented as a `RelPath` (e.g. a trailing space on POSIX) are **not** inventoried.
- `mode` is `0755` when the owner-execute bit is set on POSIX, else `0644`. Windows always reports
  `0644` — a tree snapshotted on Windows and on Linux differs only if it contains executables.
- `kind: "symlink"` — the link is recorded at its own path. Its target is hashed **only** when the
  link resolves to a regular file *inside* the root; otherwise (`outside`, dangling, directory)
  `bytes: 0` and no `sha256`. Symlinks are never followed into directories, so a link cannot make
  the walk leave the root or loop.
- `sha256` is absent when `withContentDigest: false` (sizes only — fast on huge trees).

## Invariants

- **No timestamps, no absolute paths** (PLAN.md §2 invariant 1). The same tree yields the same
  `snapshotDigest` on every machine and every run; adding, removing or editing one file changes it.
- **Root containment.** `root` must equal or lie inside an allowlisted `--root`. Globs are validated
  as contained relative paths once wildcards are stripped: `../**` or `/etc/*` → `ERR_CONTAINMENT`.
- **Always skipped:** `.git/` and `.axiom/` (whatever `.gitignore` says).
- **`.gitignore`:** the root file only, negations (`!`) dropped, same rough translation the check
  facts use (`name` → any depth, `dir/` → everything below). Nested `.gitignore` files are not read.
- **Read-only.** The tool is annotated `readOnlyHint: true`; it never spawns a process and writes
  nothing, not even under `.axiom/`.

## Determinism and truncation

The walk visits directory entries in `compareUtf8` order of their relative path (directories keyed
with a trailing `/`), which is exactly the final sort order. So when `maxFiles` or `maxBytes` stops
the walk, `truncated: true` and `files` is the first *N* paths of the full sorted inventory — two
truncated runs with the same limits are identical, and a truncated snapshot is a prefix of the
full one.

Limits: `maxFiles` default 20 000, hard cap 50 000; `maxBytes` default 64 MiB (sum of `bytes`, not
of the JSON). A snapshot of a large monorepo is meant to be scoped with `include` (`["apps/web/**"]`)
rather than taken whole.

## Globs

`include` keeps matching files (default: everything), `exclude` drops them (applied to directories
too, so `exclude: ["vendor/**"]` prunes the walk). Syntax is deliberately tiny and dependency-free:
`**` (any depth), `*` (within a segment), `?`, literal. No braces, no negation, no character classes.

## Diff

`diffSnapshots(a, b)` (exported from `@codai/axiom-mcp`'s `snapshot.ts`) and `axiom snapshot-diff
a.json b.json` return `{ added[], removed[], changed: [{ path, from, to }] }` — pure, sorted, keyed
by path. `changed` compares `sha256` when both sides have one, else `bytes` + `kind`; a `mode` or
`kind` change also counts. There is deliberately no MCP diff tool: an agent that holds two snapshots
can diff them locally, and `axiom_manifest_diff` already covers manifests.

## CLI

```
axiom snapshot --root <dir> [-o snap.json] [--include <glob>]... [--exclude <glob>]...
               [--max-files n] [--max-bytes n] [--no-gitignore] [--no-digest]
axiom snapshot-diff <a.json> <b.json>
```

With `-o` the file gets the full snapshot and stdout a one-line summary
(`{ snapshotDigest, files, bytes, truncated, out }`); without it the snapshot is printed.

## Typical flow

```
axiom snapshot --root . -o before.json --include "src/**"
# … agent builds a Plan whose overwrite artifacts cite before.json sha256 values …
axiom apply bundle.json --root . --confirm sha256:…
axiom snapshot --root . -o after.json --include "src/**"
axiom snapshot-diff before.json after.json     # exactly the manifest's paths, nothing else
```
