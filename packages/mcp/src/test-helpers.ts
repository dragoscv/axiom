import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanInput } from "@codai/axiom-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { silentLogger } from "./log.js";
import { createRootsPolicy, type RootsPolicy } from "./roots.js";
import { createServer } from "./server.js";

export interface TmpRepo {
  root: string;
  cleanup: () => Promise<void>;
}

/** Fresh temp directory; `cleanup()` removes it. (Local copy — mcp may not depend on testkit.) */
export async function tmpRepo(prefix = "axiom-mcp-"): Promise<TmpRepo> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 }) };
}

/** `{ path: utf8 content }` → PlanInput. */
export function makePlan(files: Record<string, string>, opts: { name?: string } = {}): PlanInput {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Plan",
    name: opts.name ?? "fixture",
    intent: "mcp test fixture",
    artifacts: Object.entries(files).map(([path, content]) => ({
      path,
      source: { type: "inline", content },
    })),
  };
}

export interface Harness {
  client: Client;
  policy: RootsPolicy;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

/** In-process client ↔ server over a linked InMemoryTransport pair. */
export async function harness(roots: readonly string[]): Promise<Harness> {
  const policy = await createRootsPolicy(roots);
  const server = createServer(policy, { log: silentLogger });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "axiom-test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    policy,
    call: (name, args = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function structured<T = Record<string, unknown>>(r: CallToolResult): T {
  return r.structuredContent as T;
}

export function textOf(r: CallToolResult): string {
  const first = r.content[0];
  if (first === undefined || first.type !== "text") throw new Error("no text content");
  return first.text;
}
