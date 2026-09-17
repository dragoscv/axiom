import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "canon", include: ["src/**/*.test.ts"], environment: "node" },
});
