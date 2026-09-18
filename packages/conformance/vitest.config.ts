import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "conformance",
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
