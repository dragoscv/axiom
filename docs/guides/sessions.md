# Session guards — cross-session overwrites, blind overwrites, stale scripts

*Stop one agent session from silently clobbering what another session just wrote.*

Stories S-1209 and S-1215. Several agents often work in the same clone at once. The gate
(`axiom gate`, PreToolUse) can remember who last wrote each file and refuse — or ask — when a
session is about to overwrite content it has never seen.

## Configure

Add a `sessions` block to the gate policy (the `gate` section of `.axiom/axiom.json`, or the
deprecated `.axiom/gate-profile.json`):

```json
{
  "sessions": {
    "foreignWrite": "ask",
    "windowMin": 15,
    "blindOverwrite": "deny",
    "trackReads": false,
    "staleScript": true
  }
}
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `foreignWrite` | `off` \| `ask` \| `deny` | `off` | Rule `session.foreignWrite`. |
| `windowMin` | integer 1–1440 | `15` | How recent a foreign write must be to count. |
| `blindOverwrite` | `off` \| `ask` \| `deny` | `off` | Rule `blind.overwrite`. |
| `trackReads` | boolean | `false` | Record what each session reads (see limits). |
| `staleScript` | boolean | `true` | Rule `blind.staleScript`. |

The object is strict: an unknown key makes the profile invalid. `ask` lets the human decide in
harnesses that support it (Claude Code, VS Code, Copilot CLI); elsewhere it behaves like `deny`.

## Rules

### `session.foreignWrite`

Fires when, for a write target:

1. the last recorded writer is a **different agent** (`<harness>:<sessionId>`),
2. that write happened within `windowMin` minutes, and
3. the file's current sha256 differs from the hash the calling session last saw (on its own
   write, or on a read when `trackReads` is on).

Fix: re-read the file and re-apply the change on top of the current content. A call without a
session id gets no opinion.

### `blind.overwrite`

Fires for a **whole-file** create/write tool (`create_file`, `Write`, `write_file`) on a file
that already exists and that this session has never written:

- with `trackReads: true` — the session has never read it either;
- with `trackReads: false` — the file's last recorded writer is another session (at any time).

Targeted edits are never blind. Fix: read the file and use a targeted edit, or write a new file.

### `blind.staleScript`

When the gate denies a create, it records a marker under `.axiom/denied/`. For the next 10
minutes, a shell command that mentions that path — or just its leaf name when it is a script
(`.ps1`, `.mjs`, `.js`, `.ts`, `.cmd`, `.sh`, `.py`) — is denied: the script on disk is the OLD
version (or does not exist). Fix: write it under a NEW filename, check the create succeeded,
then run it.

## State files

| File | Content |
|---|---|
| `.axiom/sessions/writers.json` | `{ path: { agentId, at, hash, pending?: { agentId, at, preHash } } }` |
| `.axiom/sessions/<sha256(session)[:16]>.json` | `{ seen: { path: hash }, wrote: { path: at } }` |
| `.axiom/denied/recent.json` | `[{ abs, at }]` — denied creates, last 10 minutes |

Hashes are sha256 hex of the file bytes; a missing file is `"absent"`. Session ids are stored
hashed in file names. All writes are tmp + rename.

## Limits

- **Attribution is settled on the next gate call.** The gate runs *before* the tool, so an
  allowed write is recorded as *pending* with the hash the writer saw. The next gate call that
  finds a different hash on disk attributes the change to that writer. A tool call that failed
  (hash unchanged) is never attributed; a pending entry expires after 24 h.
- **Read tracking costs latency.** `trackReads: true` makes read tools take the gate's slow path
  (hash the file and update the session state) instead of the fast allow.
- Files larger than 8 MiB are not hashed — no opinion.
- These rules are advisory state: any internal error means *no opinion*, never a failure. The
  gate's own fail-closed behaviour is unchanged.
- Writes that bypass the gate (a shell `>` redirect, another tool) are invisible to it.

See also [undo](undo.md) for reverting a whole session.
