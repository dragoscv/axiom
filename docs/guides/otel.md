# OpenTelemetry spans from the gate daemon

*Opt-in OTLP/HTTP traces from `axiom serve --hook`: one `execute_tool` span per judged hook call, following the GenAI semantic conventions (S-1217).*

The resident gate daemon ([hooks](../getting-started/hooks.md)) can export one span per judged
request to any OTLP/HTTP collector (OpenTelemetry Collector, Jaeger, Tempo, Honeycomb, Grafana
Cloud, …). It is **off by default** and adds **no dependency**: the exporter is ~200 lines of
hand-built OTLP JSON in `packages/mcp/src/otel.ts`, loaded only by the daemon (never by the
per-call `axiom gate` chunk).

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
axiom serve --hook --otel --root .
```

## Configuration

| Variable | Meaning |
|---|---|
| `AXIOM_OTEL_ENDPOINT` | wins over the standard variables; a base URL (`/v1/traces` is appended) or a full `…/v1/traces` URL |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | full traces URL, used as-is |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | base URL; `/v1/traces` is appended |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k2=v2`, values URL-decoded (e.g. `x-honeycomb-team=…`) |
| `OTEL_SERVICE_NAME` | resource `service.name`, default `axiom-gate` |

No endpoint set → no exporter. Only `http:` / `https:` endpoints are accepted (gRPC is not
supported; use the collector's HTTP receiver on 4318).

## Span shape

| Field | Value |
|---|---|
| name | `execute_tool <gen_ai.tool.name>` |
| kind | `INTERNAL` |
| `gen_ai.operation.name` | `"execute_tool"` |
| `gen_ai.tool.name` | the harness tool name (`tool_name` / `toolName` / `tool` / `name` in the payload); `unknown` when absent |
| `gen_ai.tool.call.id` | `tool_use_id` / `toolCallId` / `tool_call_id`, only when the payload has one |
| `axiom.decision` | `allow` or `deny` |
| `axiom.code` | the gate's error code on a deny (e.g. `ERR_PATH_DENIED`), absent on a plain allow |
| `axiom.tool_class` | `write` / `shell` / `other` |
| `axiom.root` | root the gate resolved |
| `axiom.format` | hook format (`auto`, `claude`, `codex`, …) |
| `axiom.duration_ms` | gate decision time (int) |
| `error.type` | `ERR_INTERNAL`, only for an internal gate failure |
| status | **UNSET** for allow *and* deny — a deny is a successful gate decision. **ERROR** only when the gate itself failed (`ERR_INTERNAL`). |

Resource: `service.name`, `telemetry.sdk.name = axiom-otlp-json`, `telemetry.sdk.language = nodejs`.
Scope: `@codai/axiom-mcp`. Each span is its own trace (random 16-byte trace id, 8-byte span id);
the hook protocol carries no trace context to join.

> [!NOTE]
> The GenAI semantic conventions — including the
> [execute tool span](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md#execute-tool-span)
> — are still **Development** status (they moved from opentelemetry.io/docs/specs/semconv to the
> `open-telemetry/semantic-conventions-genai` repository). Attribute names may change; AXIOM
> follows them in minor releases and documents any rename in the changelog.

## Delivery

- `record()` is synchronous and O(1): it appends to an in-memory buffer and returns. The gate
  answer never waits for telemetry.
- Batches are POSTed every 2 s (unref'd timer — it never keeps the process alive), immediately when
  256 spans are buffered, and on daemon shutdown (`close()` flushes).
- Export failures (connection refused, non-2xx, timeout after 5 s) are dropped silently. While a
  collector is down at most 4 096 spans are buffered; older ones are discarded.

## Privacy

No payload content is exported: no file paths, file contents, commands, prompts or tool
arguments. A span carries only the tool name, the tool call id, the decision, the error code, the
tool class, the root directory, the hook format and the timing. `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result` (opt-in content attributes in the conventions) are never set.

---

**See also**

- [Hooks](../getting-started/hooks.md) — the daemon these spans come from
- [SARIF](sarif.md) — the other export, for `axiom plan check`
