# Command rules (`command.deny`)

*Let the gate refuse shell commands, not only file writes: your own `deny` rules, the `house` pack, hard codes that no override unlocks, importing a PowerShell guard, and a shadow-mode cutover.*

Rules live in the gate policy under `commands` — since 3.0 the `gate` section of
`.axiom/axiom.json` (the older `.axiom/gate-profile.json` is still read, with a deprecation
warning; file shapes in [profiles.md](../reference/profiles.md)):

```json
{
  "commands": {
    "pack": "house",
    "deny": [
      {
        "id": "team.noCurlPipe",
        "pattern": "curl[^|]*\\|\\s*(ba)?sh\\b",
        "reason": "Piping a download into a shell runs unreviewed code.",
        "fix": "Download the script, read it, then run it."
      },
      { "id": "team.kubectlDelete", "argv": ["kubectl", "delete"], "reason": "Deletes cluster objects.", "decision": "ask" }
    ]
  }
}
```

The gate checks `deny` in order, then the pack. The first match decides. A refusal is reported
with the rule `id` (default `command.deny`), the `reason` and the `fix`.

## Rule fields

| Field | Meaning |
|---|---|
| `id` | Stable id shown in the verdict and in `decisions.jsonl`. Default `command.deny`. |
| `pattern` | JavaScript regex source, at most 500 characters. Case-insensitive unless `caseSensitive: true`. |
| `argv` | Word prefix of one command segment (`;`, `&&`, `\|\|`, `\|`, newline split the command). Leading `VAR=x` / `$env:VAR=x` words and `sudo` are skipped; quotes are removed; the first word matches without its directory or `.exe`. `"*"` matches any one word. |
| `unless` | Regex; when it matches anywhere in the whole command, the rule does not fire. |
| `reason` | Required. One sentence for the agent. |
| `fix` | The sanctioned command that does the same thing. |
| `decision` | `deny` (default) or `ask` (the harness asks the human). |
| `caseSensitive` | `true` compiles `pattern` and `unless` without the `i` flag. |

A rule needs `pattern`, `argv`, or both (then both must match). An invalid regex fails profile
validation; it never fails at runtime. If a rule still cannot be evaluated, the gate refuses the
command (fail closed).

## The house pack

`"pack": "house"` turns on the pure command rules of the PowerShell house guard
(`guard-tooluse.ps1`). Parity is pinned by `packages/mcp/fixtures/guard-parity.json`: 93 commands
answered by the real guard, replayed in `command-rules.test.ts`.

| id | Blocks | Fix |
|---|---|---|
| `house.gitAddAll` | `git add -A` / `--all` / `.` | stage explicit paths |
| `house.gitCommitAll` | `git commit -a`, `-am`, `--all` | `agentq.ps1 commit -Paths …` |
| `house.forcePush` | `git push --force`, `-f`, `--force-with-lease` | ask the user |
| `house.resetHard` | `git reset --hard` | ask the user |
| `house.cleanForce` | `git clean -f…` | ask the user |
| `house.checkoutDiscard` | `git checkout -- <path>`, `git checkout .`, `git checkout <ref> -- <path>` | `git stash push -m … -- <path>` |
| `house.restore` | `git restore` | fix forward |
| `house.stashFlagsAfterDashDash` | `git stash push -- <path> -m …` (flags after `--` are paths) | flags before `--` |
| `house.stashBare` | bare `git stash pop/apply/drop` | name `stash@{N}` |
| `house.sqlDestructive` | dropping or truncating a table, database or schema | ask the user |
| `house.sqlDeleteAll` | a delete with no `WHERE` | ask the user |
| `house.rmRoot` | `rm -rf /` or `~` | — |
| `house.removeItemRoot` | `Remove-Item -Recurse -Force` at a drive root | — |
| `house.commitNoPathspec` | `git commit` without `-- <paths>` (allowed: `--amend`, `--allow-empty`, `commit-tree`, via `agentq.ps1`) | `agentq.ps1 commit -Paths …` |
| `house.worktreeRawRemove` | raw `git worktree remove/move` (allowed via `worktree.ps1`, `agentq.ps1`, `deploy-clean.ps1`) | `worktree.ps1 remove -Path <dir>` |
| `house.worktreeRawAdd` | raw `git worktree add` (same exemptions) | `agentq.ps1 lease -Purpose …` |
| `house.worktreeRemoveForce` | `git worktree remove --force` (follows junctions) | `worktree.ps1 remove -Path <dir>` |
| `house.playwrightLocal` | `playwright test` at a command position (allowed: `--list`, `PW_ALLOW_LOCAL=1`) | `pnpm e2e:cloud …` |
| `house.buildUnqueued` | `pnpm build`, `typecheck`, `turbo build`, `next build`, `tsc --noEmit` outside `run-build.ps1` / `agentq.ps1` | `run-build.ps1 -Command '<cmd>'` |

