import { lockStatus } from "@codai/axiom-apply";
import { loadProfile } from "@codai/axiom-checks";
import type { EmitterRegistry } from "@codai/axiom-plan";
import { type ErrorCode, isAxiomError } from "@codai/axiom-schema";
import { z } from "zod";
import {
  CACHE_HINTS,
  type CallToolResult,
  elicitConfirm,
  type InputRequiredResult,
  McpServer,
  type McpServerFactory,
  pendingInputOf,
  ResourceNotFoundError,
  ResourceTemplate,
  type WireEra,
} from "./adapter.js";
import { emitterCatalogue, NO_EMITTERS } from "./emitters.js";
import { isSchemaKind, jsonSchemaFor, SCHEMA_KINDS } from "./jsonschema.js";
import { type Logger, silentLogger } from "./log.js";
import type { RootsPolicy } from "./roots.js";
import { listStored, loadApplied, loadManifest, loadReport, toDigestRef } from "./store.js";
import { PlanSessionStore, TaskStore } from "./tasks.js";
import { type AnyToolDef, type ToolContext, toolsFor } from "./tools.js";
import type { Toolset } from "./toolset.js";
import { PACKAGE_VERSION } from "./version.js";

export const SERVER_NAME = "axiom";
export const SERVER_VERSION: string = PACKAGE_VERSION;

/**
 * MC-18: the one paragraph a client reads before its first tool call. The tool descriptions say
 * what each tool does; this says what the SERVER is for and the two rules that apply to all of
 * them — without it an agent discovered `axiom_write` by trying it.
 */
export const SERVER_INSTRUCTIONS = [
  "AXIOM is a transactional write gate: it compiles a Plan into a canonical Manifest, judges it",
  "with the repository's checks and then applies it atomically with a journal and rollback.",
  "",
  "Rules that apply to every tool here:",
  "1. Never write the files of a change directly when a gate is active: build the change with",
  "   `axiom_write` (or `plan_compile` + `axiom_apply`) so it is checked, journaled and reversible.",
  "2. `axiom_apply` is two-phase and destructive: ALWAYS inspect the dry run first, then pass the",
  "   `confirmDigest` the dry run returned. A digest that does not match is refused.",
].join("\n");
export { DEFAULT_TOOLSET, parseToolset, TOOLSETS, type Toolset } from "./toolset.js";

export interface CreateServerOptions {
  log?: Logger;
  /** Explicit tool list (tests); wins over `toolset`. */
  tools?: readonly AnyToolDef[];
  /** D-43: `core` (default — 6 tools) or `full` (every registered tool). `--tools core|full`. */
  toolset?: Toolset;
  /** Template emitters loaded via `--emitter <pkg>` (D-45); absent → none. */
  emitters?: EmitterRegistry;
  /** `--allow-guards` / `--guard-allowlist` (§3.2). Omit to keep guards disabled. */
  guards?: ToolContext["guards"];
  /** Wire era this instance will serve (set by the serving entry; `legacy` when hand-connected). */
  era?: WireEra;
  /**
   * Roots discovered via tool calls (sub-roots of the allowlist). Shared across the instances a
   * factory builds so a digest compiled on one 2026-era HTTP request is loadable on the next.
   */
  seenRoots?: Set<string>;
  /** Background check tasks (S-406). Shared across a factory's instances; a fresh store per server otherwise. */
  tasks?: TaskStore;
  /** Chunked plan sessions (S-406). Shared like `tasks`. */
  planSessions?: PlanSessionStore;
  /**
   * `--require-human` (S-1206): refuse the confirm step of `axiom_apply` / `axiom_write` when
   * the client cannot elicit (ERR_CONFIRM_DIGEST_MISMATCH `{ reason: "elicitation-unsupported" }`).
   */
  requireHuman?: boolean;
}

