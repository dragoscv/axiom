---
"@codai/axiom-mcp": minor
---

Gate profile relaxation knobs for autonomous agents (S-1221): `mode: "warn"` turns every deny into an allow whose reason reaches the agent as `additionalContext` (`AXIOM GATE WARN <code>`); `hard: [codes]` (exact, `prefix.*`, `*`) keeps denying in every mode and cannot be overridden; `override: true` lets the agent pass a non-hard deny by writing `axiom-override: <reason>` in the tool's explanation/goal/description/command; `outside: "deny"|"warn"|"allow"` decides targets beyond the root (`allow` still warns for operating-system directories). Relaxed calls are journaled with `relaxed: "warn"|"override"`, `code` and `override_reason`; `axiom stats` counts them as `relaxed`. A `--post` check in warn mode blocks only on hard codes. Defaults are unchanged (`enforce`, `deny`, no override); `axiom doctor` requires a global bin ≥ 2.7.0 for the new keys.
