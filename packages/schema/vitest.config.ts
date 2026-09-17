import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "schema", include: ["src/**/*.test.ts"], environment: "node" },
});
