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
    // `index` (parser) and `lsp` (language server, D-45) are separate entries: `lsp` imports the
    // parser through `./index.js`, and the parser never imports `vscode-languageserver`, so the
    // mcp bundle (which only imports the main entry) does not grow.
    entry: { index: "src/index.ts", lsp: "src/lsp/index.ts" },
    dts: true,
    clean: true,
  },
  {
    ...shared,
    // The `axm-lsp` bin bundles the parser (schema, chevrotain, zod) so an editor can spawn it
    // from a single file; `vscode-languageserver*` stays a runtime dependency.
    entry: { "lsp-main": "src/lsp/main.ts" },
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
