---
"@codai/axiom-plan": minor
"@codai/axiom-mcp": minor
"@codai/axiom-schema": minor
---

`ref` sources are resolved (PLAN.md S-303). `resolveRef(source, { root, allowNet, allowlist?,
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
