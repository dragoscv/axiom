# @codai/axiom-axm-lsp

## 2.3.0

### Patch Changes

- @codai/axiom-axm@2.3.0
  - @codai/axiom-schema@2.3.0

## 2.2.1

### Patch Changes

- @codai/axiom-axm@2.2.1
  - @codai/axiom-schema@2.2.1

## 2.2.0

### Minor Changes

- 50900d6: New predicate `expr.cedar` (S-411, D-25): Cedar policies over the same facts
  `expr.cel` sees.
  
  - **checks**: `expr.cedar { policies, mode?: "forbid" | "permit", message?,
    severity? }` runs one Cedar `isAuthorized` request per artifact — principal
    `Axiom::Plan::"<name>"`, action `Axiom::Action::"<op>"`, resource
    `Axiom::Artifact::"<path>"` (attrs `path`, `op`, `mode`, `ext`, `dir`, and
    when present `sha256`, `bytes`, `origin`, `text`, `exists`), parent
    `Axiom::Manifest::"<digest>"`, context `{ manifest, repo? }`. `mode: forbid`
    (default) appends a permit-all so every `deny` is a per-path finding;
    `mode: permit` is default-deny. Evaluated by `@cedar-policy/cedar-wasm`
    4.13 declared as an **optional** dependency and imported lazily; a host
    without it reports `ERR_PROVIDER_FAILED` (verdict `error`), never `pass`.
    Any Cedar evaluation error (missing attribute, type error, overflow) is a
    provider error — Cedar's "erroring policy does not apply" rule is not
    inherited. Templates, > 256 policies and parse errors →
    `ERR_PREDICATE_PARAMS`; 2 s wall-clock budget per manifest. 156-case
    hand-authored vector suite (`cedar-vectors.json`) + purity test.
  - **axm-lsp**: `expr.cedar` completion/hover; 17 built-ins in parity.
  - **mcp**: declares the same optional dependency so `npm i @codai/axiom-mcp`
    brings the WASM by default (`--no-optional` opts out; `expr.cedar` then
    fails closed).
  - Docs: `docs/checks.md` §expr.cedar including the OWASP Agent Control
    Standard mapping (AXIOM = Guardian on the write channel; `allow`/`deny`
    only) and why OPA/Rego was not chosen.
- b51eb33: `patch` artifact source (S-401, D-17): `{ type: "patch", format: "unified" |
  "v4a" | "search-replace", preImage: "sha256:…" | "absent", body }`. Compile
  reads the file under the root, requires it to hash to `preImage`
  (`ERR_PATCH_PREIMAGE`), applies the diff with **exact** matching only
  (`ERR_PATCH_NO_MATCH`; malformed body → `ERR_PATCH_FORMAT`) and
  content-addresses the result, so Manifest, checks and apply never see a patch.
  A patch plan and its inline twin share `planDigest` (golden fixtures
  `plan-patch` / `plan-patch-inline`); `origin: "patch"` is recorded on the
  artifact. Three parsers (unified diff, OpenAI/Codex V4A `apply_patch` text for
  one file incl. `@@ context` anchors and `*** End of File`, Aider
  SEARCH/REPLACE) feed one applier. `.axm` gains
  `patch <format> ("sha256:…"|absent) <<HEREDOC`; the LSP completes and documents
  it. `CompileOptions.readPreImage` lets callers (gate, tests) supply pre-images
  without a filesystem root.

### Patch Changes

- 7cb7db7: Predicate quality (S-408).
  
  - `content.noSecrets` `card`: a digit run is a PAN only when it passes Luhn, is
    not a single repeated digit and is not part of a UUID — zero/placeholder UUIDs
    (`00000000-0000-0000-0000-000000000000`), epoch-ms timestamps and sequential
    placeholders no longer fail the check; every real test PAN is still caught.
  - `repo.requireCompanion` gains `expect[].mustChange: true`: the companion must
    be in the plan, an existing repo file no longer satisfies the rule.
  - Every glob parameter auto-escapes Next.js route groups (`app/(app)/**`
    matches the literal directory); real extglobs and `\(app\)` are untouched.
  - `guard.external` attaches `facts.evidence = { exitCode, stdout, stderr }`
    (2 KiB tails) to every finding it produces, including `ERR_GUARD_OUTPUT` /
    `ERR_GUARD_TIMEOUT` (which previously used ad-hoc `exitCode`/`stdout`/`stderr`
    facts).
- 02527d8: Doc/code drift sweep (S-410): the `template` source is no longer described as
  "reserved for v2.1 / compile rejects" in the Plan JSON schema, the `.axm` LSP
  hover and the docs — it has been rendered by registered emitters since 2.1.0.
  `VerifyResult.signed` documents that structural verification never verifies
  signatures (use `axiom verify --root` or the `signature.*` predicates). v1-era
  docs (`ir_spec`, `plugin_api`, `reverse_ir_spec`, `MCP-ONLY-PUBLIC-SURFACE`)
  moved to `docs/archive/v1/`. New repo guard `check-stale-markers` fails on any
  forward-looking "planned for vX.Y" note whose version is already released.
- Updated dependencies [801d29e]
- Updated dependencies [b51eb33]
- Updated dependencies [c8de39b]
- Updated dependencies [38ff1c0]
- Updated dependencies [02527d8]
- Updated dependencies [28a39a0]
  - @codai/axiom-schema@2.2.0
  - @codai/axiom-axm@2.2.0

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
