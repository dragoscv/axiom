# Migrating AXIOM

[Docs site](https://dragoscv.github.io/axiom/) · [README](README.md) · [Changelog](CHANGELOG.md) · [v1 changelog (archived)](docs/archive/v1/CHANGELOG-v1.md) · [Versioning](docs/reference/versioning.md)

- [From 2.x to 3.0](#from-2x-to-30) — new `apiVersion`, one policy file.
- [From v1 (1.0.x) to v2](#migrating-from-axiom-v1-10x-to-v2) — the rewrite.

## From 2.x to 3.0

Nothing you stored with 2.x stops working: every 3.x release keeps reading the 2.x
`apiVersion` and the 2.x policy files. What changes is what 3.x **writes**.

### New `apiVersion`: `axiom.codai.ro/v3` (D-41)

| | 2.x | 3.0 |
|---|---|---|
| `Plan`, `Manifest`, `CheckReport`, `ApplyResult`, `Profile`, `RepoSnapshot` | `"axiom.dev/v2"` | `"axiom.codai.ro/v3"` (both accepted on input) |
| JSON Schema `$id` | `https://axiom.dev/schemas/v2/<Kind>.schema.json` | `https://dragoscv.github.io/axiom/schemas/v3/<Kind>.schema.json` |
| Apply attestation `predicateType` | `https://axiom.dev/attestation/apply/v1` | `https://dragoscv.github.io/axiom/spec/attestation/apply/v1` |

- `apiVersion` is part of the hashed `ManifestBody`, so **a plan written with
  `axiom.codai.ro/v3` has a different `planDigest` and `manifestDigest` than the same
  plan with `axiom.dev/v2`**. A 2.x plan still compiles to exactly its 2.x digest
  (pinned by the `plan-basic-v2` golden fixture), so stored manifests, signatures and
  `confirmDigest` values stay valid — only newly authored documents move.
- Clients that compare `apiVersion` against a literal must accept both strings.
  `@codai/axiom-schema` exports `API_VERSION` (canonical), `API_VERSION_V2`,
  `API_VERSIONS` and `isLegacyApiVersion()`.
- CEL/Cedar policies that test `manifest.apiVersion.startsWith('axiom.dev/')` must also
  accept `axiom.codai.ro/`.
- `gh attestation verify --predicate-type …` must use the new URI for attestations made
  by 3.x (2.x attestations keep the old one).

### One policy file: `.axiom/axiom.json` (D-42)

```json
{
  "$schema": "https://dragoscv.github.io/axiom/schemas/v3/AxiomConfig.schema.json",
  "version": 3,
  "extends": ["axiom:strict", "./team.json", "@codai/axiom-pack-house"],
  "gate": { "deny": ["infra/prod/**"], "mode": "warn" },
  "checks": { "extends": "strict", "checks": [] }
}
```

- `gate` holds what `.axiom/gate-profile.json` held; `checks` holds what
  `.axiom/profiles/<name>.json` held, without `apiVersion`/`kind`. An absent or empty
  `checks` section means the builtin `default` profile, never an empty one.
- `extends` entries, merged in order (later wins, the file itself last):
  - `./relative.json` — resolved from the declaring file; must stay inside the repository
    root or `~/.axiom`;
  - `axiom:default`, `axiom:strict`, `axiom:permissive` — the builtin check profile of that
    name plus a matching gate pack;
  - `@codai/axiom-pack-<name>` — an npm package that must **already be installed** in the
    repository's `node_modules` (AXIOM never installs anything) and ships `axiom-pack.json`
    (through `exports` or `package.json#axiomPack`). Packages outside the `@codai` scope
    resolve only with `"allowNpmPacks": true`.
- Merging is deep; `deny`, `ask`, `hard` and `allow` lists are **unioned**, so a pack can
  add a rule but never silently drop one. Check lists merge by `id`.
- An `extends` cycle or nesting deeper than 8 is `ERR_INVALID_PROFILE`; `version` above 3 is
  `ERR_PROFILE_VERSION`. Unknown keys produce a warning and are ignored.

### Legacy policy files

When `.axiom/axiom.json` does not exist, `.axiom/gate-profile.json` and
`.axiom/profiles/<name>.json` keep working exactly as in 2.x, with a deprecation warning.
When `.axiom/axiom.json` exists, it wins and the old files are ignored.

### `axiom migrate --profile`

```text
axiom migrate --profile [--root <dir>] [--dry-run]
```

Writes `.axiom/axiom.json` (`version: 3`) with `gate` from `.axiom/gate-profile.json` and
`checks` from `.axiom/profiles/<name>.json` — `<name>` is the profile `axiom init` created
for the repository (its directory name), or the only file in `.axiom/profiles/`.
`--dry-run` prints the file instead of writing it. The old files are **not** deleted; once
`axiom.json` is committed they are ignored and can be removed. Refuses with `ERR_EXISTS`
when `.axiom/axiom.json` already exists.

# Migrating from AXIOM v1 (1.0.x) to v2

v2 is a rewrite. Nothing produced by v1 — `.axm` files, IR JSON, `manifest.json`
outputs, HTTP clients — is accepted by v2 as-is. This document maps the v1
concepts onto v2 and says plainly what has no equivalent yet.

## What v1 was, and why it was replaced

v1 (`@codai/axiom-mcp` ≤ 1.0.24) parsed a `.axm` "agent" file into an IR, ran
fixed emitters (a Next.js 14 web app, a `node:http` API, Dockerfile and batch
placeholders), wrote a manifest, and exposed the whole thing over a plain
`node:http` JSON server on port 3411 that was not MCP. Verified on 2026-09-18:

- `irHash` hashed `{}` for every IR (a `JSON.stringify` replacer bug), so two
  unrelated IRs produced the same hash;
- artifact content lived inside the manifest, so a manifest could not be
  canonicalised or content-addressed;
- `check()` returned constant metrics;
- PR mode spawned `git` with `shell: true` and user-supplied strings;
- 38 of 95 tests failed.

Those are the reasons v1 manifests are **not** accepted by v2, not a policy
choice. There is nothing in a v1 manifest whose integrity v2 could vouch for.

## Concept mapping

| v1 | v2 |
|----|----|
| `.axm` agent file | `Plan` JSON (`apiVersion: "axiom.dev/v2"`, `kind: "Plan"`). The `.axm` v2 grammar compiles 1:1 to `Plan` (`axiom compile <plan.axm>`, `axiom_axm_parse`; [docs/reference/axm-syntax.md](docs/reference/axm-syntax.md)). |
| IR (`agents[]`, `version`) | No IR. The `Plan` is the input; the `ManifestBundle` is the canonical output. |
| Emitters (`webapp`, `apiservice`, `docker`, `batch`) | Removed. **Your agent writes the content** and puts it in `artifacts[].source` (`inline`, or `cas` for large trees). Optional template emitters exist as a separate plugin, `@codai/axiom-emitters-web` (`source: {type:"template"}`; [docs/guides/emitters.md](docs/guides/emitters.md)) — not in core. |
| `manifest.json` with `contentUtf8` / `contentBase64` | `ManifestBundle`: a JCS-canonical `manifest` body holding only digests, plus `blobs` (inline side-channel) or a CAS under `<root>/.axiom/cas/`. |
| `irHash`, `buildId`, `createdAt: deterministic-…` | `manifestDigest = sha256(JCS(manifest))`, `planDigest`, per-artifact `digest.sha256`. No timestamps inside anything hashed. |
| Profiles with `constraints` (`max_dependencies`, `frontend_bundle_kb`, …) | `Profile` with `checks[]` of typed predicates (`deps.max`, `content.maxBytes`, `path.deny`, …). See [docs/guides/checks.md](docs/guides/checks.md). |
| Capabilities `net("http")`, `fs("./path")`, `ai("provider")` | `Plan.capabilities` is a plain enum list (`fs`, `net`, `secret`, `ai`, `compute`, `git`) recorded in the manifest; enforcement is by checks, not by a capability sandbox. |
| HTTP server on `:3411` (`POST /parse`, `/generate`, `/check`, `/apply`, …) | MCP **stdio** server: `npx @codai/axiom-mcp mcp --root <dir>`; streamable HTTP via `axiom mcp --root <dir> --http <host:port>` ([docs/reference/mcp-tools.md](docs/reference/mcp-tools.md)). |
| `axiom_generate` | `axiom_plan_compile` |
| `axiom_check` | `axiom_check` (same name; input is a `ManifestBundle`, output is a `CheckReport` with `verdict: pass\|fail\|error`) |
| `axiom_apply` (mode `fs` / `pr`) | `axiom_apply` — **requires `confirmDigest === bundle.manifestDigest`** and a `root` inside the server's `--root` allowlist. `mode: "pr"` creates a branch and commits the touched paths without a shell (no push, no PR creation). |
| `axiom_reverse` / reverse-IR | Replaced by `axiom_repo_snapshot` (digest-only snapshot of a root subtree; no content). |
| `axiom_diff` (JSON-Patch between IRs) | `axiom_manifest_diff` (added / removed / changed artifacts between two manifests). |
| `AXIOM_REPO_ROOT` env var, `.git` walk-up | Removed. Roots are an explicit `--root` allowlist; no `cwd` or env fallback. |
| `postinstall` writing `~/.mcp/servers/axiom.json` | Removed. No install-time side effects. |
| `vscode-bridge` | Removed. `@codai/axiom-axm-lsp` (hand-written `vscode-languageserver`, D-14) + the `axiom-axm` VS Code extension replace it. |

## Tooling — `axiom migrate v1`

```text
axiom migrate v1 <manifest.json> [-o plan.json] [--profile default] [--cas <root>] [--content <dir>] [--overwrite]
```

Lifts a v1 `manifest.json` into a v2 `Plan`: paths become POSIX `RelPath`s,
`contentUtf8`/`contentBase64` become `inline` sources, hash-only artifacts are
read from the v1 output tree next to the manifest (or `--content <dir>`) and
re-verified against their `sha256`; `--cas <root>` stores the bytes under
`<root>/.axiom/cas` and emits `cas` sources instead. Known policy evidence and
the built-in `budget`/`edge` profile constraints map to v2 predicates
(`content.noSecrets`, `deps.max`, `manifest.maxTotalBytes`, `content.maxBytes`);
`buildId`, `irHash`, `createdAt`, `sha256`, `bytes`, `kind`, runtime SLA/unit
evidence and unknown fields are listed in `metadata.migration.dropped` with a
reason. Exit `0` clean, `1` migrated with warnings (still written), `2` not a
v1 manifest. Full field table: [docs/guides/migrate.md](docs/guides/migrate.md).

The manual transformation, for reference, is:

1. For every v1 artifact with `contentUtf8`, emit
   `{ "path": <path>, "source": { "type": "inline", "content": <contentUtf8> } }`.
2. For every artifact with `contentBase64`, emit the same with
   `"encoding": "base64"`.
3. Drop `kind`, `sha256`, `buildId`, `createdAt`, `irHash`, `evidence[]` — v2
   recomputes every digest and does not trust the old ones.
4. Set `op` to `"overwrite"` for any path that already exists in the target
   tree; v2's default `create` fails with `ERR_EXISTS` otherwise.
5. Wrap in `{ "apiVersion": "axiom.dev/v2", "kind": "Plan", "name": <kebab-case>,
   "intent": <string>, "artifacts": [...] }`.

Paths must satisfy v2's `RelPath` rules (relative POSIX, NFC, no `..`, no
Windows reserved names, no trailing dot/space). v1 output paths that were
generated under `out/` should have the `out/` prefix removed if the intent is to
write into the repository root.

## Client changes

- Replace HTTP calls with an MCP client (VS Code `.vscode/mcp.json`, Claude
  Desktop, or any MCP SDK). Config snippets: [`packages/mcp/README.md`](packages/mcp/README.md).
- Run `axiom_apply_dry_run` first, read `manifestDigest` from the result, then
  pass it as `confirmDigest` to `axiom_apply`.
- Branch on `error.code` (closed enum in `packages/schema/src/errors.ts`), not on
  message text.
- CLI verbs replace the HTTP endpoints: `axiom compile`, `axiom check`,
  `axiom apply --dry-run`, `axiom apply --confirm <digest>`, `axiom rollback`,
  `axiom diff`, `axiom verify`, `axiom schema`.

## Deprecation of 1.x

After 2.0.0 ships, every `@codai/axiom-*` package at `< 2.0.0` is marked
deprecated on npm with a pointer to this file. No further 1.x releases are
planned; see [docs/reference/versioning.md](docs/reference/versioning.md).