`axiom setup init` writes a policy with `mode: "enforce"`, `commands.pack: "house"` and four
**hard** codes — `house.forcePush`, `house.resetHard`, `house.cleanForce`,
`house.worktreeRemoveForce` — that are refused in every mode and cannot be overridden.

## Overrides

In a policy that allows overrides, a call can pass a remaining deny by carrying
`axiom-override: <reason>` in one of the tool call's `explanation`, `goal`, `description` or
`reason` fields, or as a trailing `# axiom-override: …` shell comment outside quotes and
heredocs. The reason must have at least 3 words and 12 letters. Text inside the content being
written (an `apply_patch` body, a file's new bytes) never counts, and hard codes ignore overrides.

`command.deployNeedsCleanTree` (exported as `HOUSE_DEPLOY_RULE`) is not in the pack: the guard
refuses deploys (`gcloud run deploy`, `docker push`, `terraform apply`, publishing, …) only when
the git tree is dirty, so the gate adds this rule only when its git-state fact reports a dirty
tree. Rules that need machine state — slot leases, agentq freezes, stale-script markers,
session ownership — are separate gate modules, not command rules.

## Importing an existing guard

```sh
axiom setup import-guard guard.ps1 -o commands.json
```

Every `@{ … }` / `[ordered]@{ … }` table of `'regex' = "reason"` entries becomes a list of rules
with ids `imported.1`, `imported.2`, …. Inline `(?i)` is dropped (rules are case-insensitive by
default). Constructs JavaScript cannot express — atomic groups, possessive quantifiers, balancing
groups, `(?x)`, class subtraction — and strings with `$variable` interpolation are listed under
`skipped` with the line number and the reason, never translated approximately. Paste `commands`
into the gate policy. Checks outside hashtables (if-blocks) are not imported.

## Shadow mode and cutover

Replace a guard only after it has run beside AXIOM without disagreement (decision D-39):

1. Set `"shadow": true` in the gate policy. Verdicts of the command and state rules (`commands`,
  `coordination`, `git`, `sessions`) are not enforced: the call goes on, and the journal line in
  `.axiom/decisions.jsonl` records what the gate would have decided (`shadow: true`, `rule`) plus
  the command text. The path and content predicates (`deny`, `allow`, `noSecrets`, `maxBytes`)
  keep enforcing, so shadow mode never weakens a profile you already rely on. Keep the old guard
  registered during the week.
2. Compare those records with the old guard:

   ```sh
   node scripts/guard-parity.mjs --replay .axiom/decisions.jsonl --guard guard.ps1
   ```

  It prints `{total, from, to, days, stateful, unjudged, diffs:[{command, axiom, guard}]}` and
  exits 1 on any diff. Only the stateless command half is diffed (records with no rule or a
  `house.*` rule): the guard runs from a temp copy with empty state, so stateful verdicts
  (`blind.staleScript`, coordination, git state) are only counted (`stateful`), and denies by a
  path predicate, which keeps enforcing in shadow mode, are listed under `unjudged`.
3. Cut over (remove `shadow`, unregister the old hook) only after one week of zero diffs.

`node scripts/guard-parity.mjs --check --guard guard.ps1` re-runs the fixture corpus against the
guard; `--generate --guard guard.ps1 --out <json>` rebuilds it. Both run the guard from a temp
copy with an empty `AGENTQ_HOME` / `CODAI_WT_ROOT` and a cwd outside git, so lease and freeze logic
stays inert.
