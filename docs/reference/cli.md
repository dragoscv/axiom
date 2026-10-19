# CLI reference

*Every `axiom` command and flag, the exit-code contract, and a worked example per command. Everything below the "Command map" heading is generated from the CLI command table (`packages/mcp/src/cli-commands.ts`, D-43) by `node scripts/gen-cli-doc.mjs`; `check-cli-doc` fails when this page is stale. Hand-written prose per command lives in its `notes` block and survives regeneration.*

The `axiom` bin (`@codai/axiom-mcp`; also installed as `axgate` and `axiom-mcp`) is one executable.
Since 3.0 commands are grouped by noun:

| Group | Commands |
|---|---|
| `axiom plan` | `compile`, `check`, `apply`, `diff`, `verify`, `emitters` |
| `axiom journal` | `log`, `status`, `verify`, `undo`, `rollback`, `attest` |
| `axiom keys` | `gen`, `sign`, `trust` |
| `axiom hook` | `gate`, `post`, `daemon` |
| `axiom setup` | `init`, `doctor`, `stats`, `migrate`, `import-guard` |
| top level | `mcp`, `serve`, `snapshot`, `snapshot diff`, `gc`, `schema` |

The 2.x verbs (`axiom compile`, `axiom apply`, `axiom gate`, `axiom init`, `axiom keygen`, ...) keep
working unchanged as hidden aliases until 4.0 - in particular **`axiom gate --stdin ...` is
byte-for-byte the same hook entry point** every installed hook calls. The command map below lists
every old verb next to its new name.

Help: `axiom --help` prints a grouped overview; `axiom <group> --help` lists one group;
`axiom <command> --help` (new name or old verb) prints only that command's usage, options with
defaults, and examples. `axiom help <command>` is the same. `axiom --version` prints the version.

Every command except `mcp` and `serve` prints **JSON to stdout** (`journal attest` prints JSON
Lines; `plan check`, `setup init`, `setup doctor`, `setup stats`, `journal status`, `journal log`
and `plan emitters` without `--json` print a text summary, ASCII only); `mcp` speaks JSON-RPC on
stdout and logs JSON lines on stderr. A `.axm` Plan with errors prints its diagnostics as JSON and
exits 2.

| Exit | Meaning |
|---|---|
| `0` | ok - verdict `pass`, apply `applied`/`noop`, tree matches, journal chain intact, migrated cleanly, `setup doctor` with no failed check (warnings included) |
| `1` | verdict `fail`/`error`, apply `failed`/`rolled-back`, tree mismatch, signature failure, journal chain broken (`ERR_JOURNAL_CHAIN`), keyless signing unavailable (`ERR_KEYLESS_UNAVAILABLE`), migrated **with warnings**, `journal undo` with skipped conflicts |
| `2` | usage error, structural failure, `.axm` diagnostics, any `ERR_*` raised outside a result object; `setup doctor` with at least one failed check |

## Errors

A failure that is not a result object is **one JSON line on stderr**, flat:

```json
{"code":"ERR_NOT_FOUND","message":"input file not found: plan.json","details":{"path":"/abs/plan.json"}}
```

`code` is from the closed list in [error-codes.md](error-codes.md); `details` is optional. The
user mistakes map to specific codes, never `ERR_INTERNAL`:

| Mistake | Code | `details` |
|---|---|---|
| missing input file | `ERR_NOT_FOUND` | `path` |
| input is a directory | `ERR_TARGET_TYPE` | `path` |
| plan / bundle file is not valid JSON | `ERR_INVALID_PLAN` | `path`, `format: "json"`, `line`, `column`, `reason` |
| YAML plan error | `ERR_INVALID_PLAN` | `format: "yaml"`, `line?`, `column?` |
| bundle fails the schema | `ERR_INVALID_MANIFEST` | `issues[]` |
| `plan apply` without `--confirm` | `ERR_CONFIRM_DIGEST_MISMATCH` | `confirm: null`, `manifestDigest`; the message says to run `--dry-run` first and pass its `manifestDigest` |

A **usage error** (unknown command or option, missing argument, bad flag value) prints

```
error: <message>
usage: <the command's one-line usage>
Run 'axiom <command> --help' for usage, options and examples.
```

on stderr and exits `2`; an unknown command or option within edit distance 2 of a real one adds
`(did you mean '...'?)`. With `--json` the same error is the flat envelope
`{"code":"ERR_USAGE","message","details":{"usage","help"}}`.

## Shared flags

| Flag | Commands | Meaning |
|---|---|---|
| `--root <dir>` | most | the repository root; realpathed, must be a directory. Required where shown. Only the local setup/read commands (`setup init`, `setup doctor`, `setup stats`, `journal status`, `journal log`, `journal undo`, `journal attest`) default to the current directory; every other command has no `cwd` fallback |
| `--profile <name>` | `plan check`, `plan apply`, `setup migrate` | a built-in (`default`, `strict`, `permissive`) or `<root>/.axiom/profiles/<name>.json` ([profiles.md](profiles.md)). `plan apply` defaults to the manifest's own `profile` |
| `--allow-guards` | `mcp`, `plan check`, `plan apply` | enable `guard.external` (the profile must **also** set `facts.allowGuards: true`) |
| `--guard-allowlist <abs>` | `mcp`, `plan check`, `plan apply` | repeatable; absolute guard commands must appear here exactly. Relative ones must live under `<root>/scripts/` |
| `--log-level error\|warn\|info\|debug` | `mcp`, `hook gate` | stderr verbosity, default `warn` |
| `--json` | text-summary commands | print the full result object instead of the text summary; also switches usage errors to the JSON envelope |
| `-o, --out <file>` | `plan compile`, `keys sign`, `setup migrate`, `snapshot`, `setup import-guard` | write the result to a file and print a short summary instead |

## Environment variables the CLI reads

| Variable | Command | Purpose |
|---|---|---|
| `AXIOM_SIGNING_KEY` | `keys sign`, `journal attest --sign` | private key when `--key-file` is absent |
| `SIGSTORE_ID_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | `keys sign --keyless` | OIDC token source for Sigstore; absent -> `ERR_KEYLESS_UNAVAILABLE` (`reason: NO_OIDC`) |
| `AXIOM_HTTP_TOKEN` (or the name given to `--http-token-env`) | `mcp --http` | bearer token; required for non-loopback binds |
| the name given to `--token-env` | `serve --hook`, `hook daemon` | optional bearer token for daemon requests (also written to `~/.axiom/daemon.json`, mode 0600) |
| `AXIOM_GATE_DAEMON=0` | `hook gate` | ignore a running daemon; always decide in-process |
| `AXIOM_OTEL_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | `serve --hook --otel` | OTLP/HTTP trace export target, headers and service name |
| `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_SHA`, `GITHUB_RUN_ID` | `plan verify --tree --attest` | copied into `predicate.source` when present |

Nothing else is read: there is no root, profile or allowlist environment fallback.

**See also**

- [MCP tools](mcp-tools.md) - the same engines over MCP, and what is deliberately CLI-only
- [Quickstart](../getting-started/quickstart.md) - the commands in the order you first use them
- [Error codes](error-codes.md) - every `code` the envelope can carry
- [`packages/mcp/README.md`](../../packages/mcp/README.md) - the package's own summary

<!-- cli:generated -->

## Command map

