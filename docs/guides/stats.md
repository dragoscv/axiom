# `axiom setup stats` — what the gate decided, and where it is silent

*Read-only counts, deny codes and latency from the decision journal, plus alarms when a harness runs hooks for a root but never runs the gate (old verb `axiom stats`).*

```text
axiom setup stats [--root <dir>] [--since <iso>|<n>d|<n>h|<n>m] [--json]
```

Read-only. It answers two questions for one root:

1. **What did the gate decide?** Counts, deny codes and latency from the decision journal.
2. **Is the gate running everywhere hooks run?** Alarms from the harness hook logs.

Nothing is written, nothing is spawned, and a missing file is an empty result — never an error.
`--since` takes an ISO date or a relative window (`7d`, `12h`, `30m`); anything else is a usage
error.

## What it reads

| Source | Path | Needs |
| --- | --- | --- |
| Decision journal | `<root>/.axiom/decisions.jsonl` | gate policy `record: true` |
| Gate policy | `<root>/.axiom/axiom.json` (or the deprecated `.axiom/gate-profile.json`) | only for the `decisions.empty` alarm |
| VS Code hook log | newest session: `<Code[ - Insiders]>/logs/<session>/window*/exthost/GitHub.copilot-chat/GitHub Copilot Chat Hooks.log` | Copilot Chat hooks enabled |
| Copilot CLI hook events | `~/.copilot/session-state/<sessionId>/events.jsonl` (newest 100 by mtime) | Copilot CLI 1.0.9x+ |

Each log file is read from its last 8 MiB only. Runs are matched to the root by their hook `cwd`,
case-insensitively and after resolving the root's real path (so `e:\gh\x`, `E:/gh/x/` and a
junction alias all match).

## Fields (`--json`)

- `decisions` — `total`, `allow`, `deny`, `ask`, `shadowDiffs`, `p50`, `p95` (ms, `null` without
  samples) and `codes` (`{ "ERR_…": n }`) over the window.
  - Only `allow`/`deny`/`ask` decisions are counted; any other value is ignored.
  - `shadowDiffs` = shadow-mode records whose decision is not `allow` (the gate let the call
    through but would have blocked it).
  - Percentiles are nearest-rank at index `floor((n-1)·q)` over each record's `ms` — the same
    convention as `scripts/check-gate-latency.mjs`.
  - `byHarness` — the same bucket per harness (`agent_id` up to the first `:`: `claude`,
    `copilot`, `codex`, `unknown`, …).
  - `byTool` — per tool name (`Write`, `Bash`, `apply_patch`, …).
  - `post` — only PostToolUse records (`phase: "post"`).
- `logs[]` — one entry per harness log that has runs for this root: `harness`, `files`,
  `hookRuns` (PreToolUse runs of any hook), `gateRuns`, `silent`, `nonBlockingErrors`, and
  `p50`/`p95` of the gate runs where the log records durations.
- `alarms[]` — `{ id, harness?, message }`, below.

## Alarms and fixes

| Alarm | Fires when | Fix |
| --- | --- | --- |
| `gate.silent` | a harness log shows ≥ 20 PreToolUse hook runs for this root and 0 of them are the axiom gate (same threshold as `axiom setup doctor`) | `axiom setup init` (writes `command`/`bash`/`powershell`), trust the workspace, Developer: Reload Window; then `axiom setup doctor` |
| `gate.nonBlocking` | the gate ran but errored instead of deciding (VS Code `NonBlockingError`, Copilot CLI `hook errored`, e.g. `spawn axiom ENOENT`) | make the hook command resolve: install the CLI globally or use the thin client path `axiom setup init` writes; `axiom setup doctor` names the broken entry |
| `gate.slow` | the gate's p95 in a harness log is above 4000 ms | `axiom setup init --daemon` (resident gate), or check machine load / antivirus scanning of the Node binary |
| `decisions.empty` | the gate policy has `record: true` but no decision was journaled in the window | the gate is not running for this root at all — same fix as `gate.silent`; check the hook `cwd` resolves to this root |

## Harness support

- **VS Code (Copilot Chat)** — supported. Every hook run is logged with its command, workspace
  `cwd`, outcome and duration, so the gate is identified by its command line and the silent-gate
  check is exact.
- **Copilot CLI** — supported, partially. `events.jsonl` logs every hook invocation
  (`hook.start`/`hook.end` with `hookType`, `cwd`, `success`), but one invocation covers *all*
  configured hooks of that event and a successful one does not name the hook file. Stats
  therefore counts PreToolUse invocations and attributes **errored** invocations whose
  `error.source` names the axiom gate (`gate.nonBlocking`); it never raises `gate.silent` from
  this log, because "0 gate runs" there is not evidence.
- **Claude Code** — not supported as a log. The transcripts under
  `~/.claude/projects/<encoded-cwd>/*.jsonl` carried no hook-run records on the machine this was
  built and verified on, so there is no format to parse honestly. Claude Code decisions still
  appear in `decisions.byHarness.claude` when the policy records.
- **Codex, Cursor, Windsurf, Gemini CLI, Junie, Cline, Kiro, OpenCode, ACP** — no hook-run log was available to verify; their
  decisions appear in `byHarness` through the journal.

## Example

```text
$ axiom setup stats --since 7d
axiom stats - E:\gh\axiom since 2026-10-07T12:00:00.000Z
decisions: 5 (allow 2, deny 3 shadow 1) p50 30 ms p95 40 ms
  codes: ERR_GATE_DENY_GLOB 2, ERR_SECRET_DETECTED 1
  harness claude: 2 (allow 1, deny 1) p50 10 ms p95 10 ms
  harness copilot: 2 (allow 0, deny 2 shadow 1) p50 30 ms p95 30 ms
  tool Bash: 1 (allow 0, deny 1) p50 30 ms p95 30 ms
  tool Write: 4 (allow 2, deny 2 shadow 1) p50 20 ms p95 40 ms
  post-tool checks: 1 (allow 1, deny 0) p50 5000 ms p95 5000 ms
log vscode: 21 PreToolUse hook runs, 0 gate runs (1 file(s))
ALARM gate.silent [vscode]: 21 PreToolUse hook runs for this root, 0 of them the axiom gate - run `axiom setup init`, trust the workspace, reload the window
```

See also: [`axiom setup doctor`](../reference/cli.md), [checks](checks.md), the decision journal in
[snapshot](snapshot.md) / `axiom journal attest decisions`.
