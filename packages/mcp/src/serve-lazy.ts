/** Lazy chunk for `axiom serve --hook` and `axiom attest decisions` (D-36): CLI only. */
export { attestDecisions, statementFor } from "./attest.js";
export { createOtelExporter, otelFromEnv } from "./otel.js";
export { isLoopbackHost, type RunningDaemon, startDaemon } from "./serve.js";
