# @codai/axiom-conformance (private)

MCP conformance harness for the `axiom mcp --http` Streamable HTTP server
(v2-architecture §7). Not published.

## What it does

1. Spawns the **built** CLI: `node ../mcp/dist/cli.js mcp --root <tmp> --http 127.0.0.1:0 --log-level info`
   and waits for the stderr JSON line `{"level":"info","msg":"http listening","url":…}`.
2. Runs the official suite from `node_modules` (no `npx`, no network beyond loopback):

   ```
   conformance server --url <url> --expected-failures baseline.yml --output-dir <dir> --suite active
   ```

   (`@modelcontextprotocol/conformance` 0.1.16 — flags verified with `conformance server --help`;
   the bin is named `conformance`, not `mcp-conformance`.)
3. Collects every `server-<scenario>-<ts>/checks.json`, prints a summary to stderr and exits
   with the CLI's code: **0 only when every failure is in `baseline.yml` and every baselined
   entry still fails** (a fixed entry left in the baseline is a failure — delete it).

```
pnpm build                                          # dist/cli.js is required
pnpm --filter @codai/axiom-conformance conformance  # standalone run, report in ./results
pnpm --filter @codai/axiom-conformance test         # same run under vitest + helper unit tests
```

## Baseline

`baseline.yml` lists 22 scenarios that fail **by design** — capabilities AXIOM does not offer
(prompts, logging, subscribe, sampling, elicitation, progress, image/audio/embedded content) and
fixtures only the suite's reference "everything" server ships (`test://…` resources,
`test_prompt_*`). Each line carries its reason. The 10 scenarios that exercise the transport and
the tool/resource surface AXIOM does implement (`server-initialize`, `ping`, `tools-list`,
`tools-call-simple-text`, `tools-call-error`, `resources-list`, `server-sse-multiple-streams`,
`dns-rebinding-protection`, …) must pass.

Last local run (Windows, node 26): `10 passed, 22 failed (22 expected, 0 unexpected), cli exit 0`.

## CI

`.github/workflows/ci.yml` job `conformance` (ubuntu-24.04, node 24) runs after the build and
uploads `packages/conformance/results/**` as the `conformance-report` artifact.
