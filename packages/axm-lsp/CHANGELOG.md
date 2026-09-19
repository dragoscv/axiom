# @codai/axiom-axm-lsp

## 2.1.0

### Minor Changes

- 251471c: New package `@codai/axiom-axm-lsp` (bin `axiom-axm-lsp --stdio|--node-ipc`): a language server
  for `.axm` that reuses the `@codai/axiom-axm` Chevrotain parser (one grammar, zero drift — PLAN.md
  D-14). Diagnostics with 0-based LSP ranges and closed `ERR_*` codes, context-aware completion
  (predicate ids after `using`, capabilities, `mode`/`op`/`profile` values, keyword snippets by
  nesting depth), keyword/predicate hover, document symbols, `formatAxm`-based formatting (only on a
  clean parse) and semantic tokens. Pure feature functions are exported for embedding. A private VS
  Code extension `packages/vscode-axm` (`axiom-axm`) wires the client + TextMate grammar and packages
  to a self-contained .vsix.

### Patch Changes

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
- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-schema@2.1.0
  - @codai/axiom-axm@2.1.0
