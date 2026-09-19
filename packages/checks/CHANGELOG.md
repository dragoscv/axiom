# @codai/axiom-checks

## 2.1.0

### Minor Changes

- 5d1d33f: New predicate `expr.cel` (PLAN.md S-301 / D-15): a boolean CEL expression over `manifest`,
  `artifacts`, `content` (path → `{bytes, sha256, text?}`) and `repo` (`exists` map, only with an
  authorised root — referencing it without one is an `error`, never a pass). Evaluated with
  `@marcbachmann/cel-js` 8 behind a lazy `import()` so the MCP eager bundle grows by 8 KB only
  (872.4 → 880.2 KB). The determinism bar is enforced in the predicate: closed function allowlist
  (no `timestamp`/`duration`/`now`/`base64`/`json`/`bind`), literal RE2-safe `matches()` (no
  lookaround/backrefs), expression ≤ 4096 chars, AST depth ≤ 24 / ≤ 2000 nodes, 100 ms evaluation
  budget, closed variable set. Parse/type/runtime errors and non-bool results are provider-style
  `error` findings; `false` yields exactly one finding with the optional `message`. Ships with a
  345-case vector suite, a purity test and fast-check properties. `builtinRegistry().list()` now has
  16 ids; the `.axm` LSP completion list gained `expr.cel`.
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

### Patch Changes

- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-canon@2.1.0
  - @codai/axiom-schema@2.1.0

## 2.0.0

### Minor Changes

- fc679b9: `guard.external` is now a real predicate (S-202, v2-architecture §3.2). It spawns a repository-owned
  guard — a relative `command` that must realpath inside `<root>/scripts/` (`.mjs/.js/.cjs` via the
  current `node`, `.ps1` via `pwsh -NoProfile -ExecutionPolicy Bypass -File`) or an absolute executable
  that exactly matches an entry of the new `guardAllowlist` — with an args array (never a shell),
  `windowsHide`, a scrubbed whitelist environment plus `params.env`, `AXIOM_MANIFEST_DIGEST` and
  `AXIOM_ROOT`, the JCS bundle/manifest on stdin, and a wall-clock timeout that kills the process tree
  (`ERR_GUARD_TIMEOUT`). stdout must be a `GuardOutput` JSON object `{ ok, findings? }`; non-JSON stdout
  on any exit code fails closed with `ERR_GUARD_OUTPUT` (stderr tail 4 KiB in facts). brivio-style
  `OK`/`FAIL` text is accepted only with `legacyText: true`. Guards run only when the profile sets
  `facts.allowGuards` **and** `runChecks` receives `allowGuards: true`; otherwise a single `error`
  finding ("external guards disabled"). `runChecks` executes guard checks in a pool of
  `min(4, os.cpus().length)` and reports the `guard` provider as `ok|skipped|error`.
  
  `@codai/axiom-mcp`: `axiom mcp|check|apply` accept `--allow-guards` and repeatable
  `--guard-allowlist <abs>`, threaded into every `runChecks` call (`createServer(policy, { guards })`).
  Docs: `docs/checks.md` (contract table), `docs/integration/brivio.md` (adapter for `run-guards.mjs`).

### Patch Changes

- Updated dependencies [f2e60b0]
  - @codai/axiom-schema@2.0.0
  - @codai/axiom-canon@2.0.0