| Command | Old verb (hidden alias until 4.0) | Summary |
|---|---|---|
| `axiom plan compile` | `compile` | Plan (.json, .yaml, .axm) -> content-addressed ManifestBundle |
| `axiom plan check` | `check` | run the profile's predicates over a bundle against a root |
| `axiom plan apply` | `apply` | hash-gated two-phase apply of a bundle (--dry-run first, then --confirm) |
| `axiom plan diff` | `diff` | structural diff of two bundles by artifact path |
| `axiom plan verify` | `verify` | verify a bundle: digests, signatures (--root), the tree it describes (--tree) |
| `axiom plan emitters` | `emitters` | list the template emitters available to plan compile |
| `axiom journal log` | `log` | the journal chain, newest first |
| `axiom journal status` | `status` | lock holder, queue, intents, interrupted journals, last applied, chain |
| `axiom journal verify` | - | verify the journal hash chain (broken -> exit 1, ERR_JOURNAL_CHAIN) |
| `axiom journal undo` | `undo` | restore every file one agent session wrote through the gate |
| `axiom journal rollback` | `rollback` | reverse-replay the journal of an applied manifest |
| `axiom journal attest` | `attest` | gate decision journal -> in-toto agent-decision Statements (JSON Lines) |
| `axiom keys gen` | `keygen` | generate an Ed25519 signing key (private key -> file 0600) |
| `axiom keys sign` | `sign` | append a DSSE signature (Ed25519 or Sigstore keyless) to a bundle |
| `axiom keys trust` | `trust` | manage <root>/.axiom/trust/keys.json (add, remove, list, root-id) |
| `axiom hook gate` | `gate` | PreToolUse hook: judge one harness payload (fail-closed) |
| `axiom hook post` | - | PostToolUse hook: check what the tool changed (= gate --post) |
| `axiom hook daemon` | - | resident gate daemon for hooks on loopback (= serve --hook) |
| `axiom setup init` | `init` | wire a repo: MCP entry, hooks, profiles, .gitignore (idempotent) |
| `axiom setup doctor` | `doctor` | is this machine + root wired correctly? (exit 2 = a check failed) |
| `axiom setup suggest-profile` | - | propose profile changes from the decision journal (never writes the profile) |
| `axiom setup stats` | `stats` | gate decisions, latency per harness, silent-gate alarms |
| `axiom setup migrate` | `migrate` | old policy files -> .axiom/axiom.json, or an AXIOM 1.x manifest -> Plan |
| `axiom setup import-guard` | `import-guard` | PowerShell guard pattern tables -> gate profile commands JSON |
| `axiom explain` | - | why the gate decided what it did: rule, profile, paths, and how to fix it |
| `axiom journal replay` | - | re-judge one session's recorded decisions with the current profile (read-only) |
| `axiom report` | - | self-contained HTML report of gate decisions (no external assets) |
| `axiom pin` | - | pin MCP server configs (.vscode/.cursor/.mcp.json); --check reports drift (exit 1) |
| `axiom acp-proxy` | - | ACP stdio proxy: answers session/request_permission with the gate |
| `axiom mcp` | - | MCP server: stdio JSON-RPC, or Streamable HTTP with --http |
| `axiom serve` | - | resident gate daemon (serve --hook); same as axiom hook daemon |
| `axiom snapshot` | - | deterministic inventory of a root (RepoSnapshot) |
| `axiom snapshot diff` | `snapshot-diff` | compare two RepoSnapshot files: added, removed, changed |
| `axiom gc` | - | CAS garbage collection + expired undo logs (CLI only) |
| `axiom schema` | - | print the JSON Schema of one wire type |

## `plan`

author, judge and transactionally apply a Plan.

### `axiom plan compile`

Plan (.json, .yaml, .axm) -> content-addressed ManifestBundle.

```
axiom plan compile <plan.json|plan.yaml|plan.axm> [-o <out.json>] [--store inline|cas] [--root <dir>]
                   [--allow-net [--net-allow <host>[,host]]] [--allow-file] [--emitter <pkg>]...
```

Old verb (hidden alias until 4.0): `axiom compile`.

| Option | Default | Description |
|---|---|---|
| `-o, --out <file>` | `stdout` | write the bundle to <file> and print a summary |
| `--store inline\|cas` | `inline` | blob transport |
| `--root <dir>` | - | record preImage[] and store the manifest under <root>/.axiom/manifests |
| `--allow-net` | - | fetch https: ref sources |
| `--net-allow <host>[,host] ...` | - | restrict --allow-net to these hosts (*.example.com wildcards) |
| `--allow-file` | - | admit file: ref sources |
| `--emitter <pkg> ...` | - | load a template emitter package, e.g. @codai/axiom-emitters-web (repeatable) |

```sh
axiom plan compile plan.json --root . -o bundle.json
axiom plan compile plan.axm -o bundle.json
axiom plan compile plan.json --root . --store cas --allow-net --net-allow cdn.example.com
```

