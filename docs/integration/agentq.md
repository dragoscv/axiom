# agentq

agentq (`~/.copilot/bin/agentq.ps1`) is the house coordinator for agents sharing one clone: a
FIFO queue for builds, installs, commits and deploys, incident freezes ("marks") and leased
worktree slots. Its state is plain JSON files, so `axiom gate` honours it through the generic
[coordination file protocol](../guides/coordination.md) — `AGENTQ_EXAMPLE` in
`packages/mcp/src/coord.ts` is this mapping.

## Mapping

| agentq | AXIOM coordination |
|---|---|
| `~/.codai/coord/marks/*.json` (`agentq mark -Resource build:axiom -State frozen -Reason …`) | `marksDir` → `coord.frozen` |
| `~/.codai/coord/leases/<repo>/<slot>.json` (`agentq lease`) | `leasesDir` → `coord.leased` |
| slots `E:\gh\.wt\<repo>\<slot>` (`$env:CODAI_WT_ROOT` overrides) | `slotsRoot: "${env:CODAI_WT_ROOT:-E:/gh/.wt}"` |
| `$env:AGENTQ_HOME` (moves `marks/` and `leases/`) | point `marksDir`/`leasesDir` at `${env:AGENTQ_HOME}/marks` … |
| commands through `agentq.ps1` check marks themselves | `exemptVia: ["agentq\\.ps1"]` |
| builds via `run-build.ps1` (queues through agentq) | `queueRequired` `build` → `run-build\.ps1\|agentq\.ps1` |
| installs via `agentq run -Resource install` | `queueRequired` `install` → `agentq\.ps1` |
| commits via `agentq commit -Paths …` | `queueRequired` `commit` → `agentq\.ps1 … commit` |
| deploys via `deploy-clean.ps1` from a clean detached worktree | `git.cleanTreeFor: ["deploy"]` |
| `git commit` must carry `-- <paths>` | `git.requirePathspec: true` |

A mark's repo is the leaf of the parent of the git common dir, lowercased — the same name agentq
uses (`build:codai` also covers `E:\gh\.wt\codai\task-1`, a linked worktree of `E:\gh\codai`).
`deploy:<repo>:<target>` refuses only commands naming `<target>` unless the target is `any`.

## Example `.axiom/gate-profile.json`

```json
{
  "deny": [".git/**", ".axiom/**", "**/*.lock", "pnpm-lock.yaml", ".env", ".env.*", "**/node_modules/**"],
  "noSecrets": true,
  "coordination": {
    "marksDir": "~/.codai/coord/marks",
    "leasesDir": "~/.codai/coord/leases",
    "slotsRoot": "${env:CODAI_WT_ROOT:-E:/gh/.wt}",
    "exemptVia": ["agentq\\.ps1"],
    "queueRequired": [
      {
        "class": "build",
        "via": "run-build\\.ps1|agentq\\.ps1",
        "fix": "pwsh -NoProfile -File \"$env:USERPROFILE\\.copilot\\hooks\\run-build.ps1\" -Purpose '<why>' -Command '<build command>'"
      },
      {
        "class": "install",
        "via": "agentq\\.ps1",
        "fix": "pwsh -NoProfile -File \"$env:USERPROFILE\\.copilot\\bin\\agentq.ps1\" run -Resource install -Purpose '<why>' -- pnpm install"
      },
      {
        "class": "commit",
        "via": "agentq\\.ps1[^;|&\\n]*\\scommit\\b",
        "fix": "pwsh -NoProfile -File \"$env:USERPROFILE\\.copilot\\bin\\agentq.ps1\" commit -Purpose '<why>' -Message '<type(scope): msg>' -Paths a.ts,b.ts"
      }
    ]
  },
  "git": {
    "cleanTreeFor": ["deploy"],
    "requirePathspec": true
  }
}
```

Notes:

- `exemptVia` matches first: a command mentioning `agentq.ps1` skips marks, leases and the queue
  rule (agentq enforces them itself). `run-build.ps1` is **not** exempt from marks — a frozen
  `build:<repo>` still refuses it, as the PowerShell guard does.
- Lease protection allows `worktree.ps1`, `agentq.ps1` and `deploy-clean.ps1` (they check the
  lease and back up before deleting); `agentq unlease -Repo <slot> -LeaseId <id>` is the way to
  free your own slot.
- `git.dirtyTree` never refuses a command mentioning `deploy-clean.ps1`: it deploys from its own
  clean worktree at an exact pushed commit.
- On a machine where the slots live elsewhere, set `CODAI_WT_ROOT`; without it the fallback
  `E:/gh/.wt` applies (the house layout).
