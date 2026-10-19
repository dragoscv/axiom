/**
 * 3.0 CLI-only commands, loaded on demand (own tsdown entry; never in the eager cli-main
 * bundle): fleet doctor, explain, suggest-profile, journal replay, report, MCP pins, the ACP
 * proxy and the profile migration.
 */
export { runAcpProxyWithAgent } from "./acp.js";
export { explainMain } from "./explain.js";
export { fleetMain } from "./fleet.js";
export { pruneDecisions } from "./gc.js";
export { pinMain } from "./mcp-pin.js";
export { migrateProfile } from "./migrate.js";
export { replayMain } from "./replay.js";
export { reportMain } from "./report.js";
export { suggestMain } from "./suggest.js";
