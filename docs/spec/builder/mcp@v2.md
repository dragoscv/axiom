# Builder mcp@v2

*Builder id `https://dragoscv.github.io/axiom/spec/builder/mcp@v2`: the AXIOM toolchain (`@codai/axiom-mcp` and the engines it bundles) acting as builder or verifier in AXIOM statements.*

| | |
|---|---|
| Builder id | `https://dragoscv.github.io/axiom/spec/builder/mcp@v2` |
| Used in | `runDetails.builder.id` of [plan@v2 provenance](../build/plan@v2.md); `predicate.verifier.id` of the [apply attestation](../attestation/apply/v1.md) |
| Legacy URI | `https://axiom.dev/builder/mcp@v2` — what 2.x produced; same builder, so a verifier treats both as equal |
| Status | stable |

## What the id asserts

A statement carrying this id was produced by the AXIOM code in `packages/canon` (statement
builders), `packages/plan` (compilation) and `packages/apply` (`verifyTree`), shipped as
`@codai/axiom-mcp`, the `axiom` standalone binary or the `dragoscv/axiom/action` GitHub Action.
It runs with:

- **no clock in anything hashed** — timestamps appear only in optional `runDetails.metadata`;
- **no network** unless `--allow-net` was given for `ref` sources (the digest still pins them);
- **an explicit root allowlist** — there is no `cwd` fallback;
- **fail-closed checks** — a predicate that cannot run is `error`, which blocks apply.

The exact versions are in the statement itself: `runDetails.builder.version` (a package → version
record) or `predicate.verifier.version`.

## Trust

The id says *which* software made the claim, not *who ran it*. Bind the claim to an identity by:

- **Sigstore**: CI uploads with `id-token: write`; `gh attestation verify --repo <owner>/<repo>`
  checks the workflow identity that signed it.
- **Ed25519 DSSE**: `axiom keys sign` / `axiom journal attest --sign`, verified against
  `.axiom/trust/keys.json` ([Signing](../../guides/signing.md)).

Re-running the build is always possible: compilation and verification are deterministic, so
`axiom plan compile` + `axiom plan verify --tree` reproduce the claim from the Plan and the tree.

`@v2` names the builder contract, not the npm version: it stays `@v2` across AXIOM 3.x because
the statements it builds have the same shape.
