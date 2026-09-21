import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

/**
 * Single-executable bundle (D-27): one CommonJS file with every lazy chunk inlined, because a
 * Node SEA cannot `import()` sibling files (ERR_UNKNOWN_BUILTIN_MODULE). Not part of `pnpm build`
 * — `pnpm build:sea` runs it, then `node --build-sea sea-config.json` embeds `dist/sea/axiom.cjs`.
 *
 * `@cedar-policy/cedar-wasm` is left out on purpose: its CJS entry finds the .wasm via
 * `__dirname`, which has no meaning inside a binary; `expr.cedar` fails closed there.
 * `@marcbachmann/cel-js` is pure JS and is inlined.
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: { axiom: "src/sea.ts" },
  outDir: "dist/sea",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  fixedExtension: true,
  sourcemap: false,
  dts: false,
  clean: true,
  bin: false,
  minify: false,
  define: { __AXIOM_VERSION__: JSON.stringify(pkg.version) },
  // Every `await import("./x-lazy.js")` is folded into this one file; nothing is emitted as a
  // separate chunk.
  outputOptions: { inlineDynamicImports: true },
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: [/^node:/, /^@cedar-policy\/cedar-wasm/],
  },
});
