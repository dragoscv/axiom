# Security Policy

## Supported versions

| Version | Status |
|---------|--------|
| 2.x | Supported; security fixes released as patch versions of the fixed group |
| 1.0.x | Deprecated, no fixes. Known issues: manifest hash not content-bound, `git` spawned with `shell: true` and user strings, no rollback. Upgrade — see `MIGRATION.md` |

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting on
<https://github.com/dragoscv/axiom/security/advisories/new>. Include the
package and version, a minimal `Plan`/bundle or command sequence that
reproduces the problem, and the observed vs expected behaviour.

Target response times: acknowledgement within 72 hours; a fix or mitigation for
containment, TOCTOU or integrity bypasses within 7 days; other issues in the
next release. Coordinated disclosure after a fixed version is on npm; credit in
`CHANGELOG.md` unless you prefer otherwise.

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

Out of scope: a malicious user of the machine, a compromised Node runtime or
npm supply chain, malicious code *inside* the files being written (AXIOM writes
bytes; it does not execute or evaluate them), and any client-side trust in MCP
`roots/list`.

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
- **No shell.** Child processes (none in the v2.0 hot path) are spawned with an
  argument array; `shell: true`, `exec`, `execSync` are banned by a repo guard.
- **Fail-closed checks.** A predicate that cannot evaluate yields
  `verdict: error`, which blocks apply.
- **Quiet transport.** MCP stdout carries only JSON-RPC; logs go to stderr and
  never include blob content.

## What `apply` does not guarantee

- Protection against a writer that ignores `.axiom/lock`; the pre-image check
  reduces but cannot eliminate the race on POSIX/NTFS.
- Authenticity of a bundle. DSSE signing and `manifest.requireSigned`
  enforcement are v2.2; in v2.0 any well-formed bundle is accepted if its
  digests are internally consistent.
- Secrecy of content: staging, backups and the CAS under `.axiom/` are plain
  files with the user's default permissions. Add `.axiom/` to `.gitignore`.
- Durability on Windows across power loss in the window after a rename
  (directory fsync is a no-op there).
- Anything about what the written files *do* when executed.
- `content.noSecrets` is a regex scan with a fixed pattern set; it reduces
  accidental leaks and is not a DLP system.

## Hardening in the repository

Enforced on every CI run by `scripts/run-guards.mjs`: package boundary graph,
closed error-code enum, no stdout outside the CLI entry, no shell spawn, no v1
imports, pinned GitHub Action SHAs, golden digest cross-OS comparison, bundle
size and cold-start budgets. Mutation testing (Stryker) runs weekly on `canon`,
`apply/contain` and `checks/predicates`. Releases use npm trusted publishing
with provenance.

## Roadmap items with security impact

- v2.1: `guard.external` (spawn with allowlist, timeout, JSON contract), git PR
  mode (args array, `-F -` message, branch-name validation), `axiom gate --stdin`
  hook, HTTP transport bound to loopback with bearer token.
- v2.2: DSSE signing, key pinning, anti-rollback, `ref` sources behind
  `--allow-net`.
