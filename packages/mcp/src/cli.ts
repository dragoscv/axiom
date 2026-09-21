#!/usr/bin/env node
/**
 * Thin entry: `--version`/`--help` answer without loading zod, the MCP SDK or the
 * engines; every real verb lazy-loads `./cli-main.js` (bundled alongside, no deps).
 */
import { PACKAGE_VERSION as version } from "./version.js";

const argv = process.argv.slice(2);
const verb = argv[0];

if (verb === "--version" || verb === "-v") {
  console.log(version);
} else if (verb === "gate") {
  // Hook mode: a separate chunk so the < 120 ms budget never pays for the SDK/server code.
  const { gateMain } = await import("./gate-lazy.js");
  const r = await gateMain(argv.slice(1));
  for (const line of r.stderr) process.stderr.write(`${line}\n`);
  if (r.stdout !== undefined) process.stdout.write(`${r.stdout}\n`);
  process.exitCode = r.exitCode;
} else {
  const { main } = await import("./cli-main.js");
  process.exitCode = await main(argv, version);
}
