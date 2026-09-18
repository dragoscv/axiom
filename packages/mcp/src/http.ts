/**
 * Streamable HTTP transport (v2-architecture §5.4) on plain `node:http`.
 *
 * One `StreamableHTTPServerTransport` per MCP session, keyed by `mcp-session-id`; idle sessions
 * are evicted. The SDK's node wrapper pulls in `@hono/node-server`, so we use the web-standard
 * transport directly and bridge `IncomingMessage`/`ServerResponse` ↔ `Request`/`Response` here —
 * the built `http-lazy.js` chunk must contain no express/hono runtime (asserted in http.test.ts).
 *
 * Security: binds loopback by default; a non-loopback host REQUIRES a bearer token (constant-time
 * compare); DNS-rebinding protection (Host allowlist) is on for loopback binds; body ≤ 4 MiB.
 * `GET /health` is unauthenticated (probes + the conformance harness). Logs go to stderr only.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { AxiomError } from "@codai/axiom-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "./log.js";
import { SERVER_VERSION } from "./server.js";

export const HTTP_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const HTTP_DEFAULT_HOST = "127.0.0.1";
export const HTTP_TOKEN_ENV_DEFAULT = "AXIOM_HTTP_TOKEN";

export interface StartHttpOptions {
  host?: string;
  port: number;
  /** Bearer token. Mandatory when `host` is not loopback. */
  token?: string;
  log: Logger;
  /** Test hook — idle eviction window. */
  idleMs?: number;
  /** Test hook — sweep interval. */
  sweepMs?: number;
}

/**
 * An SDK `McpServer` (its `Protocol`) binds to exactly one transport, and a Streamable HTTP
 * session IS a transport — so every session gets its own server instance from this factory
 * (the SDK's own multi-session example does the same). `createServer(policy, …)` is cheap.
 */
export type ServerFactory = () => McpServer;

export interface HttpHandle {
  url: string;
  host: string;
  port: number;
  sessions(): number;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  const v = isIP(h);
  if (v === 4) return h.startsWith("127.");
  if (v === 6) return h === "::1" || /^(?:0*:)+0*1$/.test(h) || /^::ffff:127\./i.test(h);
  return false;
}

/** `host:port` (or `:port` / `port`) → parts. Port 0 = ephemeral. */
export function parseHostPort(spec: string): { host: string; port: number } {
  const s = spec.trim();
  let host = HTTP_DEFAULT_HOST;
  let portText = s;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0 || s[end + 1] !== ":") throw usage(spec);
    host = s.slice(1, end);
    portText = s.slice(end + 2);
  } else {
    const i = s.lastIndexOf(":");
    if (i >= 0) {
      if (i > 0) host = s.slice(0, i);
      portText = s.slice(i + 1);
    }
  }
  if (!/^\d{1,5}$/.test(portText)) throw usage(spec);
  const port = Number(portText);
  if (port > 65535 || host.length === 0) throw usage(spec);
  return { host, port };
}

