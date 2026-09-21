/**
 * Entry for the single-executable build (D-27). Same dispatch as `cli.ts`, but every lazy chunk
 * is inlined by the `sea` tsdown entry (`inlineDynamicImports`, CommonJS) into one file: inside a
 * Node SEA a non-builtin `import()` rejects with ERR_UNKNOWN_BUILTIN_MODULE, so there are no
 * sibling chunks to load. `PACKAGE_VERSION` comes from a build-time `define`. No top-level
 * await: the output is CommonJS.
 */
import { main } from "./cli-main.js";
import { gateMain } from "./gate-lazy.js";
import { PACKAGE_VERSION as version } from "./version.js";

async function run(argv: readonly string[]): Promise<number> {
  const verb = argv[0];
  if (verb === "--version" || verb === "-v") {
    console.log(version);
    return 0;
  }
  if (verb === "gate") {
    const r = await gateMain(argv.slice(1));
    for (const line of r.stderr) process.stderr.write(`${line}\n`);
    if (r.stdout !== undefined) process.stdout.write(`${r.stdout}\n`);
    return r.exitCode;
  }
  return main(argv, version);
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
