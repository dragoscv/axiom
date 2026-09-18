---
"@codai/axiom-mcp": minor
---

Streamable HTTP transport: `axiom mcp --http <host:port> [--http-token-env NAME]` serves MCP at
`POST/GET/DELETE /mcp` (+ unauthenticated `GET /health`) on plain `node:http` — one session per
`Mcp-Session-Id`, 30-min idle eviction, 4 MiB body limit, DNS-rebinding protection on loopback,
mandatory constant-time bearer token on any non-loopback bind (refuses to start without one).
Loaded lazily from `dist/http-lazy.js`; stdio stays the default and the eager bundle is unchanged.
A new private `packages/conformance` harness runs `@modelcontextprotocol/conformance` against it in
CI with an expected-failures baseline (0 unexpected failures).
