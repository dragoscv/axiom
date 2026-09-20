import { defineConfig } from "tsdown";

const shared = {
  format: ["esm"],
  platform: "node",
  target: "node22",
  fixedExtension: false,
  sourcemap: true,
} as const;

/**
 * `@cedar-policy/cedar-wasm` (optional dependency, S-411) must stay external in every chunk:
 * its `nodejs/` entry is CJS that locates the sibling `cedar_wasm_bg.wasm` via `__dirname`, so
 * inlining it into an ESM chunk yields "__dirname is not defined" and no .wasm next to the
 * chunk. Resolved from node_modules at runtime; absent → `expr.cedar` fails closed.
 */
const CEDAR_WASM = /^@cedar-policy\/cedar-wasm/;

/**
 * Rolldown writes a `//#region <file>` / `//#endregion` comment pair around every bundled
 * module (~19 KB across the CLI bundle). They are comments only, so dropping them changes no
 * behaviour and keeps the eager `cli.js + cli-main.js` inside the 950 KB budget.
 * Whole-line JSDoc blocks (`/** … *​/`, ~95 KB in the CLI bundle, mostly from bundled deps) are
 * dropped for the same reason; `/*!` license banners are untouched.
 */
const stripRegionMarkers = {
  name: "axiom-strip-region-markers",
  renderChunk(code: string) {
    return {
      code: code
        .replace(/^\/\/#(?:end)?region\b[^\n]*\n/gm, "")
        .replace(/^[ \t]*\/\*\*(?:[^*]|\*(?!\/))*\*\/[ \t]*\r?\n/gm, ""),
      map: null,
    };
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    dts: true,
    clean: true,
  },
  {
    ...shared,
    // Self-contained CLI: workspace packages, zod and the SDK are bundled so the
    // published bin has no runtime dependency on them. Only `node:*` stays external.
    // `cli` is a thin entry (answers --version without loading anything); the heavy
    // code lives in the `cli-main` chunk and is imported lazily.
    entry: { cli: "src/cli.ts", "cli-main": "src/cli-main.ts" },
    dts: false,
    clean: false,
    bin: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      // `./axm-lazy.js` stays a verbatim dynamic import so the .axm parser never
      // enters the eager bundle (and no shared schema/zod chunk gets split out).
      // Same for `./gate-lazy.js`: the hook must not pay for the SDK/server code.
      // And `./http-lazy.js`: the Streamable HTTP transport is opt-in (`--http`).
      // And `./migrate-lazy.js`: `axiom migrate v1` is CLI-only and rare.
      // And `./verify-tree-lazy.js`: `axiom verify --tree` (+ attestation) is CI-only.
      // And `./gc-lazy.js`: `axiom gc` is CLI-only and rare.
      // And `./mcp-lazy.js`: the MCP SDK itself — only `axiom mcp` needs it (S-405).
      neverBundle: [
        /^node:/,
        CEDAR_WASM,
        /axm-lazy/,
        /gate-lazy/,
        /http-lazy/,
        /migrate-lazy/,
        /verify-tree-lazy/,
        /gc-lazy/,
        /mcp-lazy/,
      ],
    },
  },
  {
    ...shared,
    // Standalone .axm parser chunk for the CLI (chevrotain + its own schema/zod copy); loaded on
    // demand only. (The library build above emits its own tiny hashed chunk that re-exports
    // from the `@codai/axiom-axm` dependency instead.)
    entry: { "axm-lazy": "src/axm-lazy.ts" },
    dts: false,
    clean: false,
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
  {
    ...shared,
    // Standalone PreToolUse hook chunk (`axiom gate --stdin`): schema + zod + checks + apply
    // containment, no MCP SDK. Loaded straight from `cli.ts`, bypassing `cli-main`.
    entry: { "gate-lazy": "src/gate-lazy.ts" },
    dts: false,
    clean: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
  {
    ...shared,
    // Standalone Streamable HTTP chunk (`axiom mcp --http`): the SDK's web-standard transport
    // bridged onto node:http — no express/hono at runtime (asserted by http.test.ts).
    entry: { "http-lazy": "src/http-lazy.ts" },
    dts: false,
    clean: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
  {
    ...shared,
    // Standalone `axiom migrate v1` chunk: v1 manifest → Plan (schema + zod + plan CAS writer).
    entry: { "migrate-lazy": "src/migrate-lazy.ts" },
    dts: false,
    clean: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
  {
    ...shared,
    // Standalone `axiom verify --tree` chunk (S-403): tree digests + in-toto apply attestation.
    entry: { "verify-tree-lazy": "src/verify-tree-lazy.ts" },
    dts: false,
    clean: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
  {
    ...shared,
    // Standalone `axiom gc` chunk (CAS garbage collection; CLI only).
    entry: { "gc-lazy": "src/gc-lazy.ts" },
    dts: false,
    clean: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
  {
    ...shared,
    // Standalone `axiom mcp` chunk: the MCP SDK + tool registry + stdio serving entry (S-405).
    entry: { "mcp-lazy": "src/mcp-lazy.ts" },
    dts: false,
    clean: false,
    plugins: [stripRegionMarkers],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/, CEDAR_WASM],
    },
  },
]);
