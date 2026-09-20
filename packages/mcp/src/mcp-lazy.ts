/**
 * Lazy chunk for the `axiom mcp` verb: the MCP SDK (`@modelcontextprotocol/server`), the tool
 * registry and the stdio serving entry. Reached only via `import("./mcp-lazy.js")` from
 * `cli-main.ts`, so `compile` / `verify` / `gate` / `apply` never load the SDK — the eager
 * `cli.js + cli-main.js` budget (≤ 950 KB) stays free of it.
 */
export { serveStdio } from "./adapter.js";
export { serverFactory } from "./server.js";
