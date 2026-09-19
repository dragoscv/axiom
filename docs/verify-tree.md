# `axiom verify --tree` and the GitHub Action

*S-403 · decisions D-20 (scope) and D-21 (attestation).*

A manifest says what a tree should contain at the paths it touched. `verify --tree` asks
whether a real tree agrees — in CI, before a merge, long after the agent that produced the
manifest is gone.

```
axiom verify <bundle.json> --tree <root> [--pre] [--attest <out.intoto.json>]
```

| flag | meaning |
|---|---|
| `--tree <root>` | compare the tree under `root` with the manifest |
| `--pre` | compare with the manifest's declared **pre-image** set (`ManifestBody.preImage`, S-402) instead of the post-apply artifacts — "is this the tree the manifest was compiled against?" |
| `--attest <file>` | on success, write an in-toto Statement to `<file>` and the bare predicate to `<file minus .intoto.json>.predicate.json` (both JCS-canonical) |

Exit `0` when every path matches, `1` on any mismatch (or when `--pre` is asked of a manifest
that carries no `preImage`), `2` on usage / structural failure. Output is JSON:

```json
{
  "ok": false,
  "manifestDigest": "sha256:…",
  "canonical": true,
  "root": "/home/ci/repo",
  "tree": "post",
  "paths": 2,
  "mismatches": [ { "path": "src/x.ts", "op": "create", "expected": "<sha256>", "actual": "<sha256>" } ]
}
```

## Scope (D-20)

Only the manifest's own paths are compared: every `create`/`overwrite` artifact must be present
with the declared digest, every `delete` must be absent. Files the manifest never mentioned are
ignored, so the check survives unrelated commits. A whole-root digest was rejected for exactly
that reason. `--pre` swaps the expected set for `preImage[]`, which lists what compile saw for
each path (digest or `absent`).

A symlink, directory or containment escape where a file is expected is a mismatch whose
`actual` is the error code (`ERR_SYMLINK_IN_PATH`, `non-file:dir`, …). The command never
takes the lock and never writes under `.axiom/`; structural verification (`verifyBundle`) runs
first, so a self-inconsistent bundle stops before any file is read.

## Attestation (D-21)

`--attest` emits an in-toto Statement v1 with

- `predicateType: https://axiom.dev/attestation/apply/v1`
- `subject`: the manifest (`name` = plan name, `digest` = `manifestDigest`) **plus** one entry per
  present artifact path, so `gh attestation verify` can be pointed at either the manifest digest
  or a single file.
- `predicate`: `{ manifest, plan, profile, tree: "post"|"pre", paths[], preImage?[], verifier: { id, version }, source? }` —
  `source` carries `GITHUB_REPOSITORY/REF/SHA/RUN_ID` when present, nothing else. No clock: the
  same inputs produce identical bytes.

The Statement is what you keep; the sibling `.predicate.json` is what `actions/attest` wants
(it builds the Statement itself from `predicate-path` + the subject you name).

## GitHub Action

```yaml
# .github/workflows/axiom-verify.yml
on: pull_request
permissions:
  contents: read
  id-token: write        # only for attest: true
  attestations: write    # only for attest: true
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: dragoscv/axiom/action@v2
        with:
          bundle: .axiom/manifests/<hex>.json   # the bundle the agent applied
          root: .
          # pre: true                            # verify the pre-image set instead
          # attest: true                         # upload an attestation on success
```

| input | default | meaning |
|---|---|---|
| `bundle` | — | ManifestBundle JSON |
| `root` | `.` | tree to verify |
| `pre` | `false` | verify `preImage` instead of artifacts |
| `attest` | `false` | write + upload the in-toto attestation via `actions/attest@v4` |
| `attestation-path` | `axiom-attestation.intoto.json` | where the Statement is written |
| `version` | `2` | `@codai/axiom-mcp` dist-tag / version installed with `npm i -g` |
| `local-cli` | — | path to a built `cli.js` (dogfooding only) |

Outputs: `ok`, `manifest-digest`, `mismatches` (count), `attestation-path`. A mismatch fails
the step with an `::error` annotation naming the digest and the count; the JSON is in the log.

Verify later with the GitHub CLI:

```
gh attestation verify --repo <owner>/<repo> --predicate-type https://axiom.dev/attestation/apply/v1 \
  --subject-digest sha256:<manifest hex> /dev/null
```

(`gh` needs *a* subject path argument; with `--subject-digest` the file is not read.)

The repository's own CI runs the action against a scratch tree on every push
(`verify-action` job): it must pass on the applied tree, fail with one mismatch after a hand
edit, and upload an attestation on `main`.
