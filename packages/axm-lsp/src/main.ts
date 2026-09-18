#!/usr/bin/env node
/**
 * `axiom-axm-lsp` bin. Transport is picked by `vscode-languageserver` from argv:
 * `--stdio` (default for generic editors) or `--node-ipc` (what the VS Code client passes).
 */
import { startServer } from "./server.js";

if (!process.argv.some((a) => a === "--stdio" || a === "--node-ipc" || a.startsWith("--socket"))) {
  process.argv.push("--stdio");
}
startServer();
