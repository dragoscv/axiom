/**
 * Lazy chunk for `axiom gc` (CLI-only, rare): reached only via `import("./gc-lazy.js")` from
 * `cli-main.ts`, so the eager `cli.js + cli-main.js` budget does not carry it.
 */
export { collectGarbage, type GcOptions, parseDuration } from "./gc.js";
