---
"@codai/axiom-mcp": minor
---

SARIF + OpenTelemetry (S-1214, S-1217).

- `reportToSarif()` (`src/sarif.ts`) maps a `CheckReport` to SARIF 2.1.0 (one rule per finding id, severity → level, POSIX `%SRCROOT%` locations with the bundle as fallback, stable `partialFingerprints["axiom/v1"]`) for `axiom check --format sarif`. The GitHub Action gains `sarif` / `check-profile` inputs and a `sarif-path` output and uploads the log with `github/codeql-action/upload-sarif` (SHA-pinned v4.38.3).
- Opt-in OTLP/HTTP JSON trace export from the gate daemon (`src/otel.ts`, no new dependency): one `execute_tool <tool>` span per judged hook call with the GenAI semantic-convention attributes (`gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`) plus `axiom.*`; a deny is status UNSET, only `ERR_INTERNAL` is ERROR. Configured from `AXIOM_OTEL_ENDPOINT` / `OTEL_EXPORTER_OTLP_*` / `OTEL_SERVICE_NAME`; `ServeOptions.otel` records and flushes on close.
