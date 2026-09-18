# Versioning and compatibility (v2)

## SemVer via Changesets

All `@codai/axiom-*` packages are released together as a **fixed group**
(`.changeset/config.json`: `"fixed": [["@codai/axiom-*"]]`), so every published
package carries the same version. `@codai/axiom-testkit` is private and ignored.

- Any change under `packages/*/src` (except `testkit`) needs a `.changeset/*.md`;
  `scripts/check-changeset-present.mjs` fails CI without one.
- `pnpm changeset` records the bump level; `changeset version` writes versions
  and `CHANGELOG.md`; `changeset publish` runs from CI via npm trusted publishing
  (OIDC, provenance attached). See `.github/skills/release-axiom`.
- Pre-release tags (`alpha`, `beta`, `rc`) are not used unless the changeset
  says why.

## Two version numbers

| Number | Where | Changes when |
|--------|-------|--------------|
| Package version (`2.x.y`) | `package.json`, npm | every release, per SemVer below |
| Wire `apiVersion` (`axiom.dev/v2`) | `Plan`, `Manifest`, `CheckReport`, `ApplyResult`, `Profile` | only on a **major** — every object produced by any 2.x carries `axiom.dev/v2` |

A 2.x consumer must accept any 2.y document, y ≥ x, that validates against its
own schema **after** unknown optional fields are considered — but all schemas
are `.strict()`, so in practice: fields are only ever **added as optional** in
a minor, and a consumer on an older minor that meets a new optional field
rejects the document. Upgrade consumers before producers.

## What counts as breaking (major)

- Changing or removing `apiVersion: "axiom.dev/v2"`.
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
  new resources, new CLI verbs or flags.
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
server as `axiom://schema/<Kind>` and are versioned with the package.

## Runtime support

| AXIOM | Node | MCP SDK |
|-------|------|---------|
| 2.x | ≥ 22.14 | `@modelcontextprotocol/sdk` 1.30+ (bundled) |

## Deprecation policy for 1.x

`1.0.x` is **deprecated, not supported**. There is no LTS window and no security
patch commitment: the 1.x manifest hash was not content-bound and apply had no
rollback, so a security patch would be a rewrite (which is 2.0). After 2.0.0
ships, every `@codai/axiom-*` version `< 2.0.0` is marked deprecated on npm with
a pointer to `MIGRATION.md`. The 1.x tree is frozen under `packages/_v1/` in git
for reference only; nothing may import from it (`check-no-v1-imports`).

Earlier revisions of this file promised a 1.x→2.x codemod and a 12-month
support window. Neither applies; `axiom migrate v1` is a v2.2 convenience
(S-305), not a compatibility layer.
