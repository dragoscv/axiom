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
 * - Server → client input (elicitation) is the multi-round-trip `inputRequired(...)` return on
 *   BOTH eras: a 2026-07-28 client fulfils it and retries the call with `inputResponses`; on a
 *   2025 connection the SDK's legacy shim sends a real `elicitation/create` and re-enters the
 *   handler. `ctx.mcpReq.elicitInput` is deprecated and throws on 2026-era requests (S-1206).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  type CreateMcpHandlerOptions,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
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
  InputRequiredResult,
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

// --- human confirmation via elicitation (S-1206) -------------------------------------------

/** Flat form schema accepted by MCP form-mode elicitation (primitive properties only). */
export type ElicitFormSchema = ElicitRequestFormParams["requestedSchema"];

export interface ElicitConfirmRequest {
  /** Value the answer is bound to (AXIOM: the manifestDigest); a stale/forged round never matches. */
  binding: string;
  message: string;
  requestedSchema: ElicitFormSchema;
}

export interface ElicitConfirmResult {
  /** `unsupported`: the client declared no form elicitation (or this call has no request context). */
  action: "accept" | "decline" | "cancel" | "unsupported";
  content?: Record<string, unknown>;
}

/** Key of the single embedded input request AXIOM ever sends. */
export const ELICIT_CONFIRM_KEY = "axiom_confirm";
/** A confirmation round older than this is asked again (the requestState carries its mint time). */
export const ELICIT_STATE_TTL_MS = 15 * 60_000;

const STATE_PREFIX = "axc1";
// Per-process key: requestState round-trips through the client and is attacker-controlled
// (spec basic/patterns/mrtr §Server Requirements) — it is HMAC-bound to the binding.
const STATE_KEY = randomBytes(32);

function stateMac(binding: string, t: string, nonce: string): string {
  return createHmac("sha256", STATE_KEY).update(`${binding}\0${t}\0${nonce}`).digest("base64url");
}

function mintState(binding: string, now: number): string {
  const t = now.toString(36);
  const nonce = randomBytes(12).toString("base64url");
  return `${STATE_PREFIX}.${t}.${nonce}.${stateMac(binding, t, nonce)}`;
}

function stateValid(state: unknown, binding: string, now: number): boolean {
  if (typeof state !== "string") return false;
  const parts = state.split(".");
  if (parts.length !== 4 || parts[0] !== STATE_PREFIX) return false;
  const [, t = "", nonce = "", mac = ""] = parts;
  const minted = Number.parseInt(t, 36);
  if (!Number.isFinite(minted) || now - minted > ELICIT_STATE_TTL_MS || minted > now + 60_000)
    return false;
  const want = Buffer.from(stateMac(binding, t, nonce));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

interface RequestCtxLike {
  mcpReq: {
    envelope?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    requestState: () => unknown;
  };
}

function isRequestCtx(v: unknown): v is RequestCtxLike {
  if (typeof v !== "object" || v === null) return false;
  const req = (v as { mcpReq?: unknown }).mcpReq;
  return (
    typeof req === "object" &&
    req !== null &&
    typeof (req as { requestState?: unknown }).requestState === "function"
  );
}

/** Form-mode support under the SDK's own lenient rule: a bare `elicitation: {}` means form. */
function supportsFormElicitation(caps: unknown): boolean {
  if (typeof caps !== "object" || caps === null) return false;
  const el = (caps as { elicitation?: unknown }).elicitation;
  if (typeof el !== "object" || el === null) return false;
  const modes = el as { form?: unknown; url?: unknown };
  return modes.form !== undefined || modes.url === undefined;
}

/**
 * Thrown by {@link elicitConfirm} when the human has not answered yet: the tool callback must
 * return {@link ElicitPending.result} as-is (the SDK turns it into an `input_required` round).
 */
export class ElicitPending extends Error {
  readonly result: InputRequiredResult;
  constructor(result: InputRequiredResult) {
    super("elicitation pending");
    this.name = "ElicitPending";
    this.result = result;
  }
}

/** The `input_required` result to return when `err` is an {@link ElicitPending}, else `undefined`. */
export function pendingInputOf(err: unknown): InputRequiredResult | undefined {
  return err instanceof ElicitPending ? err.result : undefined;
}

/**
 * Ask the human behind the client to confirm, era-neutrally (S-1206).
 *
 * `server` is the instance serving the call, `extra` the tool callback's second argument
 * (`ServerContext`). Resolves with the human's answer once the round carrying it arrives;
 * throws {@link ElicitPending} on the round that must ask (return its `result` from the tool
 * callback). `unsupported` when the client declared no form elicitation — on 2026-era requests
 * the capability comes from the per-request envelope, on 2025 connections from `initialize`
 * (stateless 2025 instances that never saw `initialize` therefore report `unsupported`).
 * The answer is trusted only together with a requestState this process minted for `binding`.
 */
export async function elicitConfirm(
  server: McpServer,
  extra: unknown,
  req: ElicitConfirmRequest,
): Promise<ElicitConfirmResult> {
  if (!isRequestCtx(extra)) return { action: "unsupported" };
  const envelopeCaps = extra.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY];
  const caps = envelopeCaps ?? server.server.getClientCapabilities();
  if (!supportsFormElicitation(caps)) return { action: "unsupported" };

  const now = Date.now();
  if (stateValid(extra.mcpReq.requestState(), req.binding, now)) {
    const answer = inputResponse(extra.mcpReq.inputResponses, ELICIT_CONFIRM_KEY);
    if (answer.kind === "elicit") {
      return answer.content === undefined
        ? { action: answer.action }
        : { action: answer.action, content: answer.content };
    }
  }
  throw new ElicitPending(
    inputRequired({
      inputRequests: {
        [ELICIT_CONFIRM_KEY]: inputRequired.elicit({
          message: req.message,
          requestedSchema: req.requestedSchema,
        }),
      },
      requestState: mintState(req.binding, now),
    }),
  );
}