export interface StructuredError {
  code: ErrorCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export function toStructuredError(err: unknown): StructuredError {
  // MC-3: a cross-chunk `instanceof` failed and every tool error became ERR_INTERNAL, losing the
  // code the caller dispatches on. `isAxiomError` matches `name` + a code from the closed enum.
  // Fields, not `toJSON()`: an error raised in another chunk carries the shape, not the methods.
  if (isAxiomError(err)) {
    return {
      code: err.code,
      message: err.message,
      ...(err.path === undefined ? {} : { path: err.path }),
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }
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

/**
 * MC-2: the error object a failed call returns as its `structuredContent`. Without it the result
 * VIOLATED the `outputSchema` the tool announces (every tool declares a value schema), and a
 * conforming SDK client throws "Structured content does not match the tool's output schema"
 * instead of surfacing the error. `toolOutputSchema` therefore declares the real contract: the
 * tool's value, OR this error object (the failure also carries `isError: true`).
 */
export const TOOL_ERROR_SCHEMA = z
  .looseObject({
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
    details: z.unknown().optional(),
  })
  .describe("Error object of a failed call (isError: true)");

/** The schema advertised and enforced for one tool: its value, or {@link TOOL_ERROR_SCHEMA}. */
export function toolOutputSchema<T extends z.ZodType>(value: T): z.ZodType {
  return z.union([value, TOOL_ERROR_SCHEMA]);
}

/**
 * Wrap a tool handler: never throws; AxiomError → isError result with the closed code. With
 * `server`, each call gets an elicitation seam bound to its request context (S-1206); a pending
 * human confirmation is returned as the SDK's `input_required` result.
 */
export function wrapHandler(def: AnyToolDef, ctx: ToolContext, server?: McpServer) {
  return async (input: unknown, extra?: unknown): Promise<CallToolResult | InputRequiredResult> => {
    const callCtx: ToolContext =
      server === undefined ? ctx : { ...ctx, elicit: (req) => elicitConfirm(server, extra, req) };
    try {
      const output = await def.handler(callCtx, input as never);
      // Validate against the VALUE half: the union of the advertised schema also accepts
      // `TOOL_ERROR_SCHEMA`, which a successful handler must never produce.
      const structured = def.outputSchema.parse(output) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(def.summarize(structured)) }],
        structuredContent: structured,
      };
    } catch (err) {
      const pending = pendingInputOf(err);
      if (pending !== undefined) return pending;
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
  // MC-6: an unknown URI is a bad PARAMETER, and the SDK's own error carries the spec's code
  // (-32602). A plain AxiomError was flattened to -32603 (internal error), so a client could not
  // tell "you asked for something that does not exist" from "the server is broken" (SEP-2164).
  throw new ResourceNotFoundError(uri);
}

export function createServer(policy: RootsPolicy, opts: CreateServerOptions = {}): McpServer {
  const log = opts.log ?? silentLogger;
  const ctx: ToolContext = {
    policy,
    log,
    seenRoots: opts.seenRoots ?? new Set(),
    tasks: opts.tasks ?? new TaskStore(),
    planSessions: opts.planSessions ?? new PlanSessionStore(),
  };
  if (opts.guards !== undefined) ctx.guards = opts.guards;
  if (opts.requireHuman === true) ctx.requireHuman = true;
  if (opts.emitters !== undefined) ctx.emitters = opts.emitters;
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "AXIOM write gate",
      websiteUrl: "https://axiom.codai.ro",
    },
    // AXIOM's catalogue never changes at runtime: say so (SDK v2 would otherwise advertise
    // `listChanged: true` for every declared primitive). cacheHints only reach 2026-era wires.
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      cacheHints: CACHE_HINTS,
      // MC-18: what the server is for, and the two rules a client must follow. The tool
      // descriptions cover each tool; this is the part that applies to all of them, and it is the
      // one place a client reads before its first call.
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  for (const def of opts.tools ?? toolsFor(opts.toolset ?? "core")) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // SDK v2 wants Standard Schema objects; the raw-shape overload is deprecated and would
        // wrap with the SDK's bundled zod. Wrap with OUR zod so `.describe()` docs survive.
        inputSchema: z.object(def.inputSchema),
        outputSchema: toolOutputSchema(def.outputSchema),
        annotations: { title: def.title, ...def.annotations },
        ...(def.meta === undefined ? {} : { _meta: { ...def.meta } }),
      },
      wrapHandler(def, ctx, server) as never,
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
    async (uri) => json(uri.href, emitterCatalogue(opts.emitters ?? NO_EMITTERS)),
  );

  // S-706: lock holder / queue / intents of every allowlisted root (read-only, never locks).
  server.registerResource(
    "lock",
    "axiom://lock",
    {
      title: "Lock status of every allowlisted root (holder, queue, intents)",
      mimeType: "application/json",
    },
    async (uri) => {
      const roots = [];
      for (const root of [...policy.roots].sort())
        roots.push({ root, ...(await lockStatus(root)) });
      return json(uri.href, { roots });
    },
  );

  log.info("server created", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    era: opts.era ?? "legacy",
    toolset: opts.tools === undefined ? (opts.toolset ?? "core") : "custom",
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
  const tasks = opts.tasks ?? new TaskStore();
  const planSessions = opts.planSessions ?? new PlanSessionStore();
  return ({ era }) => createServer(policy, { ...opts, seenRoots, tasks, planSessions, era });
}
