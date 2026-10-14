---
"@codai/axiom-mcp": minor
---

Human-only confirmDigest (S-1206).

- `axiom_apply` and `axiom_write` carry `_meta["anthropic/requiresUserInteraction"]: true` in `tools/list`, so Claude Code always asks the user before calling them (a `PreToolUse` hook cannot skip that prompt).
- When the client declares form elicitation, the apply step first asks the human through MCP elicitation: a message with the manifestDigest, root, file count and ≤ 20 `op path` lines, plus a form with `confirm` (boolean) and `digest12` (the first 12 hex characters of the digest, typed by hand). Decline / cancel / wrong digest → `ERR_CONFIRM_DIGEST_MISMATCH` with `details.reason` = `declined` | `cancelled` | `mismatch`. It works on both wire eras: the handler returns the SDK's `input_required` result, which a 2026-07-28 client fulfils and retries (the requestState is HMAC-bound to the digest, 15 min TTL), and which the SDK's legacy shim turns into a real `elicitation/create` on 2025 connections.
- Clients without elicitation keep the confirmDigest echo, unless the server runs with `requireHuman` (`CreateServerOptions.requireHuman`, `--require-human` on the CLI) → `ERR_CONFIRM_DIGEST_MISMATCH { reason: "elicitation-unsupported" }`.
- New `auditElicitationHooks(root, home)` (`src/elicit-audit.ts`) for `axiom doctor`: Claude Code `Elicitation` / `ElicitationResult` hooks that could answer the confirmation without a human → `fail elicitation.autoAnswer`; VS Code `chat.tools.global.autoApprove` / `chat.tools.autoApprove` true → `warn elicitation.autoApprove`.
