# Coordination and git-state rules

Several agents often share one clone. Two gate rule modules let `axiom gate` honour that:

- **Coordination** (`packages/mcp/src/coord.ts`, S-1212) — a generic **file protocol** through
  which an external coordinator tells the gate which resource classes are frozen (*marks*), which
  worktree slots are in use (*leases*), and which commands must go through a queue wrapper.
- **Git-state facts** (`packages/mcp/src/gitfacts.ts`, S-1213) — clean tree, pathspec-only
  commits and branch rules, read straight from `.git` without spawning `git`.

Both are configured in `.axiom/gate-profile.json` under the keys `"coordination"` and `"git"`.
For a concrete mapping see [agentq](../integration/agentq.md).

## Rule ids

| id | when |
|---|---|
| `coord.frozen` | a mark in state `frozen`/`blocked` covers the command's class for this repo |
| `coord.leased` | the command deletes a leased slot root, or recursively deletes its parent / `slotsRoot` |
| `coord.queueRequired` | the command's class must go through a wrapper and the command does not mention it |
| `git.noPathspec` | `requirePathspec` and a `git commit` at command position has no ` -- <path>` |
| `git.dirtyTree` | the command's class is in `cleanTreeFor` and the tree is dirty (or cannot be proven clean) |
| `git.branch` | the command's class is in `branch.for` and the current branch does not match `branch.is` |

Every verdict carries a `reason` and, where one exists, a `fix` (the sanctioned command).

## Command classes

A command belongs to zero or more classes:

| class | matches (case-insensitive) |
|---|---|
| `build` | `pnpm\|npm\|yarn\|turbo\|next\|tsc\|cargo\|gradle(w)` … `build\|typecheck\|test`, `run-build.ps1` |
| `install` | `pnpm\|npm\|yarn install\|i\|ci\|add\|remove` |
| `commit` | `git … commit\|push` at command position |
| `deploy` | `deploy-*.ps1\|mjs`, `scripts/deploy.mjs`, `gcloud run\|builds …`, `vercel`, `docker build\|buildx build\|push`, `fly deploy`, `wrangler deploy\|publish`, `terraform apply`, `pulumi up`, `cargo publish`, `cargo tauri build`, `npm\|pnpm publish`, `twine upload`, `hatch publish`, `gradle(w) assembleRelease\|bundleRelease\|publish`, `scripts/ops/deploy-*.ps1` |

## File protocol

### Marks

One JSON object per file in `marksDir` (`*.json`, any name):

```json
{
  "resource": "build:axiom",
  "state": "frozen",
  "reason": "incident: CI red since 08:12Z",
  "at": "2026-10-14T08:12:00Z",
  "session": "copilot-7f3a"
}
```

**Resource grammar:** `kind[:repo[:target]]`

- `kind` ∈ `build | install | commit | deploy`.
- `repo` absent, empty or `machine` → every repo; otherwise compared (case-insensitively) with the
  current repo name: the leaf of the parent of the git common dir, lowercased (`E:\gh\codai\.git`
  → `codai`, also from any linked worktree), or the profile's `coordination.repo` override.
- `target` (deploy only): the mark refuses only commands whose text contains `target`, unless the
  target is `any`.
- `state`: only `frozen` and `blocked` refuse; anything else (`clear`, …) is ignored.

### Leases

One JSON object per slot at `leasesDir/<repo>/<slot>.json`:

```json
{
  "path": "E:\\gh\\.wt\\codai\\task-1",
  "leaseId": "8b4070ff",
  "session": "copilot-7f3a",
  "purpose": "feat: cards provenance"
}
```

Without `path`, the slot is `slotsRoot/<repo>/<slot>`. Only **delete-class** commands are judged
(`Remove-Item|rm|rmdir|rd|del|ri|erase`, `git worktree remove|move|prune`, `Directory.Delete`,
`rmSync`, `rimraf`), statement by statement (split on `;`, `&&`, `||`, newline):

- naming the slot **root** is refused (deleting files *inside* the slot stays allowed for the holder);
- naming the slot's parent or `slotsRoot` **with a recursive flag** (`-Recurse`, `-r`, `-rf`, `/s`,
  `recursive`) is refused;
- commands mentioning `worktree.ps1`, `agentq.ps1` or `deploy-clean.ps1` are allowed — those tools
  check the lease themselves.

