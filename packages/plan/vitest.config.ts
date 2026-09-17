import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "plan", include: ["src/**/*.test.ts"], environment: "node" },
});
