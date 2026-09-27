---
"@codai/axiom-mcp": patch
---

`axiom doctor` reads `.vscode/mcp.json`, hook files and `.claude/settings.json` as JSONC (comments, trailing commas) — a commented brivio `mcp.json` was reported as "not valid JSON".
