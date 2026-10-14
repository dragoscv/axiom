import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestBundle } from "@codai/axiom-schema";
import {
  type CallToolResult,
  Client,
  type ClientOptions,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HttpHandle, startHttp } from "./http.js";
import { silentLogger } from "./log.js";
import { createRootsPolicy } from "./roots.js";
import { type CreateServerOptions, createServer, serverFactory } from "./server.js";
import { makePlan, structured, tmpRepo } from "./test-helpers.js";
import { CONFIRM_DIGEST_CHARS, humanConfirmRequest } from "./tools.js";

type Answer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };
/** Simulated human: receives the elicitation params, returns the answer. */
type Human = (params: { message: string; requestedSchema: unknown }) => Answer;

interface Conn {
  client: Client;
  asked: { message: string; requestedSchema: unknown }[];
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let http: HttpHandle | undefined;
const conns: Conn[] = [];

beforeEach(async () => {
  repo = await tmpRepo("axiom-mcp-human-");
});
afterEach(async () => {
  await Promise.all(conns.splice(0).map((c) => c.close().catch(() => undefined)));
  await http?.close();
  http = undefined;
  await repo.cleanup();
});

function makeClient(human: Human | undefined, opts: ClientOptions = {}) {
  const asked: Conn["asked"] = [];
  const client = new Client(
    { name: "axiom-human-test", version: "0.0.0" },
    human === undefined ? opts : { ...opts, capabilities: { elicitation: { form: {} } } },
  );
  if (human !== undefined) {
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as { message: string; requestedSchema: unknown };
      asked.push(params);
      return human(params);
    });
  }
  return { client, asked };
}

