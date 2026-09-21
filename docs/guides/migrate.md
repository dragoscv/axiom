# `axiom migrate v1` — v1 manifest → v2 Plan

*Lift an AXIOM 1.0.x manifest into a v2 Plan: every path and byte preserved, everything v2 cannot express listed in `metadata.migration.dropped`.*

`axiom migrate v1 <manifest.json> [-o plan.json] [--profile default] [--cas <root>] [--content <dir>] [--name <kebab>] [--overwrite]`

Lifts an AXIOM 1.0.x `manifest.json` into a v2 `Plan` (S-305). The output validates against
`PlanSchema`, compiles with `axiom compile` when the file bytes are available, and preserves
every file path and every byte: the sha256 of each v1 artifact equals the v2 artifact digest after
compile. Everything v2 cannot represent is listed in `metadata.migration.dropped` with a reason —
nothing is dropped silently, and nothing that is hashed carries a clock value (PLAN.md §2,
invariant 1).

The same logic is exported as a pure function for programmatic use:

```ts
import { migrateV1 } from "@codai/axiom-mcp/migrate"; // via the lazy chunk in the CLI bundle
const { plan, report } = await migrateV1(v1Json, { version: "2.1.0", resolveContent, casRoot });
```

## Where the bytes come from

| v1 artifact shape | v2 source | Notes |
|---|---|---|
| `contentUtf8` | `inline` (utf8) | ≤ 256 KiB; larger needs `--cas` |
| `contentBase64` | `inline` (base64) | ≤ 192 KiB decoded; larger needs `--cas` |
| `sha256` only, bytes found under `--content <dir>` (default: the manifest's directory) | `inline`, or `cas` with `--cas` | Bytes are re-hashed; a mismatch with the declared `sha256` is `ERR_DIGEST_MISMATCH` (exit 2) |
| `sha256` only, bytes not found | `cas` pointing at the declared digest | Plan is valid; `compile` reports `ERR_BLOB_MISSING` until the blob exists. Exit 1 + warning |
| `kind: "dir"` | — (dropped) | v2 creates directories implicitly |

With `--cas <root>` every resolved blob is written to `<root>/.axiom/cas/sha256/<aa>/<hex>` through
the same `casPut` the compiler uses (tmp → fsync → rename), and the Plan uses `cas` sources so it
stays small regardless of tree size.

## Field mapping

| v1 | v2 | Fate |
|---|---|---|
| `version` (`1.x`) | `metadata.migration.source.version` | kept as provenance, also listed in `dropped` |
| `profile` | `metadata.migration.source.profile`; constraints → `checks[]` (table below) | `Plan.profile` is `--profile` (default `default`), not the v1 name |
| `artifacts[].path` (`out\web\x` or `out/web/x`) | `artifacts[].path` — POSIX, `./` stripped, must satisfy `RelPath` | absolute / `..` / drive paths → `ERR_PATH_NOT_RELATIVE_POSIX`; two paths colliding after normalisation → `ERR_INVALID_PLAN` |
| `artifacts[].contentUtf8 / contentBase64` | `source.inline` | see table above |
| `artifacts[].sha256`, `bytes` | recomputed at compile | listed in `dropped` per artifact; verified against content when both exist (inline mismatch = warning, sidecar mismatch = error) |
| `artifacts[].kind` | — | `dir` artifacts dropped; `file` implied |
| `evidence[]` with `details.expression = scan.artifacts.no_personal_data()` | `checks[] { predicate: "content.noSecrets" }` | id = `checkName` |
| `evidence[]` of kind `sla` / `unit` (latency, `http.healthy(…)`, cold start) | — | runtime measurements; v2 checks are static predicates over the manifest |
| `evidence[]` with any other expression | — | `no v2 predicate for expression …` |
| `buildId` | — | v2 identifies a build by `manifestDigest` |
| `irHash` | — | v1 hashed `{}` for every IR; v2 has `planDigest` |
| `createdAt` | — | timestamp: never enters a Plan |
| any unknown top-level or artifact key | — | `no v2 equivalent` |

`op` is `create` for every artifact (v2 default) unless `--overwrite` is given; `mode` is `0644`.
`name` defaults to `migrated-v1-<profile>`; `intent` summarises the source.

### v1 built-in profile constraints → predicates

The three shipped v1 profiles (`default`, `budget`, `edge`) are known to the migrator; their
constraints are mapped with ids `v1-<profile>-<constraint>`:

| v1 constraint | v2 check | Profiles |
|---|---|---|
| `max_dependencies: n` | `deps.max { max: n }` | budget (5) |
| `max_bundle_size_kb: n` | `manifest.maxTotalBytes { max: n·1024 }` | budget (500) |
| `max_artifact_size_mb: n` | `content.maxBytes { max: n·1024·1024 }` | edge (50) |
| `no_analytics`, `no_telemetry`, `no_fs_heavy`, `timeout_ms`, `memory_mb`, `cold_start_ms` | — dropped | runtime metrics that v1 measured as constants |

An unknown v1 profile name is recorded in `dropped` (`unknown v1 profile "…"`), since its
constraints are not available from the manifest alone.

## `metadata.migration`

```json
{
  "from": "v1",
  "tool": "axiom migrate",
  "version": "2.1.0",
  "source": { "version": "1.0.0", "profile": "budget" },
  "dropped": [
    { "field": "buildId", "reason": "v2 identifies a build by manifestDigest = sha256(JCS(manifest))" },
    { "field": "createdAt", "reason": "timestamp; nothing hashed in v2 may carry a clock value (invariant 1)" },
    { "field": "artifacts[0].sha256", "reason": "v2 recomputes every digest at compile time (…)" }
  ],
  "warnings": []
}
```

`metadata` is part of the Plan and therefore of `planDigest`; migrating the same manifest twice
with the same options yields a byte-identical Plan (tested).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | migrated, no warnings |
| 1 | migrated **and written**, with warnings (unresolved content, declared hash/size disagreeing with inline content) |
| 2 | cannot migrate: not a v1 manifest (`ERR_INVALID_MANIFEST`), bad path (`ERR_PATH_NOT_RELATIVE_POSIX`), duplicate path / nothing to write (`ERR_INVALID_PLAN`), sidecar bytes ≠ declared sha256 (`ERR_DIGEST_MISMATCH`), oversized inline content without `--cas` (`ERR_BLOB_TOO_LARGE`), artifact with neither content nor sha256 (`ERR_BLOB_MISSING`) |

Stdout is JSON: with `-o`, the report plus `out`; without it, `{ plan, report }`.

## Example

```text
$ axiom migrate v1 out-budget.manifest.json -o plan.json
{ "ok": true, "artifacts": { "total": 4, "inline": 3, "cas": 0, "unresolved": 0, "skipped": 1 },
  "checks": 2, "dropped": [ … ], "warnings": [], "out": "plan.json" }
$ axiom compile plan.json -o bundle.json
$ axiom apply bundle.json --root . --dry-run
```

Fixtures used by the round-trip test live in `packages/mcp/fixtures/v1/` (an inline-content
manifest, a budget manifest with base64 + `dir`, an edge manifest with a sidecar `out/` tree, and
the real archived hash-only `manifest.json`). The migrator is a lazy CLI chunk
(`dist/migrate-lazy.js`); the eager MCP bundle does not include it.

---

**See also**

- [MIGRATION.md](../../MIGRATION.md) — the 1.x → 2.x concept mapping and client changes
- [Plan format](../reference/plan-format.md) — what the emitted Plan must satisfy
- [CAS](../concepts/cas.md) — where `--cas` puts the bytes
- [Versioning](../reference/versioning.md) — the 1.x deprecation policy
