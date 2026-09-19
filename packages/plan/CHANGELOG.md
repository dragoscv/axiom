# @codai/axiom-plan

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

### Patch Changes

- Updated dependencies [a483fe8]
- Updated dependencies [f70b6d2]
- Updated dependencies [40d88ee]
- Updated dependencies [40d88ee]
  - @codai/axiom-canon@2.1.0
  - @codai/axiom-schema@2.1.0

## 2.0.0

### Patch Changes

- Updated dependencies [f2e60b0]
  - @codai/axiom-schema@2.0.0
  - @codai/axiom-canon@2.0.0
