#!/usr/bin/env node
/**
 * Thin entry: `--version`/`--help` answer without loading zod, the MCP SDK or the
 * engines; every real verb lazy-loads `./cli-main.js` (bundled alongside, no deps).
 */
import { fastAllow, readStdin } from "./gate-fast.js";
import { PACKAGE_VERSION as version } from "./version.js";

const argv = process.argv.slice(2);
const verb = argv[0];

if (verb === "--version" || verb === "-v") {
  console.log(version);
} else if (verb === "gate") {
  // Hook mode. Read stdin here (zero-dependency) and answer read-only tools without loading
  // the gate chunk at all (2.4.1 fast path); everything else goes to the full gate, which gets
  // the already-read payload. Parsing errors in argv are left to the full gate.
  const read = argv.includes("--stdin") ? await readStdin(process.stdin) : undefined;
  if (read !== undefined && fastAllow(read.text)) {
    process.exitCode = 0;
  } else {
    const { gateMain } = await import("./gate-lazy.js");
    const r = await gateMain(argv.slice(1), read === undefined ? {} : { read });
    for (const line of r.stderr) process.stderr.write(`${line}\n`);
    if (r.stdout !== undefined) process.stdout.write(`${r.stdout}\n`);
    process.exitCode = r.exitCode;
  }
} else {
  const { main } = await import("./cli-main.js");
  process.exitCode = await main(argv, version);
}
