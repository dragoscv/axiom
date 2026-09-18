---
"@codai/axiom-mcp": major
---

New `@codai/axiom-mcp` 2.0.0: stdio MCP server (`McpServer.registerTool` with annotations, Zod v4 input/output
schemas, `structuredContent`), 9 tools (`axiom_plan_validate|plan_compile|manifest_verify|check|apply_dry_run|apply|rollback|manifest_diff|roots_list`),
5 resource templates (`axiom://manifest|report|applied|profile|schema`), frozen `--root` allowlist with no
env/cwd fallback, stderr-only JSON-lines logging, 4 MiB payload guard, `spec/tools.json` generated from the
registry, and an `axiom` CLI (`compile|verify|check|apply|rollback|diff|schema|mcp`) bundled into a single
self-contained `dist/cli.js`.
