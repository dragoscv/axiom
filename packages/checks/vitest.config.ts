import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "checks", include: ["src/**/*.test.ts"], environment: "node" },
});
