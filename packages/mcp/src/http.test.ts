import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CallToolResult,
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorize,
  HTTP_BODY_MAX_BYTES,
  type HttpHandle,
  isLoopbackHost,
  parseHostPort,
  startHttp,
} from "./http.js";
import { createLogger } from "./log.js";
import { createRootsPolicy } from "./roots.js";
import { serverFactory } from "./server.js";
import { makePlan, structured, tmpRepo } from "./test-helpers.js";
import { TOOL_DEFS } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let handle: HttpHandle;
let lines: string[];
const clients: Client[] = [];

async function connect(
  opts: { token?: string; sessionId?: string; wire?: "2026" | "2025" | "auto" } = {},
) {
  const requestInit: RequestInit =
    opts.token === undefined ? {} : { headers: { authorization: `Bearer ${opts.token}` } };
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit,
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
  });
  // SDK v2 clients default to the 2025 `initialize` handshake; `2026` pins the modern era.
  const negotiation: ClientOptions["versionNegotiation"] =
    opts.wire === "2026"
      ? { mode: { pin: "2026-07-28" } }
      : opts.wire === "auto"
        ? { mode: "auto" }
        : { mode: "legacy" };
  const client = new Client(
    { name: "axiom-http-test", version: "0.0.0" },
    { versionNegotiation: negotiation },
  );
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function start(extra: Partial<Parameters<typeof startHttp>[1]> = {}) {
  lines = [];
  const log = createLogger({ level: "debug", write: (l) => void lines.push(l) });
  const policy = await createRootsPolicy([repo.root]);
  handle = await startHttp(serverFactory(policy, { log }), {
    host: "127.0.0.1",
    port: 0,
    log,
    ...extra,
  });
}

const raw = (init: RequestInit & { path?: string } = {}) =>
  fetch(new URL(init.path ?? "/mcp", handle.url), init);

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
});
const mcpHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

beforeEach(async () => {
  repo = await tmpRepo("axiom-http-");
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await handle?.close();
  await repo.cleanup();
});

