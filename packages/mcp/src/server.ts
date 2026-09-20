import { createRequire } from "node:module";
import { loadProfile } from "@codai/axiom-checks";
import { AxiomError, type ErrorCode } from "@codai/axiom-schema";
import { z } from "zod";
import {
  CACHE_HINTS,
  type CallToolResult,
  McpServer,
  type McpServerFactory,
  ResourceTemplate,
  type WireEra,
} from "./adapter.js";
import { emitterCatalogue } from "./emitters.js";
import { isSchemaKind, jsonSchemaFor, SCHEMA_KINDS } from "./jsonschema.js";
import { type Logger, silentLogger } from "./log.js";
import type { RootsPolicy } from "./roots.js";
import { listStored, loadApplied, loadManifest, loadReport, toDigestRef } from "./store.js";
import { type AnyToolDef, TOOL_DEFS, type ToolContext } from "./tools.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const SERVER_NAME = "axiom";
export const SERVER_VERSION: string = pkg.version;

export interface CreateServerOptions {
  log?: Logger;
  tools?: readonly AnyToolDef[];
  /** `--allow-guards` / `--guard-allowlist` (§3.2). Omit to keep guards disabled. */
  guards?: ToolContext["guards"];
  /** Wire era this instance will serve (set by the serving entry; `legacy` when hand-connected). */
  era?: WireEra;
  /**
   * Roots discovered via tool calls (sub-roots of the allowlist). Shared across the instances a
   * factory builds so a digest compiled on one 2026-era HTTP request is loadable on the next.
   */
  seenRoots?: Set<string>;
}

export interface StructuredError {
  code: ErrorCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof AxiomError) return err.toJSON();
  if (err instanceof z.ZodError) {
    return {
      code: "ERR_INVALID_PLAN",
      message: "input does not match schema",
      details: {
        issues: err.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  return { code: "ERR_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

function errorResult(err: unknown): CallToolResult {
  const structured = toStructuredError(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
}

/** Wrap a tool handler: never throws; AxiomError → isError result with the closed code. */
export function wrapHandler(def: AnyToolDef, ctx: ToolContext) {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const output = await def.handler(ctx, input as never);
      const structured = def.outputSchema.parse(output) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(def.summarize(structured)) }],
        structuredContent: structured,
      };
    } catch (err) {
      ctx.log.warn("tool failed", { tool: def.name, error: toStructuredError(err) });
      return errorResult(err);
    }
  };
}

function json(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  };
}

function notFound(uri: string): never {
  throw new AxiomError("ERR_NOT_FOUND", `resource not found: ${uri}`);
}

export function createServer(policy: RootsPolicy, opts: CreateServerOptions = {}): McpServer {
  const log = opts.log ?? silentLogger;
  const ctx: ToolContext = { policy, log, seenRoots: opts.seenRoots ?? new Set() };
  if (opts.guards !== undefined) ctx.guards = opts.guards;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // AXIOM's catalogue never changes at runtime: say so (SDK v2 would otherwise advertise
    // `listChanged: true` for every declared primitive). cacheHints only reach 2026-era wires.
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      cacheHints: CACHE_HINTS,
    },
  );

  for (const def of opts.tools ?? TOOL_DEFS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // SDK v2 wants Standard Schema objects; the raw-shape overload is deprecated and would
        // wrap with the SDK's bundled zod. Wrap with OUR zod so `.describe()` docs survive.
        inputSchema: z.object(def.inputSchema),
        outputSchema: def.outputSchema,
        annotations: { title: def.title, ...def.annotations },
      },
      wrapHandler(def, ctx) as never,
    );
  }

  const allRoots = () => new Set([...policy.roots, ...ctx.seenRoots]);
  const listOf = (sub: "manifests" | "reports" | "applied", scheme: string) => async () => {
    const items = await listStored(allRoots(), sub);
    return {
      resources: items.map((i) => ({
        uri: `axiom://${scheme}/${i.sha}`,
        name: i.sha,
        mimeType: "application/json",
      })),
    };
  };

  server.registerResource(
    "manifest",
    new ResourceTemplate("axiom://manifest/{sha}", { list: listOf("manifests", "manifest") }),
    { title: "Stored ManifestBundle", mimeType: "application/json" },
    async (uri, { sha }) => {
      const found = await loadManifest(allRoots(), toDigestRef(String(sha)));
      return found === undefined ? notFound(uri.href) : json(uri.href, found);
    },
  );
  server.registerResource(
    "report",
    new ResourceTemplate("axiom://report/{sha}", { list: listOf("reports", "report") }),
    { title: "Last CheckReport for a manifest", mimeType: "application/json" },
    async (uri, { sha }) => {
      const found = await loadReport(allRoots(), toDigestRef(String(sha)));
      return found === undefined ? notFound(uri.href) : json(uri.href, found);
    },
  );
  server.registerResource(
    "applied",
    new ResourceTemplate("axiom://applied/{sha}", { list: listOf("applied", "applied") }),
    { title: "ApplyResult of an applied manifest", mimeType: "application/json" },
    async (uri, { sha }) => {
      const found = await loadApplied(allRoots(), toDigestRef(String(sha)));
      return found === undefined ? notFound(uri.href) : json(uri.href, found);
    },
  );
  server.registerResource(
    "profile",
    new ResourceTemplate("axiom://profile/{name}", {
      list: async () => ({
        resources: ["default", "strict", "permissive"].map((n) => ({
          uri: `axiom://profile/${n}`,
          name: n,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Resolved check profile", mimeType: "application/json" },
    async (uri, { name }) => {
      const searchDirs = [...policy.roots].map((r) => `${r}/.axiom/profiles`);
      return json(uri.href, await loadProfile(String(name), { searchDirs }));
    },
  );
  server.registerResource(
    "schema",
    new ResourceTemplate("axiom://schema/{kind}", {
      list: async () => ({
        resources: SCHEMA_KINDS.map((k) => ({
          uri: `axiom://schema/${k}`,
          name: k,
          mimeType: "application/schema+json",
        })),
      }),
      complete: {
        kind: (v) => SCHEMA_KINDS.filter((k) => k.toLowerCase().startsWith(v.toLowerCase())),
      },
    }),
    { title: "JSON Schema (draft 2020-12)", mimeType: "application/schema+json" },
    async (uri, { kind }) => {
      const k = String(kind);
      if (!isSchemaKind(k)) notFound(uri.href);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/schema+json",
            text: JSON.stringify(jsonSchemaFor(k), null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "emitters",
    "axiom://emitters",
    {
      title: "Template emitters available to axiom_plan_compile",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, emitterCatalogue()),
  );

  log.info("server created", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    era: opts.era ?? "legacy",
    roots: [...policy.roots],
  });
  return server;
}

/**
 * Factory for the SDK serving entries (`serveStdio` / `createMcpHandler`): one fresh instance per
 * connection (stdio) or per request (HTTP), each told the era it is about to serve. Tool state
 * that must outlive an instance (`seenRoots`, guard settings) lives in `policy` / `opts`, which
 * every instance shares.
 */
export function serverFactory(
  policy: RootsPolicy,
  opts: Omit<CreateServerOptions, "era"> = {},
): McpServerFactory {
  const seenRoots = opts.seenRoots ?? new Set<string>();
  return ({ era }) => createServer(policy, { ...opts, seenRoots, era });
}
