# Versioning and compatibility

*One version for every published `@codai/axiom-*` package, one wire `apiVersion` per major, and what counts as breaking.*

## SemVer via Changesets

All `@codai/axiom-*` packages are released together as a **fixed group**
(`.changeset/config.json`: `"fixed": [["@codai/axiom-*"]]`), so every published
package carries the same version. `@codai/axiom-testkit` and `@codai/axiom-conformance` are
private and ignored by Changesets.

- Any change under `packages/*/src` (except `testkit`) needs a `.changeset/*.md`;
  `scripts/check-changeset-present.mjs` fails CI without one.
- `pnpm changeset` records the bump level; `changeset version` writes versions
  and `CHANGELOG.md`; `changeset publish` runs from CI via npm trusted publishing
  (OIDC, provenance attached). See [`.github/skills/release-axiom`](../../.github/skills/release-axiom/SKILL.md).
- Pre-release tags (`alpha`, `beta`, `rc`) are not used unless the changeset
  says why.

## Two version numbers

| Number | Where | Changes when |
|--------|-------|--------------|
| Package version (`3.x.y`) | `package.json`, npm | every release, per SemVer below |
| Wire `apiVersion` (`axiom.codai.ro/v3`) | `Plan`, `Manifest`, `CheckReport`, `ApplyResult`, `Profile`, `Snapshot` | only on a **major** |

The wire `apiVersion` changes only on a major release. 3.0 introduced **`axiom.codai.ro/v3`**,
which every object written by 3.x carries; the 2.x value **`axiom.dev/v2`** is still accepted on
read throughout 3.x, so documents stored by 2.x keep validating. A `Manifest` copies the
`apiVersion` of its Plan, so the golden digests changed when the fixtures moved to v3. Dropping
`axiom.dev/v2` on read is a 4.0 change.

A 3.x consumer must accept any 3.y document, y ≥ x, that validates against its
own schema **after** unknown optional fields are considered — but all schemas
are `.strict()`, so in practice: fields are only ever **added as optional** in
a minor, and a consumer on an older minor that meets a new optional field
rejects the document. Upgrade consumers before producers.

## What counts as breaking (major)

- Changing the written `apiVersion` (`axiom.codai.ro/v3`) or no longer accepting a value that is
  accepted on read (`axiom.dev/v2` through 3.x).
- Removing or renaming a field of any wire type; making an optional field
  required; tightening a constraint so that a previously valid document fails
  (e.g. a stricter `RelPath` rule, a smaller size limit).
- Changing the canonicalisation or hashing of `ManifestBody` — anything that
  makes the same `Plan` compile to a different `manifestDigest`. Golden fixtures
  in `packages/testkit/golden/*.expected.json` pin this; re-pinning them is a
  major unless the change is a bug fix in a case that could never have been
  applied.
- **Removing** an error code from `ERROR_CODES`, or changing which code a given
  failure produces.
- Changing an MCP tool's **input shape** in a non-additive way, removing a tool,
  renaming a tool, or changing its `annotations` from read-only to destructive.
- Changing the CLI exit-code contract (`0` ok, `1` verdict fail / apply failed,
  `2` usage or error).
- Changing the `.axiom/` layout in a way that an older version cannot read
  (journal, applied marker, lock).
- Raising the minimum Node version.
- Removing a built-in predicate or changing its `params` non-additively;
  changing a built-in profile so that a manifest that passed now fails.

## Minor

- New optional fields on wire types, new error codes, new tools, new predicates,
  new resources, new CLI commands or flags.
- New built-in checks in a profile **only** if they are `warn`/`info`; a new
  `error`-severity check in `default` is breaking for anyone applying through it.
- Loosening a constraint (accepting more).

## Patch

Bug fixes that do not change any accepted/rejected document set or any digest,
performance, documentation, dependency bumps without API impact.

## JSON Schemas

`packages/schema/schemas/*.json` are generated from the Zod sources with
`pnpm --filter @codai/axiom-schema build:jsonschema` and committed;
`check-schema-json-fresh` fails CI when they drift. They are served by the MCP
server as `axiom://schema/<Kind>`, published at
`https://dragoscv.github.io/axiom/schemas/v3/<Kind>.schema.json`, and are versioned with the
package.

## Deprecated surfaces kept until 4.0

- The 2.x CLI verbs (`axiom compile`, `axiom apply`, `axiom gate`, `axiom init`, …) are hidden
  aliases of the 3.0 noun commands; `axiom gate --stdin` is byte-identical to `axiom hook gate`.
  See [cli.md](cli.md).
- `.axiom/gate-profile.json` and `.axiom/profiles/*.json` are still read, with a deprecation
  warning; `axiom setup migrate --profile` writes `.axiom/axiom.json`
  ([profiles.md](profiles.md)).
- `@codai/axiom-axm-lsp` re-exports the language server now shipped as `@codai/axiom-axm/lsp`.
- Attestation predicate URIs under `axiom.dev` / `auxidus.dev` are accepted on read; new
  attestations use the docs-site URIs (see [Spec](../spec/attestation/apply/v1.md)).

## Runtime support

| AXIOM | Node | MCP SDK |
|-------|------|---------|
| 2.0 – 2.1 | ≥ 22.14 | `@modelcontextprotocol/sdk` 1.30 (bundled; 2025-era wire only) |
| 2.2 – 3.x | ≥ 22.14 | `@modelcontextprotocol/server` 2.x (bundled; serves 2026-07-28 **and** 2025-era clients, `--wire`) |

## Deprecation policy for 1.x

`1.0.x` is **deprecated, not supported**. There is no LTS window and no security
patch commitment: the 1.x manifest hash was not content-bound and apply had no
rollback, so a security patch would be a rewrite (which is 2.0). After 2.0.0
ships, every `@codai/axiom-*` version `< 2.0.0` is marked deprecated on npm with
a pointer to `MIGRATION.md`. The 1.x tree is frozen under `packages/_v1/` in git
for reference only; nothing may import from it (`check-no-v1-imports`).

Earlier revisions of this file promised a 1.x→2.x codemod and a 12-month
support window. Neither applies; `axiom setup migrate v1` is a convenience, not a
compatibility layer.

---

**See also**

- [MIGRATION.md](../../MIGRATION.md) — moving from 1.x
- [Migrate](../guides/migrate.md) — `axiom setup migrate v1`
- [Decisions](../design/decisions.md) — D-19 (wire eras), D-22 (2.1.0 repair)
- [CHANGELOG.md](../../CHANGELOG.md) — release index
