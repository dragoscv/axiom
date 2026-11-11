---
"@codai/axiom-mcp": major
---

AXIOM 4.0 — the outcome of reality check #2 (three weeks of field use after 3.0.0).

- One policy resolver for the gate, the post hook, `doctor`, `stats`, `explain`, `fleet` and
  `check` / `apply`; the repository policy is a floor that a plan or a caller can only tighten.
- Built-in protection of AXIOM's own files and wiring in every mode.
- `setup init` writes `.axiom/axiom.json` with the portable `core` pack; the shared-clone
  workflow rules are an opt-in pack (`house` stays as an alias for both).
- Crash-safe apply (journal flushed per step, heartbeat lock, containment re-checked at commit).
- Verifiable decision journal, session undo on by default, governed overrides.

`apiVersion` stays `axiom.codai.ro/v3`. See `MIGRATION.md` for the 3 → 4 behaviour table.
