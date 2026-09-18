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
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: [/^node:/],
    },
  },
]);
