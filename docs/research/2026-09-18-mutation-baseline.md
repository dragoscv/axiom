# Mutation baseline — S-110 (2026-09-18)

**Status: NO BASELINE OBTAINED. Stryker fails to start.** Threshold (break 85 %) = **not evaluated**.

## Run

```
pnpm exec stryker run      # repo root, stryker.config.mjs, Node 26.1.0, pnpm 12
```

Log: `.copilot-tmp/stryker.log`. Exit code 1 after ~5 s.

### What worked

- Config loaded; `incremental` off (no `.stryker-tmp/incremental.json`).
- `ProjectReader Found 14 of 389 file(s) to be mutated`
- `Instrumenter Instrumented 14 source file(s) with 922 mutant(s)`
- `Creating 4 test runner process(es)`

So the `mutate` globs are correct and the instrumenter is fine: **922 mutants
across 14 files** is the population the baseline will measure once the runner
loads.

### Exact failure

```
WARN OptionsValidator Unknown stryker config option "vitest".
   * You might be missing a plugin that is supposed to use it. Stryker loaded plugins from: ["@stryker-mutator/*"]
...
ERROR Stryker Unexpected error occurred while running Stryker StrykerError: Error: Could not inject
[class ChildProcessTestRunnerWorker]. Cause: Cannot find TestRunner plugin "vitest".
In fact, no TestRunner plugins were loaded. Did you forget to install it?
    at ChildProcessProxyWorker.handleInit (.../@stryker-mutator+core@10.0.0_@types+node@26.6.1/.../child-process-proxy-worker.js:75:41)
```

### Root cause (VERIFIED by reading the loader)

`@stryker-mutator/vitest-runner@10.0.0` **is installed**
(`node_modules/@stryker-mutator/vitest-runner` → symlink into `.pnpm`, version
10.0.0, `dist/src/index.js` present; catalog + lockfile agree). The plugin is
not found because of how the default plugin expression `@stryker-mutator/*` is
globbed:

`@stryker-mutator/core/dist/src/di/plugin-loader.js:77-84` resolves the glob
relative to **core's own location**:

```js
const pluginDirectory = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), org);
const plugins = (await fs.promises.readdir(pluginDirectory)) ...
```

Under pnpm's isolated layout that directory is
`node_modules/.pnpm/@stryker-mutator+core@10.0.0_.../node_modules/@stryker-mutator/`,
which contains only `api core instrumenter util` (checked with `Get-ChildItem`).
`vitest-runner` lives in a sibling `.pnpm` folder and is only linked from the
*root* `node_modules/@stryker-mutator/`, which the glob never reads. Hence
"no TestRunner plugins were loaded", and the `vitest` option is then reported
as unknown (nobody contributed its schema).

This is the documented Stryker + pnpm gotcha: the `*` glob does not work with
pnpm's non-hoisted store; plugins must be listed explicitly.

### Fix to apply to `stryker.config.mjs` (NOT applied — read-only task)

Add an explicit `plugins` array so the loader uses bare import resolution
(`resolvePluginModules` → `import('@stryker-mutator/vitest-runner')`), which
goes through the root `node_modules` symlink and works under pnpm:

```js
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],   // ← add: pnpm isolates .pnpm/<core>/node_modules, the default "@stryker-mutator/*" glob never sees the runner
  vitest: { configFile: "vitest.config.ts" },
  ...
};
```

Alternative (worse): `.npmrc` `public-hoist-pattern[]=@stryker-mutator/*` +
reinstall. Rejected — it changes the install layout for everyone to work around
a one-line config issue.

Secondary items to check on the first real run (EXPECTED, not verified):

- `concurrency: 4` × vitest worker pools on this box; if it thrashes, drop to 2.
- `timeoutMS: 30_000` — `apply.test.ts` fast-check fault-injection and lock
  tests are the slowest; watch for `Timeout` mutants being misreported.
- `reporters: ["progress"]` downgrades to `progress-append-only` in a non-TTY
  (harmless).

## Mutation population (for planning; no scores yet)

Instrumented files (14, 922 mutants), from `mutate`:

| Area | Files |
|---|---|
| `packages/canon/src` | `jcs.ts`, `pae.ts`, `statement.ts`, `digest.ts`, `index.ts` (+ any non-test src) |
| `packages/apply/src` | `contain.ts`, `write.ts` |
| `packages/checks/src/predicates` | `path.ts`, `content.ts`, `manifest.ts`, `deps.ts`, `repo.ts`, `guard.ts` … (index.ts excluded) |

Per-file score, survivor list and threshold verdict will be filled in once the
runner starts. Recommended first triage targets, by expected survivor density
(EXPECTED from reading the tests):

1. `apply/src/write.ts` — `renameRetry` EBUSY/EPERM/EACCES branches and retry
   counts have no test; `chmod 0755` non-win32 branch untested.
2. `apply/src/contain.ts:92` — `\\?\` prefix strip on Windows is
   platform-conditional; the Linux CI job cannot kill those mutants.
3. `checks/predicates/content.ts` — `SECRET_PATTERNS` regex boundary mutants;
   `predicates.test.ts` has one positive sample per pattern but few negatives.
4. `canon/src/jcs.ts` — number formatting branches are pinned by RFC 8785
   vectors, so high kill rate expected; string-escape edge cases less so.

## Numbers

| Metric | Value |
|---|---|
| Mutation score | **n/a** (runner failed to load) |
| Break threshold 85 % | **not evaluated** |
| Files instrumented | 14 |
| Mutants generated | 922 |
| Fix | add `plugins: ["@stryker-mutator/vitest-runner"]` to `stryker.config.mjs` |
