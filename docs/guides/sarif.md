# SARIF export — `axiom plan check --format sarif`

*Turn a `CheckReport` into a SARIF 2.1.0 log and upload it to GitHub code scanning (S-1214).*

`axiom plan check <bundle.json> --root <dir> --format sarif` runs the same checks as `--json` and
prints one SARIF 2.1.0 log on stdout instead of the `CheckReport`. Exit codes do not change:
`0` pass, `1` findings / fail (the log is still complete), `2` structural error.

```sh
axiom plan check .axiom/manifests/<hex>.json --root . --format sarif > axiom.sarif
```

## Mapping

| SARIF | From the `CheckReport` |
|---|---|
| `$schema` / `version` | `https://json.schemastore.org/sarif-2.1.0.json` / `2.1.0` |
| `runs[0].tool.driver` | `name: "axiom"`, `version` = CLI version, `informationUri` = `https://github.com/dragoscv/axiom` |
| `driver.rules[]` | one rule per **distinct finding id**; `shortDescription` names the id and predicate; `defaultConfiguration.level` from the first finding's severity |
| `results[].ruleId` | finding `id` |
| `results[].level` | severity: `error` → `error`, `warn` → `warning`, `info` → `note` |
| `results[].message.text` | finding `message` |
| `results[].locations[0]` | finding `path` (POSIX, relative, `uriBaseId: "%SRCROOT%"`); a finding without a path points at the **bundle file** |
| `results[].partialFingerprints["axiom/v1"]` | `sha256(id + "\|" + path + "\|" + message)` hex — stable across runs, so code scanning closes and reopens alerts instead of duplicating them |
| `runs[0].invocations[0].executionSuccessful` | `verdict !== "error"` (a provider that could not run is an unsuccessful run, never a silent pass) |
| `runs[0].properties` | `{ manifestDigest, verdict, profile }` |

`originalUriBaseIds["%SRCROOT%"]` is the root as a `file:` URI; code scanning rebases it on the
checkout, so relative paths line up with the repository.

## GitHub Action

The [action](../integration/github-action.md#sarif-and-code-scanning) does this for you with
`sarif: <path>`; it needs `permissions: security-events: write`.

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v5
  - uses: dragoscv/axiom/action@v2
    with:
      bundle: .axiom/manifests/<hex>.json
      sarif: axiom.sarif
      # check-profile: strict
```

## Implementation

`packages/mcp/src/sarif.ts`:

```ts
export const SARIF_SCHEMA_URI = "https://json.schemastore.org/sarif-2.1.0.json";
export function reportToSarif(
  report: CheckReport,
  o: { toolVersion: string; root?: string; bundlePath?: string; informationUri?: string },
): SarifLog;
```

No JSON-schema dependency: the output is the subset of SARIF 2.1.0 that `upload-sarif` requires,
checked by shape in `sarif.test.ts`.

---

**See also**

- [Checks](checks.md) — what produces the findings
- [GitHub Action](../integration/github-action.md) — `sarif` and `check-profile` inputs
- [Error codes](../reference/error-codes.md)
