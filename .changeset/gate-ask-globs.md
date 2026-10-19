---
"@codai/axiom-mcp": minor
---

Gate profile `ask` globs: a write (or shell operand) matching one is not denied but handed to the human — `path.ask` with `permissionDecision: "ask"` on `auto`/`claude`/`copilot`/`vscode`, a plain deny on formats without an ask prompt (fail-closed). Every deny wins (`deny`, `allow`, `noSecrets`, `maxBytes`, `steer: "require"`, session rules); `record`/`shadow` journal the verdict as `ask`. `axiom doctor` fails `bin.profile` when a profile uses `ask` but the global bin is older than 2.7.0 (its strict schema would deny every write).