<!-- notes:plan compile -->
Plan → `ManifestBundle`. `.axm` input is parsed first (diagnostics → exit 2). `.yaml` / `.yml`
input is parsed as a single hardened YAML document ([plan-format.md](plan-format.md#yaml-plans));
a YAML error is `ERR_INVALID_PLAN` with `details: { format: "yaml", line?, column? }` (exit 2). With `--root` (or
implicitly when `--store cas`, `--allow-net` or `--allow-file` is given) the manifest carries
`preImage[]` and a copy is stored under `<root>/.axiom/manifests/<hex>.json`. `--store cas` writes
blobs to the CAS instead of inlining them. `ref` sources are offline by default: `--allow-net`
fetches `https:` URIs (no redirects, 30 s, 32 MiB cap), `--net-allow` restricts hosts
(`*.example.com` wildcards; the flag requires `--allow-net`), `--allow-file` admits `file:` URIs.
Template emitters available: `axiom emitters`.

Output with `-o`: `{ manifestDigest, artifacts, out }`; without: the whole bundle.
<!-- /notes -->

### `axiom plan check`

run the profile's predicates over a bundle against a root.

```
axiom plan check <bundle.json> --root <dir> [--profile <name>] [--json | --format text|json|sarif]
                 [--allow-guards] [--guard-allowlist <abs>]...
```

Old verb (hidden alias until 4.0): `axiom check`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |
| `--profile <name>` | `manifest profile` | built-in (default\|strict\|permissive) or <root>/.axiom/profiles/<name>.json |
| `--json` | - | print the full result object instead of the text summary |
| `--format text\|json\|sarif` | `text` | output format (sarif = SARIF 2.1.0 for code scanning) |
| `--allow-guards` | - | enable guard.external checks (the profile must also set facts.allowGuards) |
| `--guard-allowlist <abs> ...` | - | absolute guard command allowed to run (repeatable) |

```sh
axiom plan check bundle.json --root . --profile strict
axiom plan check bundle.json --root . --format sarif > axiom.sarif
```

<!-- notes:plan check -->
Run the profile's predicates plus the manifest's own `checks[]` over the bundle against the root;
verify `preImage[]` against the tree. `--profile` defaults to the manifest's own `profile`. With
`--json` the full `CheckReport` is printed; without it a human summary
(`PASS sha256:… (default, 34 ms)` followed by one line per finding) — the only verb whose default
output is not JSON. The report is stored under `<root>/.axiom/reports/` either way. Exit `0` only
on `verdict: pass`. `--format sarif` (2.6.0) prints a SARIF 2.1.0 log for GitHub code scanning
instead (same exit codes) — [sarif.md](../guides/sarif.md). Predicates: [checks.md](../guides/checks.md).
<!-- /notes -->

### `axiom plan apply`

hash-gated two-phase apply of a bundle (--dry-run first, then --confirm).

```
axiom plan apply <bundle.json> --root <dir> [--dry-run] [--confirm <digest>] [--profile <name>]
                 [--pr [--branch <name>] [--message <text>]] [--lock-timeout <ms>] [--keep-backups <n>]
                 [--allow-guards] [--guard-allowlist <abs>]...
```

Old verb (hidden alias until 4.0): `axiom apply`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |
| `--dry-run` | - | phase 1 only: stage, check, print the diff and the manifestDigest |
| `--confirm <digest>` | - | must equal bundle.manifestDigest (required without --dry-run) |
| `--profile <name>` | `manifest profile` | built-in (default\|strict\|permissive) or <root>/.axiom/profiles/<name>.json |
| `--pr` | - | commit the touched paths on a new branch from an axiom-owned worktree |
| `--branch <name>` | `axiom/<name>/<digest12>` | --pr branch |
| `--message <text>` | - | --pr commit message |
| `--lock-timeout <ms>` | `30000` | max wait for .axiom/lock (0..600000) |
| `--keep-backups <n>` | `3` | pre-image backup sets kept (0..1000) |
| `--allow-guards` | - | enable guard.external checks (the profile must also set facts.allowGuards) |
| `--guard-allowlist <abs> ...` | - | absolute guard command allowed to run (repeatable) |

```sh
axiom plan apply bundle.json --root . --dry-run
axiom plan apply bundle.json --root . --confirm sha256:<manifestDigest>
axiom plan apply bundle.json --root . --confirm sha256:<manifestDigest> --pr --branch feat/x
```

<!-- notes:plan apply -->
Two-phase commit. Without `--dry-run`, `--confirm` **must** equal `bundle.manifestDigest`
(`ERR_CONFIRM_DIGEST_MISMATCH`, exit 2). Pre-apply checks run on the staged tree with the given
profile (default: the manifest's `profile`) and abort on any non-`pass` verdict
(`ERR_CHECKS_FAILED`). `--dry-run` does phase 1 only and returns a unified diff.

Concurrency: before queueing, a non-dry-run apply registers an **intent** (its artifact paths)
under `.axiom/intents/`; a live intent of a *different* digest touching an overlapping path (same
path or a directory prefix) fails at once with `ERR_CONFLICT`, `error.details: { otherDigest, paths }`.
It then waits in a FIFO queue (`.axiom/queue/`) for `.axiom/lock`; `--lock-timeout <ms>`
(0–600 000, default 30 000) bounds the wait, after which it fails `ERR_LOCKED` with
`error.details: { holder: { pid, host, digest, since }, waitedMs, queuePosition, lock }`
(`queuePosition` 1-based). `--keep-backups <n>` (0–1000, default 3) keeps the pre-image backup
sets of the `n` most recent applies under `.axiom/backup/`, ordered by journal chain `seq`.

`--pr` never touches the shared tree's HEAD, index or files: the apply runs in an axiom-owned
linked worktree at `.axiom/wt/<hex12>` on a new branch started from `HEAD`, commits exactly the
touched paths there, then removes the worktree (and deletes the branch unless the commit landed);
the touched paths must be clean in the shared tree (`ERR_GIT_DIRTY`). `--branch` defaults to
`axiom/<name>/<digest12>`, `--message` to `axiom: apply <name> (<digest12>)` with trailers; no
push. If `HEAD` already holds the manifest's result the status is `noop`. On `status: applied`
with a profile that carries `manifest.requireSigned { antiRollback }`, the trust state advances.
Exit `1` on `failed`/`rolled-back`. Guarantees: [apply.md](../guides/apply.md).
<!-- /notes -->

### `axiom plan diff`

structural diff of two bundles by artifact path.

```
axiom plan diff <a.json> <b.json>
```

Old verb (hidden alias until 4.0): `axiom diff`.

```sh
axiom plan diff old.bundle.json new.bundle.json
```

<!-- notes:plan diff -->
Structural diff of two bundles: `{ added[], removed[], changed[] }` by artifact path. Same as
`axiom_manifest_diff`.
<!-- /notes -->

### `axiom plan verify`

verify a bundle: digests, signatures (--root), the tree it describes (--tree).

```
axiom plan verify <bundle.json> [--root <dir>]
axiom plan verify <bundle.json> --tree <dir> [--pre] [--attest <out.json>]
```

Old verb (hidden alias until 4.0): `axiom verify`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | also verify signatures against <root>/.axiom/trust/keys.json |
| `--tree <dir>` | - | compare the tree under <dir> with the manifest's artifacts |
| `--pre` | - | with --tree: compare against the declared pre-image set |
| `--attest <out.json>` | - | with --tree: write an in-toto Statement on success |
| `--journal` | - | verify the root's journal hash chain instead (= axiom journal verify) |

```sh
axiom plan verify bundle.json
axiom plan verify bundle.json --root .
axiom plan verify bundle.json --tree . --attest axiom.intoto.json
```

<!-- notes:plan verify -->
Structural verification: canonical form, `manifestDigest`, every blob's hash. With `--root`,
additionally verify detached DSSE signatures against `<root>/.axiom/trust/keys.json`
(`signatures: { trustFile, keyids[], findings[], ok, code? }`; no trust store → `signatures: null`).
With `--tree`, compare the tree under `<dir>` with the manifest's artifacts (or, with `--pre`, its
declared `preImage[]` set) and list `mismatches[]`; `--attest` writes an in-toto Statement to
`<out.json>` and the bare predicate beside it on success. `--attest` requires `--tree`. Never
takes the lock, never writes under `.axiom/`. Details: [verify-tree.md](../guides/verify-tree.md).

`--journal` verifies the root's journal hash chain `.axiom/journal/chain.jsonl` instead of a
bundle (it takes no positional and no `--tree`/`--attest`; `--root` is required). One line per
journal that reached a terminal state, keys in fixed order `seq, manifestDigest, state, at, prev,
files, [code]`; `prev` is `sha256:` of the previous line's exact bytes (64 zeros for seq 1).
Output: `{ ok, entries, head, firstBad?: { seq, reason: prev-mismatch|seq-gap|parse }, missing[] }`
— `head` is the digest of the last good line (pin it externally to detect tail truncation),
`missing` lists entries whose journal file was pruned (legal, not a fault). **Exit `0` intact,
`1` broken** (the output then also carries `code: "ERR_JOURNAL_CHAIN"`), `2` usage/root error.
<!-- /notes -->

### `axiom plan emitters`

list the template emitters available to plan compile.

```
axiom plan emitters [--emitter <pkg>]... [--json]
```

Old verb (hidden alias until 4.0): `axiom emitters`.

| Option | Default | Description |
|---|---|---|
| `--emitter <pkg> ...` | - | load a template emitter package, e.g. @codai/axiom-emitters-web (repeatable) |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom plan emitters --emitter @codai/axiom-emitters-web --json
```

<!-- notes:plan emitters -->
List the template emitters compiled into this bin — `{ emitter, version, template, description }`
rows; currently `web@2.0.0` ([emitters.md](../guides/emitters.md)). Without `--json` the same list,
pretty-printed.
<!-- /notes -->

## `journal`

what was applied: history, state, integrity, undo, attestations.

### `axiom journal log`

the journal chain, newest first.

```
axiom journal log [--root <dir>] [--limit <n>] [--json]
```

Old verb (hidden alias until 4.0): `axiom log`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `-n, --limit <n>` | `20` | entries to print (1..100000) |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom journal log
axiom journal log -n 5 --json
```

<!-- notes:journal log -->
The journal chain (`.axiom/journal/chain.jsonl`), newest first; `--limit` (`-n`, 1–100 000,
default 20). Text: one line per entry, `#<seq> <at> <state> <manifestDigest> [<name>] (<n> files) [<code>]`.
`--json`: `{ root, entries: [{ seq, manifestDigest, state: committed|rolled-back|failed, at, prev, files, code?, name?, fileList?: [{ path, op }], journalPresent }] }` —
`name` comes from the stored manifest, `fileList` from the journal when it still exists.
Best-effort: stops at the first bad chain line (use `verify --journal` for integrity).
<!-- /notes -->

### `axiom journal status`

lock holder, queue, intents, interrupted journals, last applied, chain.

```
axiom journal status [--root <dir>] [--json]
```

Old verb (hidden alias until 4.0): `axiom status`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom journal status --json
```

<!-- notes:journal status -->
Read-only snapshot of one root's write state; never takes the lock, never writes. `--root`
defaults to the current directory. Same document as the `axiom_status` MCP tool:

```
{ root,
  lock: { held, holder?: { pid, host?, digest?, since?, stale }, queue: [{ pid, since }],
          intents: [{ digest, paths[], pid, since }] },
  interrupted: [{ manifestDigest, phase, startedAt, pid, files, done }],   // staged / committing / rolling-back
  corrupt: [<journal file>],
  lastApplied?: { seq, manifestDigest, state, at, prev, files, code? },
  chain: { ok, entries, head, firstBad?: { seq, reason }, missingJournals } }
```

`queue` lists the FIFO wait tickets under `.axiom/queue/`, `intents` the in-flight applies
registered under `.axiom/intents/` (see `apply`). Exit `0`.
<!-- /notes -->

### `axiom journal verify`

verify the journal hash chain (broken -> exit 1, ERR_JOURNAL_CHAIN).

```
axiom journal verify --root <dir>
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |

```sh
axiom journal verify --root .
```

<!-- notes:journal verify -->
<!-- /notes -->

### `axiom journal undo`

restore every file one agent session wrote through the gate.

```
axiom journal undo --session <agent> [--root <dir>] [--dry-run] [--force] [--since <iso>]
```

Old verb (hidden alias until 4.0): `axiom undo`.

| Option | Default | Description |
|---|---|---|
| `--session <agent>` | - | agent id (<harness>:<session>) or session id (required) |
| `--root <dir>` | `.` | repository root |
| `--dry-run` | - | report what would be restored |
| `--force` | - | also restore paths another agent wrote later |
| `--since <iso>` | - | only writes after this time |

```sh
axiom journal undo --session claude:abc123 --dry-run
```

<!-- notes:journal undo -->
Restore every file one agent session wrote through the gate (2.6.0; needs `"undo": true` in the
gate profile, which captures the pre-image of each allowed write into CAS). `<agent>` is the full
agent id (`<harness>:<session>`) or just the session id. A path another agent wrote afterwards is
skipped as a conflict unless `--force`; exit `1` when any conflict was skipped. Prints
`{ root, agentId, dryRun, items: [{ path, action, reason?, pre }], restored, conflicts }`.
Unknown agent → `ERR_NOT_FOUND`. Details: [undo.md](../guides/undo.md).
<!-- /notes -->

### `axiom journal rollback`

reverse-replay the journal of an applied manifest.

```
axiom journal rollback <digest> --root <dir>
```

Old verb (hidden alias until 4.0): `axiom rollback`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |

```sh
axiom journal rollback sha256:<manifestDigest> --root .
```

<!-- notes:journal rollback -->
Reverse-replay the journal of an applied manifest from `.axiom/backup/<hex>/`, scoped to the paths
it recorded. Also finishes a journal left in `committing` / `rolling-back` by a crash. Prints
`{ manifestDigest, status, phase, steps[], root }`.
<!-- /notes -->

### `axiom journal attest`

gate decision journal -> in-toto agent-decision Statements (JSON Lines).

```
axiom journal attest decisions [--root <dir>] [--since <iso>] [--limit <n>] [--sign [--key-file <path>]]
```

Old verb (hidden alias until 4.0): `axiom attest`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--since <iso>` | - | only decisions after this time |
| `-n, --limit <n>` | - | max statements (1..100000) |
| `--sign` | - | wrap each Statement in a DSSE envelope |
| `--key-file <path>` | `$AXIOM_SIGNING_KEY` | Ed25519 private key for --sign |

```sh
axiom journal attest decisions --since 2026-10-14T00:00:00Z --sign
```

<!-- notes:journal attest -->
Turns `.axiom/decisions.jsonl` (written by the gate when the gate profile sets `record: true`)
into in-toto Statement v1 documents, one JSON line each: predicateType
`https://auxidus.dev/attestation/agent-decision/v0.1` (in-toto/attestation#554), subject
`{ name: <tool>, digest: { sha256: <JCS args hash> } }`, predicate `{ agent_id, principal,
policy_evaluations, tool_calls: [{ name, args_hash }], decided_at, args_state, axiom: { paths, profile } }`.
`--sign` wraps each in a DSSE envelope (`application/vnd.in-toto+json`) with the Ed25519 key from
`--key-file` or `$AXIOM_SIGNING_KEY` (`ERR_NOT_FOUND` without one). `--root` defaults to the
current directory.
<!-- /notes -->

### `axiom journal replay`

re-judge one session's recorded decisions with the current profile (read-only).

```
axiom journal replay --session <agent_id|session> [--root <dir>] [--profile <file>] [--json]
```

| Option | Default | Description |
|---|---|---|
| `--session <id>` | - | agent_id or session id |
| `--root <dir>` | `.` | repository root |
| `--profile <file>` | - | gate profile to judge with |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom journal replay --session copilot:abc123
```

<!-- notes:journal replay -->
<!-- /notes -->

## `keys`

signing keys, signatures and the root's trust store.

### `axiom keys gen`

generate an Ed25519 signing key (private key -> file 0600).

```
axiom keys gen [--out <dir>] [--name <label>]
```

Old verb (hidden alias until 4.0): `axiom keygen`.

| Option | Default | Description |
|---|---|---|
| `--out <dir>` | `.` | directory for the private key file |
| `--name <label>` | - | label in the public entry |

```sh
axiom keys gen --out ./secrets --name ci
```

<!-- notes:keys gen -->
Generate an Ed25519 signing key. The private key goes to `<dir>/axiom-signing-<id>.key` with mode
`0600`; stdout gets `{ publicEntry: { keyid, alg, publicKey, name }, privateKeyFile }`. The private
key is never printed.
<!-- /notes -->

### `axiom keys sign`

append a DSSE signature (Ed25519 or Sigstore keyless) to a bundle.

```
axiom keys sign <bundle.json> [--key-file <path>] [-o <out.json>] [--root-id <id>]
axiom keys sign <bundle.json> --keyless [--bound --root <dir> | --root-id <id>] [-o <out.json>]
```

Old verb (hidden alias until 4.0): `axiom sign`.

| Option | Default | Description |
|---|---|---|
| `--key-file <path>` | `$AXIOM_SIGNING_KEY` | Ed25519 private key |
| `-o, --out <file>` | `the input file` | write the signed bundle to <file> |
| `--root-id <id>` | - | root-bound envelope only a trust store with this rootId accepts |
| `--keyless` | - | Sigstore via ambient OIDC (no OIDC -> exit 1 ERR_KEYLESS_UNAVAILABLE) |
| `--bound` | - | with --keyless: take the root id from --root's trust store |
| `--root <dir>` | - | root for --bound |

```sh
axiom keys sign bundle.json --key-file ./secrets/axiom-signing-<id>.key -o signed.json
axiom keys sign bundle.json --keyless --bound --root . -o signed.json
```

<!-- notes:keys sign -->
Append a detached DSSE envelope over `JCS(manifest)` to `bundle.signatures[]`. The private key comes
from `--key-file` or, failing that, `$AXIOM_SIGNING_KEY` (base64 PKCS#8, base64 raw seed, or PEM).
`--root-id <id>` produces a root-bound envelope (`application/vnd.axiom.manifest-bound+json`) that
only a trust store with that `rootId` accepts. `manifestDigest` is unchanged. Protocol: [signing.md](../guides/signing.md).

`--keyless` signs the same payload bytes with Sigstore instead (Fulcio certificate from an OIDC
identity + Rekor entry) and appends the Sigstore bundle to `bundle.keylessSignatures[]`
(outside `manifestDigest`). It needs an ambient OIDC token (`SIGSTORE_ID_TOKEN`, or GitHub Actions
`ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN` with `id-token: write`), network
access and the optional `sigstore` dependency; `--key-file` is rejected. Root binding: `--root-id <id>`,
or `--bound --root <dir>` to take the id from that root's trust store (no `rootId` there → usage
error); `--root` without `--bound` is a usage error. Output:
`{ manifestDigest, keyless: true, keylessSignatures, rootId?, bound?, out }`. When signing cannot
run, stdout is `{ code: "ERR_KEYLESS_UNAVAILABLE", message, details: { reason } }` with
`reason` `NO_OIDC | SIGN_FAILED | MODULE_MISSING | MODULE_LOAD_FAILED`, and the exit code is `1`.
Verification: `manifest.requireSigned` with a `keyless` policy ([checks.md](../guides/checks.md)).
<!-- /notes -->

### `axiom keys trust`

manage <root>/.axiom/trust/keys.json (add, remove, list, root-id).

```
axiom keys trust add <pubkey.json> --root <dir>
axiom keys trust remove <keyid> --root <dir>
axiom keys trust list --root <dir>
axiom keys trust root-id [<id> | --clear] --root <dir>
```

Old verb (hidden alias until 4.0): `axiom trust`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |
| `--clear` | - | root-id: remove the binding |

```sh
axiom keys trust add pubkey.json --root .
axiom keys trust root-id github:owner/repo --root .
```

<!-- notes:keys trust -->
Manage `<root>/.axiom/trust/keys.json`. `add` re-derives the `keyid` from `publicKey` and refuses
mismatches; `remove` revokes; `list` prints the store; `root-id` shows, sets or clears the store's
`rootId` (require root-bound signatures carrying that id).
<!-- /notes -->

## `hook`

harness hooks: the PreToolUse/PostToolUse gate and its daemon.

### `axiom hook gate`

PreToolUse hook: judge one harness payload (fail-closed).

```
axiom hook gate --stdin [--post] [--format auto|copilot|claude|codex|vscode|cursor|windsurf|gemini|junie|cline|kiro]
                [--root <dir>] [--profile <file>] [--fail-open] [--no-shell-scan] [--no-root-discovery]
                [--track-reads] [--deny-exit 0|2] [--log-level error|warn|info|debug]
```

Old verb (hidden alias until 4.0): `axiom gate`.

| Option | Default | Description |
|---|---|---|
| `--stdin` | - | read the harness payload from stdin |
| `--post` | - | PostToolUse payload: check what the tool changed |
| `--format auto\|copilot\|claude\|codex\|vscode\|cursor\|windsurf\|gemini\|junie\|cline\|kiro` | `auto` | harness answer document and exit code |
| `--root <dir>` | - | root used only when the payload has no cwd |
| `--profile <file>` | `<root>/.axiom/gate-profile.json` | gate profile file (then ~/.axiom/gate-profile.json, then built-in) |
| `--fail-open` | - | allow when the gate cannot decide |
| `--no-shell-scan` | - | skip shell command scanning |
| `--no-root-discovery` | - | do not walk up from cwd to find the root |
| `--track-reads` | - | let read tools reach the gate (sessions.trackReads; skips the fast path) |
| `--deny-exit 0\|2` | `0` | exit code of a deny (2 for exit-code-only harnesses) |
| `--log-level error\|warn\|info\|debug` | `warn` | stderr verbosity |

```sh
axiom gate --stdin --format auto
axiom hook gate --stdin --format claude --deny-exit 2
```

<!-- notes:hook gate -->
PreToolUse hook. Reads one harness payload from stdin and exits `0`: allow = no output; deny = one
JSON document on stdout (`permissionDecision: "deny"`) plus one line on stderr. `--deny-exit 2`
additionally exits `2` on a deny, for harnesses that read only the exit code (Windsurf); the default
changed from `2` to `0` in 2.4.1 because the npm `.ps1` shim rewrites `2` to `1`, which VS Code
treats as a warning (D-35). `--format` picks the harness's own deny/allow document and exit code
(Cursor `permission`, Gemini/Junie `decision`, Cline `cancel`, Windsurf exit 2 —
[hooks.md § Output formats](../getting-started/hooks.md#output-formats----format-250-s-903)).
When `axiom serve --hook` runs, the call is answered by the daemon; otherwise in-process (same
verdict). Read-only tools are answered before the gate chunk loads; targets in a
sibling worktree of the same repository are judged against that worktree. Fail-closed: malformed input or an undeterminable write target is a
deny unless `--fail-open`. `--root` is used only when the payload has no `cwd`; `--profile` points
at a gate-profile file (default search: `<root>/.axiom/gate-profile.json` → `~/.axiom/gate-profile.json`
→ built-in). `--strict` is accepted as a 2.1 no-op. Contract, wiring, profile schema and latency:
[hooks.md](../getting-started/hooks.md).

2.6.0 adds to the gate profile: `commands` (shell command rules + the `house` pack,
[command-rules.md](../guides/command-rules.md)), `sessions` (cross-session overwrite, blind
overwrite, stale script — [sessions.md](../guides/sessions.md)), `undo`
([undo.md](../guides/undo.md)), `coordination` and `git`
([coordination.md](../guides/coordination.md)) and `shadow` (allow everything, record what would
have been decided). A rule can answer `ask` instead of deny; Claude, VS Code and Copilot then
prompt the human, every other format gets a deny. `--post` handles a PostToolUse payload: it
checks what the tool actually changed and returns the harness's "block" feedback (always exit 0;
a post hook cannot undo). `--track-reads` lets read tools reach the gate so `sessions.trackReads`
can record them (slower: the read-only fast path is skipped).
<!-- /notes -->

### `axiom hook post`

PostToolUse hook: check what the tool changed (= gate --post).

```
axiom hook post --stdin [--format auto|copilot|claude|codex|vscode|cursor|windsurf|gemini|junie|cline|kiro] [--root <dir>] [--profile <file>]
                [--log-level error|warn|info|debug]
```

| Option | Default | Description |
|---|---|---|
| `--stdin` | - | read the harness payload from stdin |
| `--format auto\|copilot\|claude\|codex\|vscode\|cursor\|windsurf\|gemini\|junie\|cline\|kiro` | `auto` | harness answer document and exit code |
| `--root <dir>` | - | root used only when the payload has no cwd |
| `--profile <file>` | `<root>/.axiom/gate-profile.json` | gate profile file (then ~/.axiom/gate-profile.json, then built-in) |
| `--fail-open` | - | allow when the gate cannot decide |
| `--no-shell-scan` | - | skip shell command scanning |
| `--no-root-discovery` | - | do not walk up from cwd to find the root |
| `--track-reads` | - | let read tools reach the gate (sessions.trackReads; skips the fast path) |
| `--deny-exit 0\|2` | `0` | exit code of a deny (2 for exit-code-only harnesses) |
| `--log-level error\|warn\|info\|debug` | `warn` | stderr verbosity |

```sh
axiom hook post --stdin --format claude
```

<!-- notes:hook post -->
<!-- /notes -->

### `axiom hook daemon`

resident gate daemon for hooks on loopback (= serve --hook).

```
axiom hook daemon --root <abs>... [--host 127.0.0.1] [--port 47861] [--token-env <NAME>] [--otel]
```

| Option | Default | Description |
|---|---|---|
| `--root <abs> ...` | - | root the daemon answers for (required, repeatable) |
| `--host <host>` | `127.0.0.1` | loopback bind address |
| `--port <n>` | `47861` | TCP port |
| `--token-env <NAME>` | - | env var holding a bearer token required on every request |
| `--otel` | - | export GenAI execute_tool spans to $AXIOM_OTEL_ENDPOINT / OTLP env |

```sh
axiom hook daemon --root E:\gh
```

<!-- notes:hook daemon -->
<!-- /notes -->

## `setup`

wire a repo, diagnose it, measure the gate, migrate, import guards.

### `axiom setup init`

wire a repo: MCP entry, hooks, profiles, .gitignore (idempotent).

```
axiom setup init [--root <dir>] [--harness auto|copilot|claude|codex|vscode|cursor|windsurf|gemini|junie|cline|kiro|opencode] [--daemon]
                 [--profile-name <name>] [--force] [--upgrade] [--managed --out <dir>] [--json]
```

Old verb (hidden alias until 4.0): `axiom init`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--harness auto\|copilot\|claude\|codex\|vscode\|cursor\|windsurf\|gemini\|junie\|cline\|kiro\|opencode` | `auto` | auto = one harness per marker directory present |
| `--daemon` | - | hooks call the native axiom-hook client / the daemon's HTTP hook |
| `--profile-name <name>` | `directory name` | name of .axiom/profiles/<name>.json |
| `--force` | - | overwrite existing files |
| `--upgrade` | - | bring an existing wiring up to date without --force |
| `--managed` | - | write enterprise policy files into --out instead |
| `--out <dir>` | - | output directory for --managed |
| `--dry-run` | - | print the unified diff of what init would write; write nothing |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom setup init
axiom setup init --dry-run
axiom setup init --harness claude --profile-name web --json
```

<!-- notes:setup init -->
Wire a repository for AXIOM in one idempotent step. `--root` defaults to the current directory.
`--harness auto` (default) picks one harness per marker directory present (`.github` → copilot,
`.claude` → claude, `.codex` → codex, `.vscode` → vscode, `.cursor` → cursor, `.windsurf`/`.devin`
→ windsurf, `.gemini` → gemini, `.junie` → junie, `.clinerules` → cline; none → copilot + vscode). Files written,
all under the root, each through the containment check (a symlink/junction segment →
`ERR_SYMLINK_IN_PATH`) and an atomic write:

| File | When | Content |
|---|---|---|
| `.vscode/mcp.json` | always | merges `servers.axiom` (`npx -y @codai/axiom-mcp@2 mcp --root ${workspaceFolder}`) |
| `.github/hooks/axiom-gate.json` | copilot or vscode | `preToolUse` hook with `command`/`bash` `axiom gate --stdin --format auto` and `powershell` `axiom.cmd … ; exit $LASTEXITCODE`, `timeoutSec: 15` (an exec-only file from ≤ 2.5.1 is migrated) |
| `.claude/settings.json` | claude | merges a `hooks.PreToolUse` entry (`Write\|Edit\|MultiEdit\|NotebookEdit` → `axiom gate --stdin`, timeout 5) |
| `.cursor/hooks.json`, `.cursor/mcp.json` | cursor | `preToolUse` + `beforeShellExecution` → `axiom gate --stdin --format cursor`, `failClosed: true`; `mcpServers.axiom` |
| `.devin/hooks.json` or `.windsurf/hooks.json` | windsurf | `pre_write_code` + `pre_run_command` → `--format windsurf` (exit 2 on deny) |
| `.codex/hooks.json`, `.codex/config.toml` | codex | merges a `PreToolUse` entry (`^(Bash\|apply_patch\|Edit\|Write)$` → `--format codex`); appends `[mcp_servers.axiom]` only when absent |
| `.gemini/settings.json` | gemini | merges `hooks.BeforeTool` (`write_file\|replace\|run_shell_command` → `--format gemini`, 10000 ms) and `mcpServers.axiom` |
| `.junie/mcp/mcp.json`, `.junie/guidelines.md` | junie | `mcpServers.axiom`; guidelines section appended once (marker `<!-- axiom -->`); the user-level hook snippet is printed as a note |
| `.clinerules/hooks/PreToolUse` (0755), `PreToolUse.ps1` | cline | scripts that run `--format cline` and print a `cancel` document when the gate cannot run |
| `.axiom/profiles/<name>.json` | always | repo profile extending `default` (`repo.noOverwriteOf`, `content.noSecrets`, `path.deny`) |
| `.axiom/gate-profile.json` | always | gate profile (deny list, `noSecrets`, `maxBytes: 262144`, `steer: "hint"`) |
| `.gitignore` | always | appends the missing lines of `.axiom/*`, `!.axiom/profiles/`, `!.axiom/gate-profile.json` |

`--profile-name` overrides the name derived from the directory name (must match
`^[a-z0-9][a-z0-9._-]{0,63}$` and not be a builtin, else `ERR_INVALID_PROFILE`). An existing file
is never overwritten without `--force`; a JSON file that is not plain JSON (JSONC, broken) is
skipped, never rewritten; TOML and Markdown are only appended to. `--daemon` wires the resident
gate daemon instead: Claude gets a `type: "http"` hook to `http://127.0.0.1:47861/v1/hook/claude`
(`onFailure: "block"`) and every command hook runs the native `axiom-hook` client. Output
(`--json`): `{ root, harnesses[], profile, files: [{ path, action: created|merged|updated|skipped, reason? }], notes[] }`.
Hooks call the global bin — install it with `npm install -g @codai/axiom-mcp`, never `npx` in a hook.

Since 2.6.0 a fresh gate profile sets `record: true`, and Claude, Codex and Copilot also get a
PostToolUse entry (`axiom gate --stdin --post`). `--upgrade` brings an existing wiring up to date
without `--force`: adds `record` + `steer` to the gate profile when the global bin is ≥ 2.5,
switches gate hooks to `axiom-hook` (Claude: the HTTP hook) when a daemon answers, replaces `npx`
MCP entries with the global bin, migrates exec-only Copilot hooks and adds the PostToolUse entries
when the bin is ≥ 2.6; each change is reported `updated` with a reason, a second run changes
nothing. `--managed --out <dir>` writes enterprise policy files (Claude managed settings, Codex
`requirements.toml`, Cursor system `hooks.json`, a Copilot policy hook, a VS Code policy note) into
`<dir>` and prints where each must be installed — [managed.md](../guides/managed.md).
<!-- /notes -->

### `axiom setup doctor`

is this machine + root wired correctly? (exit 2 = a check failed).

```
axiom setup doctor [--root <dir>] [--json]
axiom setup doctor --fleet [--scan <dir>]... [--json]
```

Old verb (hidden alias until 4.0): `axiom doctor`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--fleet` | - | every wired repo + worktree slot: profile drift, stale hooks, bin skew |
| `--scan <dir> ...` | - | with --fleet: directory whose child repos are checked (repeatable) |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom setup doctor
axiom setup doctor --json
axiom setup doctor --fleet --scan E:\gh
```

<!-- notes:setup doctor -->
Is this machine + root wired correctly? Read-only apart from spawning the gate (which never
writes). Each check is `ok | warn | fail` with a message and, when not `ok`, a `fix:` hint.
Checks: `root`, `bin` (global `axiom` on `PATH`, version vs this CLI), `bin.profile` (gate profile
uses `steer`/`steerGlobs`/`record` but the global bin is < 2.5.0, or `ask` and < 2.7.0 → fail), `hook.copilot` /
`hook.claude` / `hook.cursor` / `hook.windsurf` / `hook.codex` / `hook.gemini` / `hook.junie` /
`hook.cline` / `hook` (an entry running `axiom gate --stdin` or `axiom-hook gate --stdin`, or the
Claude HTTP hook; `npx` entries do not count; Cursor without `failClosed` → warn), `daemon`
(`~/.axiom/daemon.json` → health check; this root outside its roots or unreachable → warn),
`hook.log.vscode` (VS Code's Copilot hook log: gate runs that ended `NonBlockingError` did not
block → warn), `mcp.vscode`, `lock` (free, live holder, or stale), `journal` (interrupted or corrupt
journals → fail), `chain` (journal hash chain; broken → fail), `profile.<name>` for every
`.axiom/profiles/*.json`, `gate.profile`, `gitignore` (`.axiom/` covered), `gate.latency` (p95 of
5 `gate --stdin` runs; above 4000 ms — 80 % of the 5 s hook timeout — → fail). **Exit `0` when no
check failed (warnings never fail), `2` when any did.** Output (`--json`):
`{ root, ok, checks: [{ id, status, message, hint? }] }`.
<!-- /notes -->

### `axiom setup suggest-profile`

propose profile changes from the decision journal (never writes the profile).

```
axiom setup suggest-profile [--days 7] [--min 5] [--root <dir>] [--json]
```

| Option | Default | Description |
|---|---|---|
| `--days <n>` | `7` | journal window |
| `--min <n>` | `5` | minimum hits before a code is proposed |
| `--root <dir>` | `.` | repository root |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom setup suggest-profile --days 14
```

<!-- notes:setup suggest-profile -->
<!-- /notes -->

### `axiom setup stats`

gate decisions, latency per harness, silent-gate alarms.

```
axiom setup stats [--root <dir>] [--since <iso>|<n>d|<n>h|<n>m] [--json]
```

Old verb (hidden alias until 4.0): `axiom stats`.

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--since <iso>\|<n>d\|<n>h\|<n>m` | - | window start (absolute or relative to now) |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom setup stats --since 7d
```

<!-- notes:setup stats -->
Gate activity for a root (2.6.0): decisions from `.axiom/decisions.jsonl` (allow / deny / ask,
codes, p50/p95 ms, per harness and tool, post-tool checks, shadow-mode diffs) plus the hook logs
of VS Code and Copilot CLI, with alarms: `gate.silent` (hooks fire, the gate is not among them),
`gate.nonBlocking`, `gate.slow`, `decisions.empty`. Details: [stats.md](../guides/stats.md).
<!-- /notes -->

### `axiom setup migrate`

old policy files -> .axiom/axiom.json, or an AXIOM 1.x manifest -> Plan.

```
axiom setup migrate --profile [--root <dir>] [--dry-run] [--name <profile>]
axiom setup migrate v1 <manifest.json> [-o <plan.json>] [--profile <name>] [--cas <root>]
                       [--content <dir>] [--name <kebab>] [--overwrite]
```

Old verb (hidden alias until 4.0): `axiom migrate`.

| Option | Default | Description |
|---|---|---|
| `--dry-run` | - | with --profile: print the new axiom.json, write nothing |
| `--root <dir>` | `.` | repository root |
| `-o, --out <file>` | `stdout` | write the Plan to <file> and print the report |
| `--profile [<name>]` | - | alone: migrate the policy files; with v1: profile of the new Plan |
| `--cas <root>` | - | store resolved bytes in this root's CAS |
| `--content <dir>` | `manifest directory` | sidecar bytes for hash-only artifacts |
| `--name <kebab>` | `migrated-v1-<profile>` | Plan name |
| `--overwrite` | - | op: overwrite on every artifact |

```sh
axiom setup migrate --profile --dry-run
axiom setup migrate v1 out.manifest.json -o plan.json
```

<!-- notes:setup migrate -->
Lift an AXIOM 1.0.x manifest into a v2 Plan. `--content` names the directory holding sidecar bytes
for hash-only artifacts (default: the manifest's directory); `--cas <root>` stores resolved bytes
in that root's CAS and emits `cas` sources; `--overwrite` sets `op: overwrite` on every artifact;
`--name` overrides `migrated-v1-<profile>`. Exit `1` = migrated **and written**, with warnings.
Field mapping and drops: [migrate.md](../guides/migrate.md).
<!-- /notes -->

### `axiom setup import-guard`

PowerShell guard pattern tables -> gate profile commands JSON.

```
axiom setup import-guard <guard.ps1> [-o <file>]
```

Old verb (hidden alias until 4.0): `axiom import-guard`.

| Option | Default | Description |
|---|---|---|
| `-o, --out <file>` | `stdout` | write { commands } to <file> |

```sh
axiom setup import-guard guard-tooluse.ps1 -o commands.json
```

<!-- notes:setup import-guard -->
Convert the `'regex' = "reason"` hashtables of a PowerShell PreToolUse guard into the gate
profile's `commands.deny` rules (2.6.0); constructs JavaScript cannot express are reported on
stderr and skipped. Prints `{ commands, skipped[] }`, or with `-o` writes `{ commands }` to the
file. Cutover procedure (parity test + one week of shadow mode):
[command-rules.md](../guides/command-rules.md).
<!-- /notes -->

## `explain`

why the gate decided what it did: rule, profile, paths, and how to fix it.

```
axiom explain <id|last|-N|N> [--root <dir>] [--json]
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom explain last
axiom explain -3 --json
```

<!-- notes:explain -->
<!-- /notes -->

## `report`

self-contained HTML report of gate decisions (no external assets).

```
axiom report [--root <dir>] [--days 7] --out <file.html> [--json]
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--days <n>` | `7` | window |
| `-o, --out <file>` | `required` | HTML file to write |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom report --days 30 --out axiom-report.html
```

<!-- notes:report -->
<!-- /notes -->

## `pin`

pin MCP server configs (.vscode/.cursor/.mcp.json); --check reports drift (exit 1).

```
axiom pin [--root <dir>] [--check] [--json]
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | `.` | repository root |
| `--check` | - | compare against .axiom/mcp-pins.json |
| `--json` | - | print the full result object instead of the text summary |

```sh
axiom pin
axiom pin --check
```

<!-- notes:pin -->
<!-- /notes -->

## `acp-proxy`

ACP stdio proxy: answers session/request_permission with the gate.

```
axiom acp-proxy --root <dir> -- <agent> [args...]
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |

```sh
axiom acp-proxy --root . -- my-agent --acp
```

<!-- notes:acp-proxy -->
<!-- /notes -->

## `mcp`

MCP server: stdio JSON-RPC, or Streamable HTTP with --http.

```
axiom mcp [--root <abs>]... [--allow-guards] [--guard-allowlist <abs>]... [--log-level error|warn|info|debug]
          [--http <host:port>] [--http-token-env <NAME>] [--wire 2026|2025|2026-only] [--require-human]
          [--tools core|full] [--emitter <pkg>]...
```

| Option | Default | Description |
|---|---|---|
| `--root <abs> ...` | - | allowlisted root (repeatable; none -> ERR_ROOT_REQUIRED per tool) |
| `--log-level error\|warn\|info\|debug` | `warn` | stderr verbosity |
| `--http <host:port>` | - | serve Streamable HTTP at /mcp (port 0 = random) |
| `--http-token-env <NAME>` | `AXIOM_HTTP_TOKEN` | env var with the bearer token (required for non-loopback hosts) |
| `--wire 2026\|2025\|2026-only` | `2026` | protocol era served |
| `--require-human` | - | axiom_apply/axiom_write refuse unless a human confirms via elicitation |
| `--tools core\|full` | `core` | core = the 6 write-path tools; full = every tool |
| `--emitter <pkg> ...` | - | load a template emitter package, e.g. @codai/axiom-emitters-web (repeatable) |
| `--allow-guards` | - | enable guard.external checks (the profile must also set facts.allowGuards) |
| `--guard-allowlist <abs> ...` | - | absolute guard command allowed to run (repeatable) |

```sh
axiom mcp --root /abs/repo
axiom mcp --root /abs/repo --tools full --http 127.0.0.1:3411
```

<!-- notes:mcp -->
Start the MCP server — stdio by default, Streamable HTTP with `--http`. `--root` may repeat; with
none, every root-taking tool fails `ERR_ROOT_REQUIRED` (a warning is logged). `--http 0` binds a
random loopback port and logs the URL at `info`. A non-loopback host **requires** a bearer token in
the env var named by `--http-token-env` (default `AXIOM_HTTP_TOKEN`, ≥ 16 chars) or the server
refuses to start. `--wire` selects the protocol era: `2026` (default) and `2025` both serve
2026-07-28 and 2025-era clients from the same entry; `2026-only` refuses `initialize` openings.
`--require-human` (2.6.0) makes `axiom_apply` / `axiom_write` refuse a confirm step that a human
did not approve through MCP elicitation (`ERR_CONFIRM_DIGEST_MISMATCH`, `details.reason:
"elicitation-unsupported"` for a client without the capability) —
[human-confirm.md](../guides/human-confirm.md). Tools, resources and transport rules:
[mcp-tools.md](mcp-tools.md).
<!-- /notes -->

## `serve`

resident gate daemon (serve --hook); same as axiom hook daemon.

```
axiom serve --hook --root <abs>... [--host 127.0.0.1] [--port 47861] [--token-env <NAME>] [--otel]
```

| Option | Default | Description |
|---|---|---|
| `--hook` | - | serve the gate for hooks (required) |
| `--root <abs> ...` | - | root the daemon answers for (required, repeatable) |
| `--host <host>` | `127.0.0.1` | loopback bind address |
| `--port <n>` | `47861` | TCP port |
| `--token-env <NAME>` | - | env var holding a bearer token required on every request |
| `--otel` | - | export GenAI execute_tool spans to $AXIOM_OTEL_ENDPOINT / OTLP env |

```sh
axiom serve --hook --root E:\gh
```

<!-- notes:serve -->
Resident gate daemon for hooks (2.5.0). Keeps the gate engine loaded and answers
`axiom gate --stdin` / `axiom-hook` / Claude HTTP hooks over loopback HTTP. `--root` is required
(repeatable; a parent such as `E:\gh` covers every repo under it) — a hook whose cwd is outside
every root is not answered and decides in-process. A non-loopback `--host` is refused; requests
with an `Origin` header or a non-loopback `Host` are refused; `--token-env NAME` requires
`authorization: Bearer <$NAME>`. Writes `~/.axiom/daemon.json` (removed on SIGINT/SIGTERM) and
logs one JSON line `{msg, url, pid, roots}` to stderr. Endpoints: `POST /v1/gate`,
`POST /v1/hook/claude`, `GET /v1/health`. Protocol: `packages/mcp/src/daemon-proto.ts`.
`--otel` (2.6.0) exports one OpenTelemetry span per judged request (GenAI `execute_tool`
conventions, OTLP/HTTP JSON) to the endpoint from the environment — [otel.md](../guides/otel.md).
<!-- /notes -->

## `snapshot`

### `axiom snapshot`

deterministic inventory of a root (RepoSnapshot).

```
axiom snapshot --root <dir> [-o <out.json>] [--include <glob>]... [--exclude <glob>]...
               [--max-files <n>] [--max-bytes <n>] [--no-gitignore] [--no-digest]
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |
| `-o, --out <file>` | `stdout` | write the snapshot to <file> and print a summary |
| `--include <glob> ...` | - | only matching paths |
| `--exclude <glob> ...` | - | skip matching paths |
| `--max-files <n>` | `20000` | file cap (max 50000) |
| `--max-bytes <n>` | `67108864` | byte cap |
| `--no-gitignore` | - | ignore the root .gitignore |
| `--no-digest` | - | record sizes only |

```sh
axiom snapshot --root . -o before.json
```

<!-- notes:snapshot -->
Deterministic inventory of a root (`RepoSnapshot`, `snapshotDigest = sha256(JCS(body))`).
`--include`/`--exclude` use a tiny glob dialect (`**`, `*`, `?`); `--max-files` default 20 000
(cap 50 000), `--max-bytes` default 64 MiB; `--no-gitignore` ignores the root `.gitignore`;
`--no-digest` records sizes only. `.git/` and `.axiom/` are always skipped. With `-o` stdout is a
one-line summary. Details: [snapshot.md](../guides/snapshot.md).
<!-- /notes -->

### `axiom snapshot diff`

compare two RepoSnapshot files: added, removed, changed.

```
axiom snapshot diff <a.json> <b.json>
```

Old verb (hidden alias until 4.0): `axiom snapshot-diff`.

```sh
axiom snapshot diff before.json after.json
```

<!-- notes:snapshot diff -->
`{ added[], removed[], changed: [{ path, from, to }] }` between two snapshots, keyed by path.
<!-- /notes -->

## `gc`

CAS garbage collection + expired undo logs (CLI only).

```
axiom gc --root <dir> [--dry-run] [--older-than <n>(ms|s|m|h|d)] [--keep all-manifests|journal]
         [--undo-ttl <n>(ms|s|m|h|d)]
```

| Option | Default | Description |
|---|---|---|
| `--root <dir>` | - | repository root (required; no cwd fallback) |
| `--dry-run` | - | report, remove nothing |
| `--older-than <n>(ms\|s\|m\|h\|d)` | - | skip candidates younger than this |
| `--keep all-manifests\|journal` | `all-manifests` | which manifests pin blobs |
| `--undo-ttl <n>(ms\|s\|m\|h\|d)` | `7d` | how long undo pre-images stay live |
| `--decisions-older-than <days>` | - | drop decision-journal lines older than this many days |

```sh
axiom gc --root . --dry-run
axiom gc --root . --older-than 30d --keep journal
```

<!-- notes:gc -->
CAS garbage collection — **CLI only**, no MCP tool. Removes blobs no live manifest references.
`--keep all-manifests` (default) pins every stored manifest's digests; `--keep journal` pins only
manifests named by a journal or an `applied/` record. `--older-than` skips young candidates
(`skippedYoung`). Takes `.axiom/lock` like apply (`ERR_LOCKED` on a live holder). Report:
`{ root, keep, dryRun, scanned, live, missing, removed[], skippedYoung, freedBytes, undoLive, undoPruned }`.
Pre-images captured for `axiom undo` stay live for `--undo-ttl` (default 7 d); older undo lines are
pruned on a non-dry run. Details: [cas.md](../concepts/cas.md), [undo.md](../guides/undo.md).
<!-- /notes -->

## `schema`

print the JSON Schema of one wire type.

```
axiom schema <Plan|Manifest|ManifestBundle|CheckReport|ApplyResult|Profile|Journal|RepoSnapshot>
```

```sh
axiom schema Plan
```

<!-- notes:schema -->
Print the JSON Schema (draft 2020-12, generated from the Zod source) for one wire type. Also served
as `axiom://schema/<Kind>`.
<!-- /notes -->
