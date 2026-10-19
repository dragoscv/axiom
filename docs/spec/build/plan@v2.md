# Build type plan@v2

*`buildDefinition.buildType` = `https://dragoscv.github.io/axiom/spec/build/plan@v2`: a SLSA Provenance v1 build where the "source" is an AXIOM Plan and the "artifact" is the canonical Manifest compiled from it.*

| | |
|---|---|
| Build type | `https://dragoscv.github.io/axiom/spec/build/plan@v2` |
| Predicate type | `https://slsa.dev/provenance/v1` |
| Envelope | in-toto Statement v1 |
| Builder | `buildStatement` in `packages/canon/src/statement.ts` |
| Legacy URI | `https://axiom.dev/build/plan@v2` — what 2.x produced; same contract, so a verifier treats both as equal |
| Status | stable |

`@v2` names the Plan → Manifest compilation contract (canonical JCS body, sha256 per artifact,
blobs outside the manifest), which did not change in 3.0 — only the wire `apiVersion` moved to
`axiom.codai.ro/v3`, and `axiom.dev/v2` Plans still compile to the same contract.

## Subject

One entry: `{ name: <bundle name>, digest: { sha256: <hex of manifestDigest> } }`.

## Predicate fields specific to this build type

| Field | Type | Meaning |
|---|---|---|
| `buildDefinition.buildType` | string | this URI |
| `buildDefinition.externalParameters.plan` | `{ sha256: hex }` | the plan digest (`planDigest`) |
| `buildDefinition.externalParameters.profile` | string | the check profile the manifest names |
| `buildDefinition.internalParameters.toolchain` | `Record<string, string>` | package → version (keys sorted) |
| `buildDefinition.resolvedDependencies` | `[]` | always empty: content travels as blobs, CAS or digest-pinned refs already bound by the manifest |
| `runDetails.builder` | `{ id, version }` | `id` = [`builder/mcp@v2`](../builder/mcp@v2.md); `version` = the toolchain record |
| `runDetails.byproducts` | `{ name, digest }[]` | optional extra outputs, sorted by name |
| `runDetails.metadata` | `{ invocationId?, startedOn?, finishedOn? }` | present only when the caller supplies it; omitted otherwise so the statement is deterministic |

## Example

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "bundle.json", "digest": { "sha256": "4f1c…e2" } }],
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": {
      "buildType": "https://dragoscv.github.io/axiom/spec/build/plan@v2",
      "externalParameters": { "plan": { "sha256": "c03d…7a" }, "profile": "default" },
      "internalParameters": { "toolchain": { "@codai/axiom-plan": "3.0.0" } },
      "resolvedDependencies": []
    },
    "runDetails": {
      "builder": { "id": "https://dragoscv.github.io/axiom/spec/builder/mcp@v2",
                   "version": { "@codai/axiom-plan": "3.0.0" } },
      "byproducts": []
    }
  }
}
```

## Verifying

1. Recompile the Plan (`axiom plan compile plan.json --root .`) and compare `manifestDigest`
   with the subject digest — compilation is deterministic on every OS.
2. `axiom plan verify bundle.json` recomputes the canonical digest and every blob hash.
3. After an apply, `axiom plan verify bundle.json --tree .` proves the tree matches; with
   `--attest` it emits an [apply attestation](../attestation/apply/v1.md).
4. `gh attestation verify bundle.json --repo <owner>/<repo> --predicate-type https://slsa.dev/provenance/v1`
   for a statement uploaded from CI.
