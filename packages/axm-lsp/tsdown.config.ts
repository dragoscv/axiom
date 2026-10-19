import { defineConfig } from "tsdown";

const shared = {
  format: ["esm"],
  platform: "node",
  target: "node22",
  fixedExtension: false,
  sourcemap: true,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    dts: true,
    clean: true,
    deps: { neverBundle: [/^node:/, /^@codai\//] },
  },
  {
    ...shared,
    // Deprecated shim (D-45): the bin only forwards to `@codai/axiom-axm/lsp/main`.
    entry: { main: "src/main.ts" },
    dts: false,
    clean: false,
    deps: { neverBundle: [/^node:/, /^@codai\//] },
  },
]);
