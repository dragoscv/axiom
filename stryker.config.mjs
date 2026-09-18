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
  // pnpm puts vitest-runner in the root node_modules, not next to @stryker-mutator/core
  // inside .pnpm, so the default "@stryker-mutator/*" plugin glob never finds it.
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    // Stryker's runner does not expand vitest `projects`; use a flat config.
    configFile: "vitest.stryker.config.ts",
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
  // break is null until stryker-js#6210 (vitest 5 support) is fixed — see header.
  thresholds: { high: 90, low: 70, break: null },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  // pnpm workspace deps are symlinks under packages/*/node_modules; a copied
  // sandbox loses them and tests importing @codai/axiom-* silently drop out.
  inPlace: true,
  // KNOWN BLOCKER (2026-09-18): @stryker-mutator/vitest-runner 10.0.0 is not Vitest-5
  // aware: "perTest" crashes serialising `resolvedProjects` (circular), and the
  // per-test name filter matches nothing (stryker-js#6210) so covered mutants read
  // as survived. Measured here: 12.9 % with 746 false survivors. "off" avoids the
  // crash; re-enable "perTest" + break: 85 once #6210 is closed.
  coverageAnalysis: "off",
  concurrency: 4,
  timeoutMS: 30_000,
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  clearTextReporter: { allowColor: false, logTests: false },
  incremental: true,
  incrementalFile: ".stryker-tmp/incremental.json",
};
