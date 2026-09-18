import { defineConfig } from "tsdown";

const shared = {
  // VS Code loads extensions as CommonJS; the server is spawned by node from the same dist.
  format: ["cjs"],
  platform: "node",
  target: "node22",
  fixedExtension: true,
  dts: false,
  sourcemap: true,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { extension: "src/extension.ts" },
    clean: true,
    // `vscode` is provided by the host; everything else is bundled so the .vsix carries no
    // node_modules (vsce cannot follow pnpm's symlinked layout).
    deps: { alwaysBundle: [/.*/], neverBundle: [/^node:/, /^vscode$/] },
  },
  {
    ...shared,
    entry: { server: "src/server.ts" },
    clean: false,
    deps: { alwaysBundle: [/.*/], neverBundle: [/^node:/] },
  },
]);
