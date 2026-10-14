---
"@codai/axiom-mcp": patch
---

`axiom <verb> --help` (or `-h`) now prints the usage text with exit 0. Before, every verb's strict argument parser rejected it with "Unknown option '--help'" (and `axiom gate --help` reported `AXIOM GATE ERROR`). Dependencies refreshed to the latest stable: zod 4.6.7, vitest 5.0.4.