describe("startHttp — MCP over Streamable HTTP", () => {
  it("initialize + tools/list (17 tools) + a tool call, through the SDK client", async () => {
    await start();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_DEFS.map((t) => t.name).sort());
    const r = (await client.callTool({
      name: "axiom_plan_validate",
      arguments: { plan: makePlan({ "a.txt": "hi\n" }) },
    })) as CallToolResult;
    expect(r.isError).toBeUndefined();
    expect(structured<{ ok: boolean }>(r).ok).toBe(true);
    expect(handle.sessions()).toBe(1);
    expect(lines.some((l) => JSON.parse(l).msg === "http listening")).toBe(true);
  });

  it("serves the 2026-07-28 era: pinned client, no session, cache hints stamped on tools/list", async () => {
    await start();
    const { client, transport } = await connect({ wire: "2026" });
    expect(client.getProtocolEra()).toBe("modern");
    expect(transport.sessionId).toBeUndefined();
    expect(handle.sessions()).toBe(0); // modern requests never open a legacy session
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    const r = (await client.callTool({
      name: "axiom_plan_validate",
      arguments: { plan: makePlan({ "a.txt": "hi\n" }) },
    })) as CallToolResult;
    expect(r.isError).toBeUndefined();
    expect(structured<{ ok: boolean }>(r).ok).toBe(true);
    // SEP-2549: the wire result carries ttlMs/cacheScope (hidden from the public type).
    const rawList = (await client.request({ method: "tools/list" })) as unknown as {
      ttlMs?: number;
      cacheScope?: string;
    };
    expect(rawList.ttlMs).toBe(300_000);
    expect(rawList.cacheScope).toBe("public");
    // Every modern response identifies the server (spec PR #3002).
    expect(client.getServerVersion()).toMatchObject({ name: "axiom", version: pkg.version });
  });

  it("serves both eras from one endpoint; `auto` clients land on modern", async () => {
    await start();
    const legacy = await connect({ wire: "2025" });
    const auto = await connect({ wire: "auto" });
    expect(legacy.client.getProtocolEra()).toBe("legacy");
    expect(auto.client.getProtocolEra()).toBe("modern");
    expect(handle.sessions()).toBe(1);
    for (const c of [legacy.client, auto.client]) {
      expect((await c.listTools()).tools).toHaveLength(17);
    }
  });

  it("--wire 2026-only refuses the 2025 handshake (unsupported protocol version) and pinned clients still connect", async () => {
    await start({ wire: "2026-only" });
    await expect(connect({ wire: "2025" })).rejects.toThrow();
    const init = await raw({ method: "POST", headers: mcpHeaders, body: initBody });
    expect(init.status).toBeGreaterThanOrEqual(400);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(handle.sessions()).toBe(0);
    const { client } = await connect({ wire: "2026" });
    expect(client.getProtocolEra()).toBe("modern");
    expect((await client.listTools()).tools).toHaveLength(17);
  });

  it("gives each client its own session and DELETE closes it", async () => {
    await start();
    const a = await connect();
    const b = await connect();
    expect(a.transport.sessionId).toBeDefined();
    expect(b.transport.sessionId).toBeDefined();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    expect(handle.sessions()).toBe(2);
    await a.transport.terminateSession();
    expect(handle.sessions()).toBe(1);
    // the terminated id is now unknown → 404
    const res = await raw({
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": a.transport.sessionId ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
    // b still works
    expect((await b.client.listTools()).tools).toHaveLength(17);
  });

  it("rejects a non-initialize request without a session id (400) and an unknown id (404)", async () => {
    await start();
    const noId = await raw({
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(noId.status).toBe(400);
    const unknown = await raw({
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": "nope" },
    });
    expect(unknown.status).toBe(404);
    const getNoId = await raw({ method: "GET", headers: { accept: "text/event-stream" } });
    expect(getNoId.status).toBe(400);
    expect(handle.sessions()).toBe(0);
  });

  it("opens ONE standalone SSE stream per session on GET (second is 409)", async () => {
    await start();
    // raw initialize so no SDK client is holding the session's GET stream yet
    const init = await raw({ method: "POST", headers: mcpHeaders, body: initBody });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    await init.body?.cancel();
    const sse = (signal: AbortSignal) =>
      raw({
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": sid ?? "",
          "mcp-protocol-version": "2025-06-18",
        },
        signal,
      });
    const ac = new AbortController();
    const res = await sse(ac.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const second = await sse(ac.signal);
    expect(second.status).toBe(409);
    ac.abort();
  });

  it("answers 413 for a body over 4 MiB and 404 JSON for unknown paths, 405 for PUT", async () => {
    await start();
    const big = await raw({
      method: "POST",
      headers: mcpHeaders,
      body: Buffer.alloc(HTTP_BODY_MAX_BYTES + 1024, 0x20),
    });
    expect(big.status).toBe(413);
    const nf = await raw({ path: "/nope" });
    expect(nf.status).toBe(404);
    expect(nf.headers.get("content-type")).toBe("application/json");
    const put = await raw({ method: "PUT", headers: mcpHeaders, body: initBody });
    expect(put.status).toBe(405);
  });

  it("GET /health is 200 without a token even when a token is required", async () => {
    await start({ token: "0123456789abcdef-secret" });
    const res = await raw({ path: "/health" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "axiom", version: pkg.version });
    const unauth = await raw({ method: "POST", headers: mcpHeaders, body: initBody });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("Bearer");
    const { client } = await connect({ token: "0123456789abcdef-secret" });
    expect((await client.listTools()).tools).toHaveLength(17);
  });

  it("DNS-rebinding protection: a foreign Host header is rejected on a loopback bind", async () => {
    await start();
    // undici's fetch drops a user-set Host header, so go through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: handle.host,
          port: handle.port,
          path: "/mcp",
          method: "POST",
          headers: { ...mcpHeaders, host: "evil.example:80" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(initBody);
    });
    expect(status).toBe(403);
  });

  it("evicts idle sessions", async () => {
    await start({ idleMs: 50, sweepMs: 20 });
    const { transport } = await connect();
    expect(handle.sessions()).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(handle.sessions()).toBe(0);
    const res = await raw({
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": transport.sessionId ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses to start on a non-loopback host without a token (ERR_INTERNAL)", async () => {
    const log = createLogger({ write: () => {} });
    const policy = await createRootsPolicy([repo.root]);
    await expect(
      startHttp(serverFactory(policy), { host: "0.0.0.0", port: 0, log }),
    ).rejects.toMatchObject({ code: "ERR_INTERNAL" });
    await expect(
      startHttp(serverFactory(policy), { host: "127.0.0.1", port: 0, log, token: "short" }),
    ).rejects.toMatchObject({ code: "ERR_INTERNAL" });
  });
});

describe("authorize (bearer, constant-time)", () => {
  const token = "0123456789abcdef-secret";
  it("passes when no token is configured", () => {
    expect(authorize(undefined, undefined)).toBe(true);
  });
  it("rejects a missing header", () => {
    expect(authorize(token, undefined)).toBe(false);
  });
  it("rejects a wrong token, wrong scheme and a prefix", () => {
    expect(authorize(token, "Bearer nope")).toBe(false);
    expect(authorize(token, `Basic ${token}`)).toBe(false);
    expect(authorize(token, `Bearer ${token.slice(0, -1)}`)).toBe(false);
    expect(authorize(token, `Bearer ${token}x`)).toBe(false);
  });
  it("accepts the right token (scheme case-insensitive)", () => {
    expect(authorize(token, `Bearer ${token}`)).toBe(true);
    expect(authorize(token, `bearer ${token}`)).toBe(true);
  });
});

describe("parseHostPort / isLoopbackHost", () => {
  it("parses host:port, :port, bare port and bracketed IPv6", () => {
    expect(parseHostPort("127.0.0.1:3411")).toEqual({ host: "127.0.0.1", port: 3411 });
    expect(parseHostPort(":8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(parseHostPort("0")).toEqual({ host: "127.0.0.1", port: 0 });
    expect(parseHostPort("[::1]:9")).toEqual({ host: "::1", port: 9 });
  });
  it("rejects garbage with ERR_INTERNAL", () => {
    for (const bad of ["", "host:", "a:b", "1.2.3.4:70000", "[::1]"]) {
      expect(() => parseHostPort(bad)).toThrow(expect.objectContaining({ code: "ERR_INTERNAL" }));
    }
  });
  it("classifies loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("built http-lazy chunk", () => {
  it("contains no express/hono runtime and is not statically imported by cli-main", async () => {
    const dist = join(here, "..", "dist");
    const lazy = await readFile(join(dist, "http-lazy.js"), "utf8").catch(() => undefined);
    if (lazy === undefined) {
      // dist absent (fresh checkout without build): the guards run this after `pnpm build`.
      expect(lazy).toBeUndefined();
      return;
    }
    expect(lazy).not.toMatch(/from\s+["'](?:express|hono|@hono\/[^"']+)["']/);
    expect(lazy).not.toMatch(/require\(["'](?:express|hono|@hono\/[^"']+)["']\)/);
    expect(lazy).toContain("Mcp-Session-Id");
    const main = await readFile(join(dist, "cli-main.js"), "utf8");
    expect(main).toMatch(/import\(["']\.\/http-lazy\.js["']\)/);
    expect(main).not.toMatch(/^import\b[^\n]*["']\.\/http-lazy\.js["']/m);
  });
});
