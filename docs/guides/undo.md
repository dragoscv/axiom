# Undo a session — `axiom journal undo --session <agent>`

*Revert everything one agent session wrote through the gate, without touching what others wrote since.*

Story S-1210.

## Enable capture

Add `"undo": true` to the gate policy (the `gate` section of `.axiom/axiom.json`, or the
deprecated `.axiom/gate-profile.json`). For every **allowed** write, the gate then
copies the current bytes of each target (its pre-image) into the CAS
(`.axiom/cas/sha256/<aa>/<hex>`) and appends one line per target to
`.axiom/undo/<sha256(agentId)[:16]>.jsonl`:

```json
{"v":1,"at":1760000000000,"agentId":"claude:3f2a…","sessionId":"3f2a…","tool":"Edit","path":"src/a.ts","pre":"sha256:…"}
```

`pre` is `sha256:<hex>`, `"absent"` (the file did not exist), or `"toolarge"` (over 8 MiB, not
captured). Capture never fails the gate.

## Restore

```text
axiom journal undo --session <agent> [--dry-run] [--force] [--since <iso>] [--root <dir>]
```

`<agent>` is the full agent id (`<harness>:<sessionId>`) or just the session id. For each path
the **first** pre-image recorded in the window (all of the session, or from `--since`) is the
state restored:

| Pre-image | Action |
|---|---|
| `sha256:…` | `restore` — bytes from the CAS, written atomically inside the root |
| `absent` | `delete` — the session created the file |
| current file already equal | `skip` / `unchanged` |
| `toolarge` | `skip` / `toolarge` |
| blob gone from the CAS | `skip` / `missing-blob` |

**Conflict-aware:** when another agent's undo log, or the [session guard](sessions.md) writers
map, shows a write to the same path *after* this session's last write, the item is
`skip` / `conflict` — restoring would destroy that work. `--force` restores anyway.

`--dry-run` computes the same result and writes nothing. Undo holds `.axiom/lock`, so it never
races an apply or gc. The command prints the result as JSON:

```json
{
  "root": "E:/repo",
  "agentId": "claude:3f2a…",
  "dryRun": false,
  "items": [{ "path": "src/a.ts", "action": "restore", "pre": "sha256:…" }],
  "restored": 1,
  "conflicts": 0
}
```

An unknown agent → `ERR_NOT_FOUND`; a malformed `--since` → `ERR_INVALID_PLAN`.

## Retention

Undo pre-images are live for `axiom gc` while their log line is younger than the TTL (default 7
days); a non-dry-run gc also prunes expired lines and empty logs.

```text
axiom gc --undo-ttl 7d
```

`GcResult` reports `undoLive` (digests kept by undo logs) and `undoPruned` (lines removed).

## Limits

- Only writes the gate allowed are captured; writes made outside the gate are not.
- Restoring is file-level: a session's edit and a later foreign edit to the same file are not
  merged — the file is skipped as a conflict.
