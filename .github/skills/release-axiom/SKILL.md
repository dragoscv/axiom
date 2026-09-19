---
name: release-axiom
description: Cut and publish a release of the @codai/axiom-* packages — changeset status, version PR, tag, trusted-publishing workflow, live verification on npmjs.com, deprecations. Use when asked to release, publish, bump, or "ship v2.x", or when release.yml failed and the state needs to be verified before retrying.
---

# Release AXIOM

All `@codai/axiom-*` packages are a **fixed group** (`.changeset/config.json`):
one version for all, `@codai/axiom-testkit` ignored (private). Publishing runs
in `.github/workflows/release.yml` via **npm trusted publishing** (OIDC,
`id-token: write`, npm ≥ 11.5) — no `NPM_TOKEN` anywhere. Provenance is automatic.

## Steps

1. **Preconditions** (paste output): `git status --short` clean for
   `packages/**`; `pnpm exec changeset status` lists the pending changesets;
   CI green on `main` for all 6 matrix cells + `golden-cross-os`.
   No pending changeset but `packages/*/src` changed since the last tag →
   `pnpm changeset` first (`check-changeset-present` would have failed in CI).
2. **Version**: `pnpm changeset version` → bumps every `packages/*/package.json`,
   writes each package `CHANGELOG.md`, deletes consumed `.changeset/*.md`.
   Review the generated changelog wording; fix typos here, not after publish.
3. **Commit** explicit paths only (shared clone):
   `git add packages/*/package.json packages/*/CHANGELOG.md .changeset` →
   `git commit -m "chore(release): v2.x.y"`.
4. **Full local gate** — same as `release.yml`, so a red run is caught before
   the tag: `pnpm build; pnpm typecheck; pnpm exec vitest run;
   node scripts/run-guards.mjs --strict` (strict = bundle ≤ 950 KB and cold
   start p50 ≤ 250 ms must be *measured*, not skipped).
5. **Tag & push**: `git tag v2.x.y; git push origin main --follow-tags`.
   The tag triggers `release.yml` (or use *workflow_dispatch* for a rerun).
6. **Watch the run**: `gh run watch` (or the Actions tab). It does
   build → typecheck → test → guards → `changeset publish` → pushes tags.
   First release of a package: trusted publishing must be configured on
   npmjs.com (package → Settings → Trusted publishing → GitHub Actions →
   `dragoscv/axiom`, workflow `release.yml`) *before* the run; otherwise
   `E404`/`ENEEDAUTH` — configure, then rerun the same tag. Since npm's
   stage-only default, the trusted publisher must also *allow publish*:
   `npm trust github --file .github/workflows/release.yml --allow-publish`
   inside each package dir (9 packages), or the run stages without publishing.
7. **Verify LIVE**, never infer:
   `npm view @codai/axiom-mcp version dist.attestations` shows the new version
   and a provenance attestation; the npmjs.com page shows the *Provenance*
   badge; `npx -y @codai/axiom-mcp@2.x.y --version` prints it.
   `node scripts/check-release-complete.mjs` compares every tagged
   `packages/*/package.json` version against the registry — it FAILS on a
   partial release (v2.1.0 shipped 2 of 9 packages for a day).
8. **Failed mid-publish?** Fixed group means some packages may be live and
   others not. `node scripts/check-release-complete.mjs` lists exactly which;
   `changeset publish` is idempotent (skips already published versions) —
   rerun the workflow, do **not** bump again. If CI cannot publish (trusted
   publishing not yet enabled), repair from a logged-in terminal:
   `pwsh -NoProfile -File scripts/release-bootstrap.ps1 -Publish -Missing`
   (publishes only tagged versions absent from the registry, in dependency
   order; refuses untagged versions). One browser approval covers the session.
9. **Post-release**: update `PLAN.md` + `TRACKER.csv` (same commit) for the
   phase story (e.g. S-109 → done); first v2.0.0 only — deprecate 1.x:
   `npm deprecate @codai/axiom-mcp@"<2.0.0" "superseded by 2.x — see MIGRATION.md"`
   (irreversible-ish: ask the owner first).
10. **Rollback** is `npm deprecate <pkg>@2.x.y "<reason>"` + a patch release;
    `npm unpublish` only within 72 h and only with owner consent.
