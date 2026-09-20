---
"@codai/axiom-mcp": minor
---

MCP SDK v2 and the 2026-07-28 protocol revision (S-405, D-19):

- **SDK v2.** `@modelcontextprotocol/sdk` 1.30 → `@modelcontextprotocol/server` 2.0.0, reached
  through one seam, `src/adapter.ts` (new guard `check-sdk-adapter`: no other runtime module may
  import the SDK; tests may import `@modelcontextprotocol/client`).
- **Two eras, one entry.** stdio is served by `serveStdio(factory)`, HTTP by `createMcpHandler`
  for 2026-07-28 requests plus the sessionful transport for 2025-era clients routed by
  `isLegacyRequest`. `axiom mcp --wire 2026|2025|2026-only` (default `2026` = both eras;
  `2026-only` refuses `initialize` openings). Clients on SDK v1 keep working unchanged.
- **Cache hints (SEP-2549).** 2026-era `tools/list` / `resources/templates/list` /
  `server/discover` carry `ttlMs: 300000, cacheScope: "public"`; `resources/read` 24 h public
  (content-addressed); `resources/list` 10 s private. Capabilities now advertise
  `listChanged: false` (the catalogue is static).
- **Bundle.** The SDK moved into the `mcp-lazy` / `http-lazy` chunks: eager `cli.js + cli-main.js`
  dropped from 947 KB to 453 KB (limit 950 KB); `compile`/`verify`/`gate`/`apply` never load it.
- **Behaviour change.** An unknown tool is answered with JSON-RPC `-32602` (spec) instead of an
  `isError` result — the two conformance scenarios that passed vacuously on that
  (`tools-call-simple-text`, `tools-call-error`) moved to `baseline.yml`.
