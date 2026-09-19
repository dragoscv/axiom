# @codai/axiom-schema

## 2.1.0

### Minor Changes

- a483fe8: DSSE signing, key pinning and anti-rollback (PLAN.md S-302 / D-16) — see `docs/signing.md`.
  
  - **canon**: `signEnvelope(body, privateKey)`, `verifyEnvelope(env, trustedKeys)` →
    `{ ok, keyids, payload?, reason? }` with closed reasons `BAD_PAYLOAD_TYPE | NO_SIGNATURES |
    BAD_PAYLOAD | NOT_CANONICAL | UNKNOWN_KEY | BAD_SIGNATURE`; `keyidFor` (= hex sha256 of the raw
    32-byte public key), `generateKeyPair`, `privateKeyFrom` (base64 PKCS#8, raw seed or PEM),
    `publicKeyFrom`. Ed25519 via `node:crypto`, no dependency. Envelope payloadType
    `application/vnd.axiom.manifest+json`, payload `base64(JCS(body))`, DSSE PAE.
  - **schema**: `ManifestBundle.signatures?: ManifestSignature[]` (outside the canonical body —
    `manifestDigest` unchanged), `ManifestBody.counter?` and `Plan.counter?` (int ≥ 0, inside the
    hash), `TrustedKey`/`TrustStore` (`.axiom/trust/keys.json`) and `TrustState`
    (`.axiom/trust/state.json`) schemas. New closed error codes `ERR_SIGNATURE_MISSING`,
    `ERR_SIGNATURE_INVALID`, `ERR_ROLLBACK`. JSON schemas regenerated.
  - **plan**: `Plan.counter` is copied verbatim into `ManifestBody.counter`.
  - **checks**: `manifest.requireSigned` now verifies:
    `{ minSignatures?: 1, antiRollback?: false, trustFile?: ".axiom/trust/keys.json" }`. Findings
    `signature.missing | unknownKey | bad | notCanonical | rollback`; trust file missing/unreadable
    or no root → `verdict: error` (fail closed). Registry stays at 16 ids (the v2.0 presence-only
    stub is replaced).
  - **mcp**: CLI verbs `axiom keygen [--out <dir>] [--name]` (private key → file mode 0600, public
    entry → stdout), `axiom sign <bundle> [--key-file|$AXIOM_SIGNING_KEY] [-o]`,
    `axiom verify <bundle> --root <dir>` (also checks signatures), `axiom trust add|remove|list
    --root`. `axiom_manifest_verify` accepts `root` and reports `signatures: { trustFile, keyids,
    findings, ok }`. `axiom apply` / `axiom_apply` advance `lastCounter` only when the effective
    checks include `manifest.requireSigned { antiRollback: true }` and the result is `applied`.
  - Documented non-goal: cross-root replay is **not** prevented (root is deliberately not bound
    into the payload).
- f70b6d2: Template sources (S-207, D-13). `compilePlan(plan, { emitters })` now renders
  `{ type: "template", emitter, template, params }` sources through an injected
  `EmitterRegistry` (`createEmitterRegistry`, `TemplateEmitter`, `TemplateDef` exported from
  `@codai/axiom-plan`; `plan` gains no dependency). Rendered bytes follow the inline path; the
  manifest records `origin: "template"` and `toolchain.emitters[<id>] = <version>` so an emitter
  bump changes `manifestDigest`, while `params` are hashed into `planDigest`. New closed error codes
  `ERR_EMITTER_UNKNOWN`, `ERR_TEMPLATE_UNKNOWN`, `ERR_TEMPLATE_PARAMS` (template sources no longer
  raise `ERR_UNSUPPORTED_OP`).
  
  New package `@codai/axiom-emitters-web`: emitter `web@2.0.0` with seven small deterministic
  golden-stack templates — `next.route-handler`, `next.server-action`, `hono.route`,
  `drizzle.table`, `biome.config`, `tailwind.globals`, `readme.section` — each with strict Zod
  params, a committed golden file and a pinned cross-OS manifest digest. Not an app generator.
  
  `@codai/axiom-mcp` registers `web` in `axiom_plan_compile` / `axiom_plan_validate` and
  `axiom compile`, adds the `axiom emitters [--json]` verb and the static `axiom://emitters`
  resource. No tool input schema changed.
- 40d88ee: `ref` sources are resolved (PLAN.md S-303). `resolveRef(source, { root, allowNet, allowlist?,
  allowFile?, maxBytes?, timeoutMs?, fetchImpl? })` returns the bytes from `<root>/.axiom/cas` when
  the pinned digest is already there — no network, no policy — and otherwise fails closed with
  `ERR_NET_DISABLED` unless `allowNet`. With it: `https:` only (`file:` behind `allowFile`), no
  credentials in the URI, optional host allowlist with `*.example.com` wildcards
  (`ERR_NET_DENIED`), `redirect: "error"`, AbortController timeout, streamed download with a running
  sha256 and a hard byte cap (`ERR_BLOB_TOO_LARGE`), digest mismatch → `ERR_DIGEST_MISMATCH` and
  nothing stored, match → fsync + atomic rename into the CAS. Error details carry the URI redacted
  to origin + path. `compilePlan` gains `net?: RefNetOptions` (default offline); the manifest keeps
  `origin: "ref"` and ref bytes are never inlined into `blobs`. `apply` is unchanged: CAS or
  `ERR_REF_OFFLINE`.
  
  CLI: `axiom compile … --allow-net [--net-allow host[,host]] [--allow-file]`, and a new
  `axiom gc --root <dir> [--dry-run] [--older-than <n>(ms|s|m|h|d)] [--keep all-manifests|journal]`
  that removes CAS blobs no stored manifest references (plus stale `*.tmp`), under `.axiom/lock`
  (live holder → `ERR_LOCKED`), idempotent, reporting
  `{ scanned, live, missing, removed: [{sha, bytes}], skippedYoung, freedBytes }`. Neither is an MCP
  tool by design. New closed codes: `ERR_NET_DISABLED`, `ERR_NET_DENIED`, `ERR_NET_FAILED`. Docs:
  `docs/cas.md`, `docs/plan-format.md` § Ref sources.
- 40d88ee: `axiom_repo_snapshot` — deterministic, content-addressed inventory of a root (PLAN.md S-304) —
  see `docs/snapshot.md`. Successor of the v1 `reverse-ir`.
  
  - **schema**: `RepoSnapshotSchema` (`{ apiVersion, kind: "RepoSnapshot", root: { kind: "relative" },
    snapshotDigest, body: { files: [{ path, bytes, sha256?, mode, kind: "file"|"symlink" }],
    truncated, counts: { files, bytes } } }`), `RepoSnapshotBodySchema`, `RepoSnapshotEntrySchema`.
    `schemas/RepoSnapshot.schema.json` emitted.
  - **mcp**: READ tool `axiom_repo_snapshot { root?, include?, exclude?, maxFiles? (20000, cap 50000),
    maxBytes? (64 MiB), respectGitignore?, withContentDigest? }` → `RepoSnapshot` with
    `snapshotDigest = sha256(JCS(body))`; no timestamps or absolute paths, files sorted by
    `compareUtf8`, `.git/` and `.axiom/` always skipped, root `.gitignore` honoured, symlinks recorded
    but never followed (target hashed only when inside the root), globs containing `..` →
    `ERR_CONTAINMENT`. Truncated results are a deterministic sorted prefix. CLI verbs
    `axiom snapshot --root <dir> [-o] [--include] [--exclude] [--max-files] [--max-bytes] [--no-gitignore]
    [--no-digest]` and `axiom snapshot-diff <a.json> <b.json>` (pure `diffSnapshots` →
    `{ added, removed, changed }`). `axiom schema RepoSnapshot` and `axiom://schema/RepoSnapshot`.
    The server now exposes 11 tools.

## 2.0.0

### Minor Changes

- f2e60b0: Git PR mode (S-201, design §4.3). `apply({ mode: "pr", branch?, commitMessage? })`
  creates a branch (default `axiom/<name>/<digest12>`, deterministic), runs the
  ordinary two-phase fs apply, stages exactly the touched paths with
  `git add -- <paths>` and commits with the message on stdin (`-F -`). Every git
  call is `spawn("git", args, { shell: false })` with a scrubbed env
  (`GIT_DIR`/`GIT_WORK_TREE` dropped, `GIT_TERMINAL_PROMPT=0`); branch names are
  checked by regex and `git check-ref-format --branch`. Result carries
  `git: { branch, commit, compareUrl? }` (GitHub/GitLab compare URL from `origin`).
  No push, no PR creation, hooks honoured. New closed error codes:
  `ERR_GIT_NOT_FOUND`, `ERR_GIT_NOT_REPO`, `ERR_GIT_DIRTY`, `ERR_GIT_BRANCH_EXISTS`,
  `ERR_GIT_BRANCH_INVALID`, `ERR_GIT_FAILED`. MCP `axiom_apply` accepts
  `mode: "fs" | "pr"`, `branch`, `commitMessage`.
