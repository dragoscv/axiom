---
"@codai/axiom-schema": major
"@codai/axiom-canon": major
"@codai/axiom-checks": major
"@codai/axiom-axm": major
"@codai/axiom-mcp": major
---

v3 wire identity and one policy file (D-41, D-42).

- New canonical `apiVersion: "axiom.codai.ro/v3"` for every document AXIOM creates (Plan, Manifest,
  CheckReport, ApplyResult, Profile, RepoSnapshot); `"axiom.dev/v2"` keeps parsing through 3.x and a
  2.x plan still compiles to its 2.x digest. New plans therefore have new `planDigest`/`manifestDigest`
  values (golden fixtures re-pinned; `plan-basic-v2` pins the 2.x digest). Schema exports
  `API_VERSION_V2`, `API_VERSIONS`, `isLegacyApiVersion`. JSON Schema `$id`s move to
  `https://dragoscv.github.io/axiom/schemas/v3/`.
- Attestation predicate URIs move to `https://dragoscv.github.io/axiom/spec/...`
  (`AXIOM_APPLY_ATTESTATION_V1`, `AGENT_DECISION_V0_1`, build type, builder id); the 2.x URIs stay
  exported as `*_LEGACY`.
- `.axiom/axiom.json` (`version: 3`, `gate`, `checks`, `extends`): `loadAxiomConfig` with
  relative-file, `axiom:<pack>` and installed `@codai/axiom-pack-*` extends, union of
  deny/ask/hard/allow, cycle/depth → `ERR_INVALID_PROFILE`, version > 3 → `ERR_PROFILE_VERSION`,
  unknown keys warn. `loadProfile(name, { config })` reads its `checks` section. `migrateProfile`
  folds `.axiom/gate-profile.json` + `.axiom/profiles/<name>.json` into it without deleting them.
  New `AxiomConfig` JSON Schema.
