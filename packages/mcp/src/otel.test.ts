import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOtelExporter, type GateSpanInput, otelFromEnv } from "./otel.js";

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: OtlpBody;
}
interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: string };
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  status: { code: number };
}
interface OtlpBody {
  resourceSpans: {
    resource: { attributes: OtlpAttr[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
}

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function collector(status = 200): Promise<{ url: string; got: Received[] }> {
  const got: Received[] = [];
  server = http.createServer((req, res) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      s += c;
    });
    req.on("end", () => {
      got.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(s) as OtlpBody });
      res.writeHead(status).end("{}");
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, got };
}

const span = (over: Partial<GateSpanInput> = {}): GateSpanInput => ({
  tool: "Write",
  decision: "deny",
  code: "ERR_PATH_DENIED",
  toolClass: "write",
  root: "/repo",
  format: "claude",
  startMs: 1_700_000_000_000.5,
  durationMs: 4.4,
  ...over,
});

function attrs(s: OtlpSpan): Record<string, { stringValue?: string; intValue?: string }> {
  return Object.fromEntries(s.attributes.map((a) => [a.key, a.value]));
}

function spansOf(got: Received[]): OtlpSpan[] {
  return got.flatMap((g) =>
    g.body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
  );
}

describe("createOtelExporter (S-1217)", () => {
  it("POSTs OTLP/JSON to <endpoint>/v1/traces with GenAI execute_tool attributes", async () => {
    const c = await collector();
    const ex = createOtelExporter({
      endpoint: `${c.url}/`,
      headers: { "x-api-key": "k1" },
      serviceName: "svc-test",
      flushMs: 60_000,
    });
    ex.record(span({ toolCallId: "toolu_01" }));
    await ex.flush();
    expect(c.got).toHaveLength(1);
    const g = c.got[0] as Received;
    expect(g.url).toBe("/v1/traces");
    expect(g.headers["content-type"]).toBe("application/json");
    expect(g.headers["x-api-key"]).toBe("k1");
    const rs = g.body.resourceSpans[0];
    expect(rs?.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "svc-test" },
    });
    expect(rs?.scopeSpans[0]?.scope.name).toBe("@codai/axiom-mcp");
    const s = spansOf(c.got)[0] as OtlpSpan;
    expect(s.name).toBe("execute_tool Write");
    expect(s.kind).toBe(1);
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.startTimeUnixNano).toBe("1700000000000500000");
    expect(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)).toBe(4_400_000n);
    const a = attrs(s);
    expect(a["gen_ai.operation.name"]).toEqual({ stringValue: "execute_tool" });
    expect(a["gen_ai.tool.name"]).toEqual({ stringValue: "Write" });
    expect(a["gen_ai.tool.call.id"]).toEqual({ stringValue: "toolu_01" });
    expect(a["axiom.decision"]).toEqual({ stringValue: "deny" });
    expect(a["axiom.code"]).toEqual({ stringValue: "ERR_PATH_DENIED" });
    expect(a["axiom.tool_class"]).toEqual({ stringValue: "write" });
    expect(a["axiom.root"]).toEqual({ stringValue: "/repo" });
    expect(a["axiom.format"]).toEqual({ stringValue: "claude" });
    expect(a["axiom.duration_ms"]).toEqual({ intValue: "4" });
    // A deny is a successful gate decision: status UNSET, no error.type.
    expect(s.status.code).toBe(0);
    expect(a["error.type"]).toBeUndefined();
    await ex.close();
  });

  it("marks only ERR_INTERNAL as status ERROR; omits call id when absent; unknown tool name", async () => {
    const c = await collector();
    const ex = createOtelExporter({ endpoint: `${c.url}/v1/traces`, flushMs: 60_000 });
    ex.record(span({ code: "ERR_INTERNAL" }));
    ex.record(span({ tool: undefined, decision: "allow", code: undefined }));
    await ex.close();
    expect(c.got[0]?.url).toBe("/v1/traces");
    const [err, ok] = spansOf(c.got) as [OtlpSpan, OtlpSpan];
    expect(err.status.code).toBe(2);
    expect(attrs(err)["error.type"]).toEqual({ stringValue: "ERR_INTERNAL" });
    expect(ok.status.code).toBe(0);
    expect(ok.name).toBe("execute_tool unknown");
    expect(attrs(ok)["gen_ai.tool.call.id"]).toBeUndefined();
    expect(attrs(ok)["axiom.code"]).toBeUndefined();
    expect(attrs(err)["gen_ai.tool.name"]).toEqual({ stringValue: "Write" });
  });

  it("batches: exports when maxBatch is reached, on the timer, and on close", async () => {
    const c = await collector();
    const ex = createOtelExporter({ endpoint: c.url, maxBatch: 3, flushMs: 20 });
    for (let i = 0; i < 7; i++) ex.record(span({ tool: `T${i}` }));
    await ex.flush();
    expect(c.got.map((g) => spansOf([g]).length)).toEqual([3, 3, 1]);
    ex.record(span({ tool: "timer" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(spansOf(c.got).map((s) => s.name)).toContain("execute_tool timer");
    ex.record(span({ tool: "last" }));
    await ex.close();
    ex.record(span({ tool: "after-close" }));
    await ex.flush();
    const names = spansOf(c.got).map((s) => s.name);
    expect(names).toContain("execute_tool last");
    expect(names).not.toContain("execute_tool after-close");
    expect(names).toHaveLength(9);
  });

  it("swallows endpoint failures (refused connection, 500, throwing fetch)", async () => {
    const dead = createOtelExporter({ endpoint: "http://127.0.0.1:1", flushMs: 60_000 });
    dead.record(span());
    await expect(dead.close()).resolves.toBeUndefined();

    const c = await collector(500);
    const e500 = createOtelExporter({ endpoint: c.url, flushMs: 60_000 });
    e500.record(span());
    await expect(e500.close()).resolves.toBeUndefined();
    expect(c.got).toHaveLength(1);

    const throwing = createOtelExporter({
      endpoint: "http://127.0.0.1:9",
      flushMs: 60_000,
      fetchImpl: () => {
        throw new Error("boom");
      },
    });
    expect(() => throwing.record(span())).not.toThrow();
    await expect(throwing.close()).resolves.toBeUndefined();
  });
});

describe("otelFromEnv (S-1217)", () => {
  it("is opt-in: undefined when no endpoint is set", () => {
    expect(otelFromEnv({})).toBeUndefined();
    expect(otelFromEnv({ AXIOM_OTEL_ENDPOINT: "  " })).toBeUndefined();
  });

  it("prefers AXIOM_OTEL_ENDPOINT, then the traces endpoint, then the base endpoint", () => {
    const all = {
      AXIOM_OTEL_ENDPOINT: "http://a:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:4318/v1/traces",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://b:4318",
    };
    expect(otelFromEnv(all)?.endpoint).toBe("http://a:4318");
    expect(otelFromEnv({ ...all, AXIOM_OTEL_ENDPOINT: undefined })?.endpoint).toBe(
      "http://t:4318/v1/traces",
    );
    expect(otelFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://b:4318" })?.endpoint).toBe(
      "https://b:4318",
    );
  });

  it("parses url-encoded headers and the service name (default axiom-gate)", () => {
    const o = otelFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://b:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=a%3Db, x-tenant = t1 ,bad,=v",
    });
    expect(o?.headers).toEqual({ "api-key": "a=b", "x-tenant": "t1" });
    expect(o?.serviceName).toBe("axiom-gate");
    expect(
      otelFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://b", OTEL_SERVICE_NAME: "mine" })
        ?.serviceName,
    ).toBe("mine");
  });

  it("rejects non-http(s) endpoints", () => {
    expect(otelFromEnv({ AXIOM_OTEL_ENDPOINT: "file:///tmp/x" })).toBeUndefined();
    expect(otelFromEnv({ AXIOM_OTEL_ENDPOINT: "grpc://h:4317" })).toBeUndefined();
    expect(otelFromEnv({ AXIOM_OTEL_ENDPOINT: "not a url" })).toBeUndefined();
  });
});