function usage(spec: string): AxiomError {
  return new AxiomError("ERR_INTERNAL", `--http expects <host:port> or <port>, got "${spec}"`);
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time bearer check. `undefined` token = auth disabled. Exported for unit tests. */
export function authorize(token: string | undefined, authorization: string | undefined): boolean {
  if (token === undefined) return true;
  if (authorization === undefined) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (m === null || m[1] === undefined) return false;
  return timingSafeEqual(sha(token), sha(m[1]));
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

function jsonError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(req: IncomingMessage, base: string, body: Buffer | undefined): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  const init: RequestInit & { duplex?: "half" } = { method: req.method ?? "GET", headers };
  if (body !== undefined && body.length > 0) init.body = new Uint8Array(body);
  return new Request(new URL(req.url ?? "/", base), init);
}

async function pipeResponse(
  web: Response,
  res: ServerResponse,
  req: IncomingMessage,
): Promise<void> {
  const headers: Record<string, string> = {};
  web.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(web.status, headers);
  if (web.body === null) {
    res.end();
    return;
  }
  // Streams (SSE) may stay silent for a while; the client needs the headers now.
  res.flushHeaders();
  const node = Readable.fromWeb(web.body as import("node:stream/web").ReadableStream);
  const abort = () => node.destroy();
  req.on("close", abort);
  await new Promise<void>((resolve) => {
    node.on("error", () => {
      res.end();
      resolve();
    });
    node.on("end", () => {
      res.end();
      resolve();
    });
    node.on("data", (chunk: Buffer) => {
      res.write(chunk);
    });
  });
  req.off("close", abort);
}

export async function startHttp(
  server: ServerFactory,
  opts: StartHttpOptions,
): Promise<HttpHandle> {
  const host = opts.host ?? HTTP_DEFAULT_HOST;
  const loopback = isLoopbackHost(host);
  const { log } = opts;
  if (!loopback && opts.token === undefined) {
    throw new AxiomError(
      "ERR_INTERNAL",
      `refusing to bind ${host}: a non-loopback --http host requires a bearer token (set the env var named by --http-token-env, default ${HTTP_TOKEN_ENV_DEFAULT})`,
    );
  }
  if (opts.token !== undefined && opts.token.length < 16) {
    throw new AxiomError("ERR_INTERNAL", "http bearer token must be at least 16 characters");
  }
  const idleMs = opts.idleMs ?? HTTP_SESSION_IDLE_MS;
  const sessions = new Map<string, Session>();

  return new Promise<HttpHandle>((resolve, reject) => {
    let base = `http://${host}:${opts.port}`;
    let allowedHosts: string[] | undefined;

    const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!authorize(opts.token, req.headers.authorization)) {
        res.setHeader("www-authenticate", 'Bearer realm="axiom"');
        jsonError(res, 401, -32000, "Unauthorized");
        return;
      }
      const method = req.method ?? "GET";
      if (method !== "POST" && method !== "GET" && method !== "DELETE") {
        res.setHeader("allow", "GET, POST, DELETE");
        jsonError(res, 405, -32000, "Method not allowed");
        return;
      }
      let body: Buffer | undefined;
      if (method === "POST") {
        try {
          body = await readBody(req, HTTP_BODY_MAX_BYTES);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            jsonError(res, 413, -32000, `Payload too large (max ${HTTP_BODY_MAX_BYTES} bytes)`);
            return;
          }
          throw err;
        }
      }
      const sidHeader = req.headers["mcp-session-id"];
      const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
      const session = sid === undefined ? undefined : sessions.get(sid);
      if (session === undefined) {
        if (sid !== undefined) {
          jsonError(res, 404, -32001, "Session not found");
          return;
        }
        if (method !== "POST") {
          jsonError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
          return;
        }
        // New session: the SDK validates that this POST is an `initialize`.
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          ...(allowedHosts === undefined
            ? {}
            : { enableDnsRebindingProtection: true, allowedHosts }),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastSeen: Date.now() });
            log.info("http session opened", { sessionId: id, sessions: sessions.size });
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
            log.info("http session closed", { sessionId: id, sessions: sessions.size });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
        };
        transport.onerror = (err) => log.warn("http transport error", { error: err.message });
        const mcp = server();
        await mcp.connect(transport);
        const web = await transport.handleRequest(toWebRequest(req, base, body));
        if (transport.sessionId === undefined) {
          // not an initialize (or it failed): the SDK already produced the 4xx
          await mcp.close();
        }
        await pipeResponse(web, res, req);
        return;
      }
      session.lastSeen = Date.now();
      const web = await session.transport.handleRequest(toWebRequest(req, base, body));
      await pipeResponse(web, res, req);
    };

    const httpServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", base);
      const done = (p: Promise<void>) =>
        p.catch((err: unknown) => {
          log.warn("http request failed", { path: url.pathname, error: String(err) });
          if (!res.headersSent) jsonError(res, 500, -32603, "Internal error");
          else res.end();
        });
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "axiom", version: SERVER_VERSION }));
        return;
      }
      if (url.pathname === "/mcp") {
        void done(handleMcp(req, res));
        return;
      }
      jsonError(res, 404, -32601, "Not found");
    });
    httpServer.requestTimeout = 0; // SSE streams are long-lived
    httpServer.headersTimeout = 60_000;

    const sweep = setInterval(() => {
      const cutoff = Date.now() - idleMs;
      for (const [id, s] of sessions) {
        if (s.lastSeen < cutoff) {
          sessions.delete(id);
          log.info("http session evicted (idle)", { sessionId: id });
          void s.transport.close();
        }
      }
    }, opts.sweepMs ?? Math.min(idleMs, 60_000));
    sweep.unref();

    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      const urlHost = host.includes(":") ? `[${host}]` : host;
      base = `http://${urlHost}:${port}`;
      if (loopback) {
        allowedHosts = [
          ...new Set([
            `${urlHost}:${port}`,
            `localhost:${port}`,
            `127.0.0.1:${port}`,
            `[::1]:${port}`,
          ]),
        ];
      }
      log.info("http listening", {
        url: `${base}/mcp`,
        host,
        port,
        auth: opts.token !== undefined,
      });
      resolve({
        url: `${base}/mcp`,
        host,
        port,
        sessions: () => sessions.size,
        close: async () => {
          clearInterval(sweep);
          const open = [...sessions.values()];
          sessions.clear();
          await Promise.all(open.map((s) => s.transport.close().catch(() => undefined)));
          httpServer.closeAllConnections();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}
