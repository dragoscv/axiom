/**
 * Lazy-loaded hook entry. Built by tsdown as its own self-contained chunk (`dist/gate-lazy.js`,
 * with its own copy of schema/zod/checks/apply) and reached only via `import("./gate-lazy.js")`
 * from `cli.ts`, so `axiom gate --stdin` never loads the MCP SDK or the server code and the
 * eager `cli.js + cli-main.js` budget is unaffected.
 */
export {
  GATE_EXIT_ALLOW,
  GATE_EXIT_DENY,
  type GateOptions,
  type GateResult,
  gateMain,
  runGate,
} from "./gate.js";
