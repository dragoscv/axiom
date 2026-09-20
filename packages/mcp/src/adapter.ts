/**
 * MCP SDK adapter (v2-architecture §5.4, D-19, S-405).
 *
 * The ONLY module under `packages/mcp/src` allowed to import `@modelcontextprotocol/*`
 * (guard: `check-sdk-adapter`). Everything AXIOM needs from the SDK — server construction,
 * the two serving entries, the result types — is re-exported here under names that do not
 * change when the SDK does, so the next SDK major is a one-file diff.
 *
 * SDK 2.0.0 (2026-07-27) facts this seam encodes:
 * - `@modelcontextprotocol/sdk` is split; the server surface is `@modelcontextprotocol/server`
 *   and stdio lives on its `./stdio` subpath (the root barrel is runtime-neutral).
 * - A hand-connected `McpServer` + `StdioServerTransport` speaks ONLY the 2025 era. Serving the
 *   2026-07-28 revision goes through the factory entries `serveStdio` / `createMcpHandler`,
 *   which pin one instance per connection (stdio) or build one per request (HTTP) and pass the
 *   factory the `era` they are about to serve.
 * - `ttlMs` / `cacheScope` (SEP-2549) are stamped by the SDK on 2026-era cacheable results from
 *   `ServerOptions.cacheHints`; 2025-era responses never carry them.
 */
import {
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
  type McpServerFactory,
  ResourceTemplate,
  type ServerOptions,
  createMcpHandler as sdkCreateMcpHandler,
  isLegacyRequest as sdkIsLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import {
  type ServeStdioOptions,
  type StdioServerHandle,
  serveStdio as sdkServeStdio,
} from "@modelcontextprotocol/server/stdio";
import type { WireMode } from "./wire.js";

export type {
  CreateMcpHandlerOptions,
  McpHttpHandler,
  McpRequestContext,
  McpServerFactory,
  ServerOptions,
  ServeStdioOptions,
  StdioServerHandle,
};
export { McpServer, ResourceTemplate, WebStandardStreamableHTTPServerTransport };

/** Wire era a connection/request is served on (`legacy` = 2024-10-07 … 2025-11-25). */
export type WireEra = McpRequestContext["era"];

/** Tool-result shape returned by every AXIOM tool handler. */
export type { CallToolResult } from "@modelcontextprotocol/server";
export { isWireMode, WIRE_MODES, type WireMode } from "./wire.js";

/**
 * Cache policy AXIOM advertises on 2026-era `tools/list` & co. The tool catalogue is static
 * for the life of a process, so a shared 5-minute TTL is safe; `resources/read` is content
 * addressed (`axiom://manifest/<sha>`) and therefore immutable → public, 1 day.
 */
export const CACHE_HINTS: NonNullable<ServerOptions["cacheHints"]> = {
  "tools/list": { ttlMs: 5 * 60_000, cacheScope: "public" },
  "resources/templates/list": { ttlMs: 5 * 60_000, cacheScope: "public" },
  "server/discover": { ttlMs: 5 * 60_000, cacheScope: "public" },
  // Stored digests appear as roots are touched — short, private.
  "resources/list": { ttlMs: 10_000, cacheScope: "private" },
  "resources/read": { ttlMs: 24 * 3_600_000, cacheScope: "public" },
};

/**
 * Serve a factory over the current process's stdio. `wire` maps to the SDK's `legacy` option:
 * `2026` serves both eras (SDK default), `2026-only` rejects 2025 openings, `2025` is served by
 * the same entry — the SDK pins the connection to the legacy era on an `initialize` opening and
 * never sends a 2026 byte to a 2025 client, so no separate code path is needed.
 */
export function serveStdio(
  factory: McpServerFactory,
  wire: WireMode,
  onerror: (err: Error) => void,
): StdioServerHandle {
  const opts: ServeStdioOptions = { onerror };
  if (wire === "2026-only") opts.legacy = "reject";
  return sdkServeStdio(factory, opts);
}

/**
 * Web-standard HTTP entry serving the 2026-07-28 revision per request, plus stateless 2025
 * serving unless `wire === "2026-only"`. The caller (http.ts) bridges node:http ↔ Request.
 */
export function createHttpHandler(
  factory: McpServerFactory,
  wire: WireMode,
  onerror: (err: Error) => void,
): McpHttpHandler {
  const opts: CreateMcpHandlerOptions = { onerror };
  if (wire === "2026-only") opts.legacy = "reject";
  return sdkCreateMcpHandler(factory, opts);
}

/** `true` when a web `Request` carries no 2026 per-request envelope claim (a 2025-era client). */
export const isLegacyRequest: (request: Request) => Promise<boolean> = sdkIsLegacyRequest;
