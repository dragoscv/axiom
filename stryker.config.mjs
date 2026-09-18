// @ts-check
/**
 * Stryker mutation testing — scoped to the security-relevant, pure code
 * (docs/design/v2-architecture.md §7, PLAN.md S-110). Runs weekly and on PRs
 * touching these paths (.github/workflows/mutation.yml), not on every PR.
 *
 * Local: `pnpm exec stryker run` (needs `pnpm build` first so workspace
 * `dist/` exports resolve). Report: reports/mutation/index.html.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
  },
  mutate: [
    "packages/canon/src/**/*.ts",
    "packages/apply/src/contain.ts",
    "packages/apply/src/write.ts",
    "packages/checks/src/predicates/**/*.ts",
    "!**/*.test.ts",
    "!**/*.test-helpers.ts",
    "!**/test-helpers.ts",
    "!packages/checks/src/predicates/index.ts",
  ],
  ignorePatterns: ["packages/_v1/**", "**/dist/**", "docs/**", ".copilot-tmp/**", "reports/**"],
  checkers: [],
  thresholds: { high: 90, low: 70, break: 85 },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 4,
  timeoutMS: 30_000,
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  clearTextReporter: { allowColor: false, logTests: false },
  incremental: true,
  incrementalFile: ".stryker-tmp/incremental.json",
};