/** 2025 era: hand-connected server over an in-memory pair (the SDK's legacy shim elicits). */
async function connectLegacy(
  human: Human | undefined,
  serverOpts: Omit<CreateServerOptions, "log"> = {},
): Promise<Conn> {
  const policy = await createRootsPolicy([repo.root]);
  const server = createServer(policy, { ...serverOpts, log: silentLogger });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const { client, asked } = makeClient(human);
  await Promise.all([server.connect(st), client.connect(ct)]);
  const conn: Conn = {
    client,
    asked,
    call: (name, args) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  conns.push(conn);
  return conn;
}

/** 2026-07-28 era: per-request instances behind the HTTP entry; the client fulfils MRTR rounds. */
async function connectModern(
  human: Human | undefined,
  serverOpts: { requireHuman?: boolean } = {},
): Promise<Conn> {
  const policy = await createRootsPolicy([repo.root]);
  http = await startHttp(serverFactory(policy, { log: silentLogger, ...serverOpts }), {
    host: "127.0.0.1",
    port: 0,
    log: silentLogger,
  });
  const { client, asked } = makeClient(human, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  expect(client.getProtocolEra()).toBe("modern");
  const conn: Conn = {
    client,
    asked,
    call: (name, args) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: () => client.close(),
  };
  conns.push(conn);
  return conn;
}

const plan = () => makePlan({ "src/a.ts": "export const a = 1;\n" }, { name: "human" });
const digest12 = (b: ManifestBundle) => b.manifestDigest.slice(7, 7 + CONFIRM_DIGEST_CHARS);
const accepting =
  (typed?: string): Human =>
  ({ message }) => {
    const hex = /sha256:([0-9a-f]{64})/.exec(message)?.[1] ?? "";
    return {
      action: "accept",
      content: { confirm: true, digest12: typed ?? hex.slice(0, CONFIRM_DIGEST_CHARS) },
    };
  };

async function compiled(c: Conn): Promise<ManifestBundle> {
  const r = await c.call("axiom_plan_compile", { plan: plan(), root: repo.root });
  expect(r.isError).toBeUndefined();
  return structured<ManifestBundle>(r);
}

const applyArgs = (b: ManifestBundle) => ({
  bundle: b,
  root: repo.root,
  confirmDigest: b.manifestDigest,
});
const refusal = (r: CallToolResult) =>
  structured<{ code: string; details?: { reason?: string; manifestDigest?: string } }>(r);
const written = () =>
  stat(join(repo.root, "src", "a.ts")).then(
    () => true,
    () => false,
  );

describe("tools/list _meta (S-1206)", () => {
  it("axiom_apply and axiom_write require user interaction; read tools do not", async () => {
    const c = await connectLegacy(undefined);
    const { tools } = await c.client.listTools();
    const meta = (n: string) => tools.find((t) => t.name === n)?._meta;
    for (const n of ["axiom_apply", "axiom_write"])
      expect(meta(n)?.["anthropic/requiresUserInteraction"], n).toBe(true);
    for (const t of tools.filter((x) => x.annotations?.readOnlyHint === true))
      expect(t._meta?.["anthropic/requiresUserInteraction"], t.name).toBeUndefined();
    expect(
      tools.filter((t) => t._meta?.["anthropic/requiresUserInteraction"] === true),
    ).toHaveLength(2);
  });
});

describe("axiom_apply with an eliciting client — 2025 era (legacy shim)", () => {
  it("a human who types the digest prefix → applied, asked exactly once", async () => {
    const c = await connectLegacy(accepting());
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(r.isError).toBeUndefined();
    expect(structured<{ status: string }>(r).status).toBe("applied");
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0]?.requestedSchema).toMatchObject({
      type: "object",
      required: ["confirm", "digest12"],
    });
    expect(await written()).toBe(true);
  });

  it.each([
    ["decline", (() => ({ action: "decline" })) as Human, "declined"],
    ["cancel", (() => ({ action: "cancel" })) as Human, "cancelled"],
    ["wrong digest12", accepting("000000000000"), "mismatch"],
    [
      "confirm: false",
      ((p) => ({ ...accepting()(p), content: { confirm: false, digest12: "x" } })) as Human,
      "declined",
    ],
  ])("%s → ERR_CONFIRM_DIGEST_MISMATCH, nothing written", async (_label, human, reason) => {
    const c = await connectLegacy(human);
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(r.isError).toBe(true);
    expect(refusal(r).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(refusal(r).details?.reason).toBe(reason);
    expect(refusal(r).details?.manifestDigest).toBe(b.manifestDigest);
    expect(await written()).toBe(false);
  });

  it("a wrong confirmDigest echo is refused before anyone is asked", async () => {
    const c = await connectLegacy(accepting());
    const b = await compiled(c);
    const r = await c.call("axiom_apply", {
      ...applyArgs(b),
      confirmDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(refusal(r).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(refusal(r).details?.reason).toBeUndefined();
    expect(c.asked).toHaveLength(0);
  });
});

describe("axiom_write with an eliciting client", () => {
  it("preview never asks; confirm asks and applies; a decline writes nothing", async () => {
    let answer: Human = () => ({ action: "decline" });
    const c = await connectLegacy((p) => answer(p));
    const files = [{ path: "src/a.ts", content: "export const a = 1;\n" }];
    const p = await c.call("axiom_write", { root: repo.root, files });
    const md = structured<{ status: string; manifestDigest: string }>(p);
    expect(md.status).toBe("preview");
    expect(c.asked).toHaveLength(0);

    const no = await c.call("axiom_write", {
      root: repo.root,
      files,
      confirmDigest: md.manifestDigest,
    });
    expect(refusal(no).details?.reason).toBe("declined");
    expect(await written()).toBe(false);

    answer = accepting();
    const yes = await c.call("axiom_write", {
      root: repo.root,
      files,
      confirmDigest: md.manifestDigest,
    });
    expect(structured<{ status: string }>(yes).status).toBe("applied");
    expect(c.asked).toHaveLength(2);
    expect(await written()).toBe(true);
  });
});

describe("clients without elicitation", () => {
  it("default: the confirmDigest echo still applies (unchanged behaviour)", async () => {
    const c = await connectLegacy(undefined);
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(structured<{ status: string }>(r).status).toBe("applied");
  });

  it("requireHuman → ERR_CONFIRM_DIGEST_MISMATCH { reason: elicitation-unsupported } for apply and write", async () => {
    const c = await connectLegacy(undefined, { requireHuman: true });
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(refusal(r).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(refusal(r).details?.reason).toBe("elicitation-unsupported");

    const files = [{ path: "src/a.ts", content: "export const a = 1;\n" }];
    const prev = structured<{ manifestDigest: string }>(
      await c.call("axiom_write", { root: repo.root, files }),
    );
    const w = await c.call("axiom_write", {
      root: repo.root,
      files,
      confirmDigest: prev.manifestDigest,
    });
    expect(refusal(w).details?.reason).toBe("elicitation-unsupported");
    expect(await written()).toBe(false);
  });

  it("requireHuman with an eliciting client still applies after the human confirms", async () => {
    const c = await connectLegacy(accepting(), { requireHuman: true });
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(structured<{ status: string }>(r).status).toBe("applied");
  });
});

describe("2026-07-28 era (input_required multi-round-trip)", () => {
  it("the client fulfils the elicitation round and the retried call applies", async () => {
    const c = await connectModern(accepting());
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(r.isError).toBeUndefined();
    expect(structured<{ status: string }>(r).status).toBe("applied");
    expect(c.asked).toHaveLength(1);
    expect(await written()).toBe(true);
  });

  it("a wrong digest12 → mismatch; requireHuman without elicitation → elicitation-unsupported", async () => {
    const c = await connectModern(accepting("ffffffffffff"));
    const b = await compiled(c);
    const r = await c.call("axiom_apply", applyArgs(b));
    expect(refusal(r).details?.reason).toBe("mismatch");
    await c.close();
    await http?.close();

    const bare = await connectModern(undefined, { requireHuman: true });
    const r2 = await bare.call("axiom_apply", applyArgs(await compiled(bare)));
    expect(refusal(r2).code).toBe("ERR_CONFIRM_DIGEST_MISMATCH");
    expect(refusal(r2).details?.reason).toBe("elicitation-unsupported");
    expect(await written()).toBe(false);
  });
});

describe("humanConfirmRequest", () => {
  it("lists at most 20 paths and binds to the manifestDigest", async () => {
    const c = await connectLegacy(undefined);
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`f/${String(i).padStart(2, "0")}.txt`, `${i}\n`]),
    );
    const r = await c.call("axiom_plan_compile", { plan: makePlan(files), root: repo.root });
    const b = structured<ManifestBundle>(r);
    const req = humanConfirmRequest(b, repo.root);
    expect(req.binding).toBe(b.manifestDigest);
    expect(req.message.split("\n").filter((l) => l.startsWith("  create "))).toHaveLength(20);
    expect(req.message).toContain(digest12(b));
    expect(Object.keys(req.requestedSchema.properties).sort()).toEqual(["confirm", "digest12"]);
  });
});
