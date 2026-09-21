# Security Policy

[Docs site](https://dragoscv.github.io/axiom/) · [README](README.md) · [Support](SUPPORT.md) · [Signing](docs/guides/signing.md) · [Apply guarantees](docs/guides/apply.md)

## Supported versions

| Version | Status |
|---------|--------|
| 2.2.x | Current — features, fixes and security patches, released as patch versions of the fixed group (all nine `@codai/axiom-*` share one version) |
| 2.0.x – 2.1.x | Security fixes only; upgrade to 2.2.x (no breaking change) |
| 1.0.x | Deprecated on npm, no fixes. Known issues: manifest hash not content-bound, `git` spawned with `shell: true` and user strings, no rollback. Upgrade — see [MIGRATION.md](MIGRATION.md) |

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting on
<https://github.com/dragoscv/axiom/security/advisories/new>. Include the
package and version, a minimal `Plan`/bundle or command sequence that
reproduces the problem, and the observed vs expected behaviour.

Target response times: acknowledgement within 72 hours; a fix or mitigation for
containment, TOCTOU or integrity bypasses within 7 days; other issues in the
next release. Coordinated disclosure after a fixed version is on npm; credit in
the release notes unless you prefer otherwise.

## Threat model

AXIOM is a write gate that runs **on the developer's machine with the
developer's privileges**, driven by a coding agent whose output is untrusted.
The assets it protects are the files under the allowlisted roots and the
integrity of the record of what was written.

Adversaries considered:

- **A compromised or confused agent** producing a `Plan`/bundle designed to
  write outside the root, overwrite protected files, smuggle secrets, or apply
  something other than what was reviewed.
- **A concurrent writer** (another agent, an editor, a watcher) modifying the
  tree between check and commit.
- **A tampered bundle** whose content does not match its manifest.
- **A replayed or unsigned bundle** presented to a root whose profile requires
  signatures (`manifest.requireSigned`, anti-rollback counter).

Out of scope: a malicious user of the machine, a compromised Node runtime or
npm supply chain (mitigated, not eliminated, by the provenance checks below),
malicious code *inside* the files being written (AXIOM writes bytes; it does
not execute or evaluate them), and any client-side trust in MCP `roots/list`.

## What `apply` guarantees

- **Containment.** No write outside the realpath'd root: schema path rules,
  reserved-name rejection on every OS, case-collision detection, `lstat` walk
  rejecting symlinks/junctions in the ancestry, realpath comparison of the
  target directory, target-type check. Property-tested with fast-check.
- **Integrity.** Every blob is re-hashed on resolution and after write; the
  manifest digest is recomputed from the JCS body; `confirmDigest` must equal
  it. A bundle whose bytes do not match its manifest is rejected before any write.
- **Atomicity from the tree's perspective.** Staging under `.axiom/`, journal
  fsynced before phase 2, rename per file, reverse-order rollback on any error,
  crash recovery at next apply.
- **TOCTOU narrowing.** Each target's pre-image is re-hashed immediately before
  its rename; a change since staging aborts and rolls back
  (`ERR_PREIMAGE_CHANGED`).
- **Single writer per root** via `.axiom/lock`.
- **Roots are an explicit allowlist** (`--root`); there is no `cwd`, env-var or
  client-supplied fallback. Requested roots are realpath'd and must lie inside
  an allowlisted one.
- **No shell.** The only child processes are `git` (PR mode) and allowlisted
  `guard.external` commands, spawned with an argument array and a scrubbed
  environment; `shell: true`, `exec`, `execSync` are banned by a repo guard.
- **Fail-closed checks.** A predicate that cannot evaluate yields
  `verdict: error`, which blocks apply. The `axiom gate --stdin` hook is
  fail-closed too: a malformed payload or internal error is a deny (`--fail-open` opts out).
- **Authenticity when required.** A root can pin Ed25519 public keys in
  `.axiom/trust/keys.json`; `manifest.requireSigned` then rejects unsigned,
  tampered or untrusted bundles, and `antiRollback` rejects any counter that
  does not advance. Envelopes can be root-bound to close cross-root replay.
  Details and limitations: [docs/guides/signing.md](docs/guides/signing.md).
- **Verifiable afterwards.** `axiom verify --tree` proves a tree matches a
  manifest and can emit an in-toto attestation uploaded from CI
  ([docs/guides/verify-tree.md](docs/guides/verify-tree.md)).
- **Quiet transport.** MCP stdout carries only JSON-RPC; logs go to stderr and
  never include blob content.

## What `apply` does not guarantee

- Protection against a writer that ignores `.axiom/lock`; the pre-image check
  reduces but cannot eliminate the race on POSIX/NTFS.
- Authenticity of a bundle **unless the profile asks for it**. Without
  `manifest.requireSigned`, any well-formed bundle whose digests are internally
  consistent is accepted.
- Secrecy of content: staging, backups and the CAS under `.axiom/` are plain
  files with the user's default permissions. Add `.axiom/` to `.gitignore`.
- Durability on Windows across power loss in the window after a rename
  (directory fsync is a no-op there).
- Anything about what the written files *do* when executed.
- `content.noSecrets` is a regex scan with a fixed pattern set; it reduces
  accidental leaks and is not a DLP system.
- The shell-command scan in `axiom gate` is a heuristic, and a harness that
  times a hook out fails open by its own design — which is why `npx` is banned
  in hook wiring ([docs/getting-started/hooks.md](docs/getting-started/hooks.md)).

## Verifying what you download

Every release artefact is produced by [`release.yml`](.github/workflows/release.yml)
from a tag, with provenance you can check yourself:

| Artefact | How to verify |
|---|---|
| npm packages (`@codai/axiom-*`) | Published with npm trusted publishing (OIDC). `npm view @codai/axiom-mcp dist.attestations` lists the provenance and publish attestations; `npm audit signatures` checks them for an installed tree. |
| Standalone binaries (`axiom-linux-x64`, `axiom-linux-arm64`, `axiom-darwin-arm64`, `axiom-darwin-x64`, `axiom-win-x64.exe`) | `sha256sum -c SHA256SUMS` against the file from the same release, then `gh attestation verify axiom-linux-x64 --owner dragoscv` (Sigstore build provenance from `actions/attest-build-provenance`). The `install.sh` / `install.ps1` scripts on the docs site perform the checksum step for you. |
| VS Code extension (`axiom-axm-<version>.vsix`) | Attached to the same GitHub release by the same tag-triggered workflow. It is **not** in `SHA256SUMS` and carries no Sigstore attestation; GitHub shows a sha256 digest for every release asset — compare it after download, and prefer the Marketplace listing once `codai.axiom-axm` is published. |
| GitHub Action (`dragoscv/axiom/action`) | Pin by commit SHA (`uses: dragoscv/axiom/action@<sha> # v2`) rather than the moving `v2` tag when you need immutability; the action itself pins `actions/attest` by SHA and installs `@codai/axiom-mcp` from npm. |
| MCP Registry (`io.github.dragoscv/axiom`) | The registry entry only points at the npm package; the package's own provenance is the trust anchor. |

Provenance proves *which workflow at which commit* built the bytes; review the
workflow and the commit, not just the green check.

## Hardening in the repository

Enforced on every CI run by `scripts/run-guards.mjs` (18 guards): package
boundary graph, closed error-code enum, no stdout outside the CLI entry, no
shell spawn, no v1 imports, one MCP SDK seam, pinned GitHub Action SHAs, golden
digest cross-OS comparison, bundle size, cold-start and gate-latency budgets,
stale-marker and changeset presence, release completeness against the registry.
Dependabot keeps npm and Actions current; OpenSSF Scorecard runs weekly.
Mutation testing (Stryker) is configured but informational until its Vitest 5
runner lands upstream.

## Shipped security features by release

- **2.1** — `guard.external` (allowlisted spawn, timeout, JSON contract), git PR
  mode (args array, `-F -` message, branch-name validation), `axiom gate --stdin`
  hook, HTTP transport bound to loopback with a bearer token off-loopback, DSSE
  Ed25519 signing with key pinning and anti-rollback, `ref` sources behind
  `--allow-net`.
- **2.2** — fail-closed gate with shell-write scan, pre-image binding re-verified
  at apply, root-bound signatures and authenticated trust state,
  `verify --tree` + in-toto attestation + GitHub Action, `expr.cedar` policies.
- **2.2.1** — Sigstore provenance on standalone binaries and `SHA256SUMS`,
  MCP Registry listing, Scorecard and Dependabot.

Nothing security-relevant is currently deferred to a future release; open items
are tracked in [PLAN.md](PLAN.md).
