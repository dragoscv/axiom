import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "apply", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
});
