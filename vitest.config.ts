import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "!packages/_v1/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "packages/_v1/**",
        "packages/testkit/**",
        "packages/mcp/src/cli.ts",
        "packages/mcp/src/cli-main.ts",
      ],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
      reporter: ["text", "lcov"],
    },
  },
});