### Failure semantics

The evaluate functions never throw. A configured directory that **does not exist** → no opinion
(`undefined`). Any other read failure (an unreadable or non-object JSON file, a mark without
`resource`, a lease without `path` and no `slotsRoot`) → **fail closed** with the rule's id and a
reason saying the state could not be read. Lease files are read only for delete-class commands.

## Profile keys

```jsonc
{
  "coordination": {
    "marksDir": "~/.codai/coord/marks",        // "~" and ${env:NAME} / ${env:NAME:-fallback} expand
    "leasesDir": "~/.codai/coord/leases",
    "slotsRoot": "${env:CODAI_WT_ROOT:-E:/gh/.wt}",
    "exemptVia": ["agentq\\.ps1"],             // regex sources; a match skips all coord rules
    "queueRequired": [
      { "class": "build", "via": "run-build\\.ps1|agentq\\.ps1", "fix": "…" }
    ],
    "repo": "codai"                            // optional repo-name override
  },
  "git": {
    "cleanTreeFor": ["deploy"],                // classes that need index == HEAD and worktree == index
    "untracked": false,                        // also count untracked files (approximate)
    "requirePathspec": true,                   // git.noPathspec
    "branch": { "is": "release/*", "for": ["deploy"], "reason": "deploy from release branches" }
  }
}
```

Both objects are strict: an unknown key is a profile error. Regex sources are capped at 500 chars
and must compile.

`git.noPathspec` accepts ` -- <path>` in the commit statement, `--amend`, `--allow-empty`,
`commit-tree`, or any command mentioning `agentq.ps1`. `git.dirtyTree` never fires for a command
mentioning `deploy-clean.ps1` (it builds from its own detached checkout). `branch.is` is an exact
name or a `*` glob (`*` matches across `/`); a detached HEAD never matches.

## The no-spawn git reader and its limits

`gitfacts.ts` reads `.git` from disk: the hook budget (p50 ≈ 100 ms per tool call) and the
no-shell invariant both rule out spawning `git`.

- **Git dirs**: `.git` directory, or a `.git` file (`gitdir: …`). A linked worktree must carry a
  back-link (`<gitdir>/gitdir`) naming this very `.git` file; a forged `.git` file is "not a repo".
- **HEAD**: symbolic ref → loose ref (per-worktree dir, then common dir) → `packed-refs`; or a
  detached sha.
- **Index**: DIRC v2, v3 (extended flags) and v4 (path-prefix compression); SHA-1 and SHA-256
  repositories (`extensions.objectformat`). Entries flagged *skip-worktree* or *assume-unchanged*
  and gitlinks (submodules) are not compared. A conflicted (stage ≠ 0) or intent-to-add entry is
  dirty. A **split index** (`link` extension) is unsupported → read error → fail closed.
- **Worktree vs index**: `lstat` each entry; when size and mtime (s, ns) match and the file is not
  racily clean (mtime ≥ the index's), it is clean without reading it. Otherwise the file is hashed
  as `blob <len>\0<bytes>` and compared with the index oid; a CRLF worktree copy of an LF blob
  (`core.autocrlf`) also counts as clean. Other clean/smudge filters (LFS, `ident`, custom) are
  not applied → such files may read as dirty (fail-closed direction).
- **Staged changes**: the index's cache-tree root (or, when invalidated, a tree computed from the
  index entries exactly like `git write-tree`) against `HEAD^{tree}`. The commit object is read
  loose or from a pack (non-delta). A deltified commit cannot be read → staged state unknown →
  `complete: false` → `git.dirtyTree` fails closed. A staged difference is reported as the
  pseudo-path `.git/index`.
- **Untracked** (opt-in): a walk of the worktree that honours only the **top-level** `.gitignore`
  simple patterns (`*`, `?`, `**`, leading `/`, trailing `/`; no `!` negation, no nested
  `.gitignore`, no `.git/info/exclude`, no global excludes) and always skips `.git`,
  `node_modules` and `.axiom`. An untracked non-empty directory is reported as `dir/`. Because
  ignore support is partial, this can over-report — keep it off unless the repo's ignores are simple.
- **Budget**: the gate asks for the first dirty path only, within 2 s; past the budget the answer
  is `complete: false`, i.e. not proven clean → refused.
