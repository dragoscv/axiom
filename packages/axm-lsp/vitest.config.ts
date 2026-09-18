import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "axm-lsp", include: ["src/**/*.test.ts"], environment: "node" },
});
