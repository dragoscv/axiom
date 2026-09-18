import { createRequire } from "node:module";
import { loadProfile } from "@codai/axiom-checks";
import { AxiomError, type ErrorCode } from "@codai/axiom-schema";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
  const ctx: ToolContext = { policy, log, seenRoots: new Set() };
  if (opts.guards !== undefined) ctx.guards = opts.guards;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  for (const def of opts.tools ?? TOOL_DEFS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
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

  log.info("server created", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    roots: [...policy.roots],
  });
  return server;
}
