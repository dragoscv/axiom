# AXIOM MCP API (v2)

> The v1 HTTP demo API this file used to describe is archived at
> `docs/archive/v1/mcp_api-v1-http.md`. v1 is superseded (see `PLAN.md` §0).

`@codai/axiom-mcp` exposes the transactional write gate as an MCP **stdio** server
(streamable HTTP arrives in v2.1). Every tool carries `annotations` and an
`outputSchema`; stdout is JSON-RPC only, logs go to stderr at `warn`. Roots are an
explicit allowlist (`--root <dir>`, repeatable) — there is no `cwd` fallback.

The registry of record is `packages/mcp/spec/tools.json`; `scripts/check-tool-parity.mjs`
fails CI when this table, `packages/mcp/README.md` and that file disagree.

## Tools

| Tool | Risk | Purpose | Input (summary) | Output (summary) |
|------|------|---------|-----------------|------------------|
| `axiom_plan_validate` | read | Validate a `Plan` against the Zod schema; report `ERR_*` codes with JSON pointers | `{ plan }` | `{ ok, planDigest?, errors[] }` |
| `axiom_plan_compile` | act | Compile `Plan` → `ManifestBundle` (JCS manifest, sha256 per artifact, inline/CAS blobs); writes only under `<root>/.axiom/` when a root is given | `{ plan, store?, root? }` | `ManifestBundle { manifest, manifestDigest, attestation?, envelope?, blobs }` |
| `axiom_manifest_verify` | read | Re-verify a bundle: canonical form, digest, every blob hash | `{ bundle }` | `{ ok, manifestDigest?, canonical, signed, missing[], errors[] }` |
| `axiom_check` | read | Run a `Profile` of predicates over a bundle against a root; fails closed on provider errors | `{ bundle, profile?, root? }` | `CheckReport` |
| `axiom_apply_dry_run` | read | Containment + pre-image check + staging + unified diff, no user files touched | `{ bundle, root, profile? }` | `ApplyResult { mode: "dry-run", diff, files[] }` |
| `axiom_apply` | destructive | Two-phase commit: stage → journal → rename; requires `confirmDigest === manifestDigest`; single writer via `.axiom/lock` | `{ bundle, root, profile?, confirmDigest }` | `ApplyResult` |
| `axiom_rollback` | destructive | Reverse-replay the journal of an applied manifest, scoped to its recorded paths | `{ root, manifestDigest }` | `{ manifestDigest, status, phase, steps[], root }` |
| `axiom_manifest_diff` | read | Structural diff between two manifests (added/removed/changed artifacts) | `{ a, b }` (bundle or `sha256:` ref) | `{ added[], removed[], changed[] }` |
| `axiom_roots_list` | read | List the allowlisted roots the server may touch | `{}` | `{ roots[] }` |

Risk classes are derived from the MCP annotations (`readOnlyHint` → READ, `destructiveHint` →
SENSITIVE, otherwise ACT). `packages/mcp/spec/codai-tools.json` re-emits the same registry in the
entry shape of codai's `packages/agent-core/spec/tools-v2.json` so codai agents can gate these
tools under their `APPROVAL_MATRIX` — see `docs/integration/codai.md`.

## Resources

`axiom://journal/<root-id>` (recent journal entries), `axiom://profile/<name>`
(built-in check profiles: `default`, `strict`, `permissive`).

## Error contract

Every failure is `{ code: ErrorCode, message, details? }` where `code` is a member of
`ERROR_CODES` in `packages/schema/src/errors.ts`. Clients and tests branch on `code`,
never on `message`.
