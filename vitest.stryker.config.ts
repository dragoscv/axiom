import { defineConfig } from "vitest/config";

// Flat config for Stryker: its vitest runner does not expand `projects`,
// so we list the test globs directly. Kept in sync with packages/*/vitest.config.ts.
export default defineConfig({
  test: {
    include: ["packages/{canon,schema,plan,checks,apply}/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/_v1/**"],
    environment: "node",
  },
});
