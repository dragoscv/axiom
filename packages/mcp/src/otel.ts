/**
 * S-1217 — opt-in OpenTelemetry spans from the gate daemon, hand-built OTLP/HTTP JSON (no SDK, no
 * new dependency). One span per judged hook call, following the GenAI semantic conventions for
 * tool execution (status: Development): span name `execute_tool <gen_ai.tool.name>`, kind
 * INTERNAL, `gen_ai.operation.name = "execute_tool"`, `gen_ai.tool.name`, `gen_ai.tool.call.id`
 * when the payload carries one, plus `axiom.*` attributes.
 *
 * A deny is a successful gate decision → status UNSET. Only an internal gate failure
 * (`ERR_INTERNAL`) is status ERROR with `error.type`.
 *
 * Never throws, never blocks the gate path: `record` is sync O(1) into a bounded buffer; exports
 * run on an unref'd timer / when the batch is full / on close; export failures are dropped.
 * Privacy: no payload content is exported — only tool name, ids, decision, code, class, root.
 *
 * Never imported by gate.ts (keeps the gate-lazy chunk lean); serve.ts imports it statically.
 */
import { randomBytes } from "node:crypto";

export interface OtelOptions {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  flushMs?: number;
  maxBatch?: number;
  fetchImpl?: typeof fetch;
}

export interface GateSpanInput {
  tool?: string;
  toolCallId?: string;
  decision: "allow" | "deny";
  code?: string;
  toolClass?: string;
  root?: string;
  format?: string;
  startMs: number;
  durationMs: number;
}

export interface OtelExporter {
  record(s: GateSpanInput): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const OTEL_DEFAULT_SERVICE_NAME = "axiom-gate";
export const OTEL_SCOPE_NAME = "@codai/axiom-mcp";
const DEFAULT_FLUSH_MS = 2_000;
const DEFAULT_MAX_BATCH = 256;
/** Hard cap on buffered spans while an endpoint is down: oldest are dropped. */
const MAX_BUFFER = 4_096;
const EXPORT_TIMEOUT_MS = 5_000;
/** OTLP SpanKind INTERNAL. */
const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

type AnyValue = { stringValue: string } | { intValue: string };
interface KeyValue {
  key: string;
  value: AnyValue;
}

interface PendingSpan {
  traceId: string;
  spanId: string;
  input: GateSpanInput;
}

function str(key: string, v: string): KeyValue {
  return { key, value: { stringValue: v } };
}

function int(key: string, v: number): KeyValue {
  // OTLP/JSON encodes int64 as a decimal string.
  return { key, value: { intValue: String(Math.max(0, Math.round(v))) } };
}

function msToNano(ms: number): bigint {
  const whole = Math.floor(ms);
  const fracNs = Math.round((ms - whole) * 1e6);
  return BigInt(whole) * 1_000_000n + BigInt(fracNs);
}

/** Build the OTLP span object. */
function toOtlpSpan(p: PendingSpan): Record<string, unknown> {
  const s = p.input;
  const tool = s.tool !== undefined && s.tool !== "" ? s.tool : "unknown";
  const attributes: KeyValue[] = [
    str("gen_ai.operation.name", "execute_tool"),
    str("gen_ai.tool.name", tool),
  ];
  if (s.toolCallId !== undefined && s.toolCallId !== "") {
    attributes.push(str("gen_ai.tool.call.id", s.toolCallId));
  }
  attributes.push(str("axiom.decision", s.decision));
  if (s.code !== undefined) attributes.push(str("axiom.code", s.code));
  if (s.toolClass !== undefined) attributes.push(str("axiom.tool_class", s.toolClass));
  if (s.root !== undefined) attributes.push(str("axiom.root", s.root));
  if (s.format !== undefined) attributes.push(str("axiom.format", s.format));
  attributes.push(int("axiom.duration_ms", s.durationMs));
  const internal = s.code === "ERR_INTERNAL";
  if (internal) attributes.push(str("error.type", "ERR_INTERNAL"));
  const start = msToNano(s.startMs);
  return {
    traceId: p.traceId,
    spanId: p.spanId,
    name: `execute_tool ${tool}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + BigInt(Math.round(Math.max(0, s.durationMs) * 1e6))).toString(),
    attributes,
    status: internal ? { code: STATUS_ERROR, message: "ERR_INTERNAL" } : { code: STATUS_UNSET },
  };
}

function tracesUrl(endpoint: string): string {
  const e = endpoint.replace(/\/+$/u, "");
  return e.endsWith("/v1/traces") ? e : `${e}/v1/traces`;
}

export function createOtelExporter(o: OtelOptions): OtelExporter {
  const url = tracesUrl(o.endpoint);
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const flushMs = o.flushMs ?? DEFAULT_FLUSH_MS;
  const maxBatch = Math.max(1, o.maxBatch ?? DEFAULT_MAX_BATCH);
  const resource = {
    attributes: [
      str("service.name", o.serviceName ?? OTEL_DEFAULT_SERVICE_NAME),
      str("telemetry.sdk.name", "axiom-otlp-json"),
      str("telemetry.sdk.language", "nodejs"),
    ],
  };
  const headers = { "content-type": "application/json", ...(o.headers ?? {}) };
  let buf: PendingSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();
  let closed = false;

  const send = async (batch: PendingSpan[]): Promise<void> => {
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource,
          scopeSpans: [{ scope: { name: OTEL_SCOPE_NAME }, spans: batch.map(toOtlpSpan) }],
        },
      ],
    });
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      });
      // Drain so the keep-alive socket is reusable; status is ignored (best effort).
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      // Telemetry must never affect the gate: drop the batch silently.
    }
  };

  const drain = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (buf.length > 0) {
      const batch = buf.slice(0, maxBatch);
      buf = buf.slice(maxBatch);
      inflight = inflight.then(() => send(batch));
    }
    return inflight;
  };

  const schedule = (): void => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, flushMs);
    timer.unref?.();
  };

  return {
    record(s) {
      if (closed) return;
      try {
        buf.push({
          traceId: randomBytes(16).toString("hex"),
          spanId: randomBytes(8).toString("hex"),
          input: s,
        });
        if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
        if (buf.length >= maxBatch) void drain();
        else schedule();
      } catch {
        // never throw into the gate path
      }
    },
    flush() {
      return drain();
    },
    async close() {
      closed = true;
      await drain();
    },
  };
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      const k = decodeURIComponent(part.slice(0, i).trim());
      const v = decodeURIComponent(part.slice(i + 1).trim());
      if (k !== "") out[k] = v;
    } catch {
      // malformed percent-encoding: skip that pair
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function httpUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opt-in configuration from the environment. Precedence: `AXIOM_OTEL_ENDPOINT` (base or full
 * `/v1/traces` URL) → `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (full URL, used as-is) →
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (base; `/v1/traces` appended). `undefined` when none is set or
 * the chosen endpoint is not http(s).
 */
export function otelFromEnv(env: NodeJS.ProcessEnv): OtelOptions | undefined {
  const pick = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const raw =
    pick("AXIOM_OTEL_ENDPOINT") ??
    pick("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ??
    pick("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (raw === undefined) return undefined;
  const endpoint = httpUrl(raw);
  if (endpoint === undefined) return undefined;
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  return {
    endpoint,
    serviceName: pick("OTEL_SERVICE_NAME") ?? OTEL_DEFAULT_SERVICE_NAME,
    ...(headers === undefined ? {} : { headers }),
  };
}
