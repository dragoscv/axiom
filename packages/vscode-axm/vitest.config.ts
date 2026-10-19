import { defineConfig } from "vitest/config";

// Only the pure logic (`src/status.ts`) is unit-tested; `extension.ts` needs the VS Code host.
export default defineConfig({
  test: {
    name: "vscode-axm",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
