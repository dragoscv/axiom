# Human-only confirmation (S-1206)

*How `axiom_apply` and `axiom_write` make the final "yes, write it" a decision only a human can make.*

`confirmDigest === manifestDigest` (invariant 3) proves the caller looked at **this** change set,
but an agent can echo a digest it just received. AXIOM adds two layers on top of the
echo so that the confirm step needs a person.

## 1. `requiresUserInteraction` on the two write tools

`tools/list` advertises, on `axiom_apply` and `axiom_write` only:

```json
{ "_meta": { "anthropic/requiresUserInteraction": true } }
```

Claude Code then always shows its approval prompt before calling the tool. A `PreToolUse` hook
returning `allow` cannot skip it, and `permissions.allow` rules do not silence it. Other harnesses
ignore the key; their per-tool approval (`destructiveHint: true`) still applies.

## 2. An MCP elicitation before the write

If the client declared the `elicitation` capability (form mode, or a bare `elicitation: {}`), the
apply step asks the human **after** the confirmDigest check passes and **before** anything is
written:

- **Message:** root, file count, `manifest sha256:…`, at most 20 `op path` lines (the rest becomes
  "… and N more"), and the 12 hex characters to type.
- **Form:** `confirm` (boolean) and `digest12` (string, exactly 12 characters, the first 12 hex
  characters of the digest). Form mode only allows flat primitive properties, so the form has
  exactly these two fields.

| Human answer | Result |
|---|---|
| accept, `confirm: true`, `digest12` matches | the write proceeds (`applied` / `noop`) |
| accept, `confirm: false` | `ERR_CONFIRM_DIGEST_MISMATCH` `{ reason: "declined", manifestDigest }` |
| accept, wrong / missing `digest12` | `ERR_CONFIRM_DIGEST_MISMATCH` `{ reason: "mismatch", manifestDigest }` |
| decline | `ERR_CONFIRM_DIGEST_MISMATCH` `{ reason: "declined", manifestDigest }` |
| cancel (dialog dismissed) | `ERR_CONFIRM_DIGEST_MISMATCH` `{ reason: "cancelled", manifestDigest }` |

`axiom_write` without `confirmDigest` (the preview) never asks. A wrong confirmDigest is refused
before anyone is asked: `details` has no `reason`, as before.

### Both wire eras

The handler returns the SDK's `input_required` result (`inputRequired({ inputRequests, requestState })`):

- **2026-07-28 (stateless):** the client fulfils the embedded `elicitation/create` and retries
  `tools/call` with `inputResponses` + the echoed `requestState`. The capability is read from the
  request's own `_meta` envelope.
- **2025 connections:** the SDK's legacy shim sends a real `elicitation/create` to the client and
  calls the handler again with the answer. The capability is the one declared in `initialize`.
  A stateless 2025 HTTP instance that never saw `initialize` reports no capability, so it gets the
  same behaviour as a client without elicitation.

`requestState` passes through the client, so AXIOM treats it as attacker-controlled. It is
`HMAC-SHA256(per-process key, manifestDigest ‖ mint time ‖ nonce)` with a 15-minute TTL. An answer
counts only alongside a state minted for **this** digest by **this** process. A forged, replayed
or stale round just gets asked again.

## 3. Clients without elicitation

By default nothing changes: the confirmDigest echo alone applies.

To make the human step mandatory, run the server with `--require-human`
(`CreateServerOptions.requireHuman: true` when embedding). A client without form elicitation then
gets `ERR_CONFIRM_DIGEST_MISMATCH` `{ reason: "elicitation-unsupported", manifestDigest }` from
`axiom_apply` and from the confirm call of `axiom_write`, and nothing is written.

## 4. What can still defeat it (and how `doctor` finds it)

The human step is only as strong as the harness around it:

| Setting | Effect | `axiom setup doctor` |
|---|---|---|
| Claude Code `Elicitation` hook (`.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`) | can return `action: "accept"` + content, so no dialog appears | `fail elicitation.autoAnswer` |
| Claude Code `ElicitationResult` hook | can rewrite the human's answer before it reaches the server | `fail elicitation.autoAnswer` |
| VS Code `chat.tools.global.autoApprove` / `chat.tools.autoApprove` = `true` | runs the write tools without asking | `warn elicitation.autoApprove` |

The check lives in `auditElicitationHooks(root, home)` (`packages/mcp/src/elicit-audit.ts`). It
reads the files as JSONC and reports nothing when none of them is set.

## See also

- [MCP tools — human confirmation](../reference/mcp-tools.md#human-confirmation-s-1206)
- [Trust model](../concepts/trust-model.md)
- [Harnesses](../integration/harnesses.md)
