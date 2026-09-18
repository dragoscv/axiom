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
    // The bin bundles the workspace packages (axm, schema, chevrotain, zod) so the
    // extension can spawn it from a single file; `vscode-languageserver*` stays a runtime
    // dependency (it is what the client already ships and what the transport expects).
    entry: { main: "src/main.ts" },
    dts: false,
    clean: false,
    deps: {
      alwaysBundle: [
        /^@codai\//,
        /^chevrotain/,
        /^zod/,
        /^@chevrotain\//,
        /^lodash-es/,
        /^regexp-to-ast/,
      ],
      neverBundle: [/^node:/, /^vscode-languageserver/],
    },
  },
]);
