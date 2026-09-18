#!/usr/bin/env node
/**
 * Thin entry: `--version`/`--help` answer without loading zod, the MCP SDK or the
 * engines; every real verb lazy-loads `./cli-main.js` (bundled alongside, no deps).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const argv = process.argv.slice(2);
const verb = argv[0];

if (verb === "--version" || verb === "-v") {
  console.log(version);
} else {
  const { main } = await import("./cli-main.js");
  process.exitCode = await main(argv, version);
}
