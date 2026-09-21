---
"@codai/axiom-checks": patch
"@codai/axiom-mcp": patch
---

Standalone binaries, MCP Registry listing and the docs site (Phase 5, D-27…D-31).

- **mcp**: new single-executable entry `src/sea.ts` + `tsdown.sea.config.ts`
  (`pnpm build:sea` → one inlined CommonJS bundle) and `scripts/build-sea.mjs`
  (`node --build-sea`, Node ≥ 25.5). `release.yml` builds `axiom-{linux,darwin}-{x64,arm64}`
  and `axiom-win-x64.exe` natively on five runners, attaches them with `SHA256SUMS` and a
  Sigstore build-provenance attestation to the GitHub release, publishes `server.json` to
  the MCP Registry as `io.github.dragoscv/axiom`, and moves the `v2` tag of
  `dragoscv/axiom/action`. The package version is resolved through `src/version.ts`
  (`define`d at build time in the binary; read from `package.json` otherwise).
  `server.json` ships in the npm tarball. No wire or tool change.
- **checks**: `expr.cedar` treats `ERR_UNKNOWN_BUILTIN_MODULE` (what a Node single
  executable raises for any non-builtin specifier) as "optional dependency not installed" and
  fails closed with `ERR_PROVIDER_FAILED`, instead of rethrowing.
- Documentation restructured under `docs/{getting-started,concepts,guides,reference,integration,design}`
  and published at <https://dragoscv.github.io/axiom/> (Astro Starlight, `apps/site`), with
  `llms.txt`, `install.sh` and `install.ps1`.
