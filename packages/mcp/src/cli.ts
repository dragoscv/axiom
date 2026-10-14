#!/usr/bin/env node
/**
 * Thin entry: `--version`/`--help` answer without loading zod, the MCP SDK or the
 * engines; every real verb lazy-loads `./cli-main.js` (bundled alongside, no deps).
 */
import { allowStdout, fastAllow, formatFromArgv, readStdin } from "./gate-fast.js";
import { PACKAGE_VERSION as version } from "./version.js";

const argv = process.argv.slice(2);
const verb = argv[0];
const wantsHelp = argv.includes("--help") || argv.includes("-h");

if (verb === "--version" || verb === "-v") {
  console.log(version);
} else if (verb === "gate" && !wantsHelp) {
  // Hook mode. Read stdin here (zero-dependency) and answer read-only tools without loading
  // the gate chunk at all (2.4.1 fast path); everything else goes to the full gate, which gets
  // the already-read payload. Parsing errors in argv are left to the full gate.
  // 2.5.0 (D-36): before loading the gate chunk, ask the resident daemon (`axiom serve --hook`);
  // no verdict from it (absent, down, other version, cwd outside its roots) → in-process gate.
  const read = argv.includes("--stdin") ? await readStdin(process.stdin) : undefined;
  if (read !== undefined && fastAllow(read.text)) {
    const allow = allowStdout(formatFromArgv(argv));
    if (allow !== undefined) process.stdout.write(`${allow}\n`);
    process.exitCode = 0;
  } else {
    const viaDaemon =
      read === undefined || process.env.AXIOM_GATE_DAEMON === "0"
        ? undefined
        : await (await import("./daemon-client.js")).callDaemon({
            argv: argv.slice(1),
            text: read.text,
            stdin: read.tooLarge ? "toolarge" : read.timedOut ? "timeout" : "ok",
            cwd: process.cwd(),
            version,
          });
    const r =
      viaDaemon ??
      (await (async () => {
        const { gateMain } = await import("./gate-lazy.js");
        return gateMain(argv.slice(1), read === undefined ? {} : { read });
      })());
    for (const line of r.stderr) process.stderr.write(`${line}\n`);
    if (r.stdout !== undefined && r.stdout !== "") process.stdout.write(`${r.stdout}\n`);
    process.exitCode = r.exitCode;
  }
} else {
  const { main } = await import("./cli-main.js");
  process.exitCode = await main(argv, version);
}
