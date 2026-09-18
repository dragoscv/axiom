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
| `axiom_plan_validate` | read | Validate a `Plan` against the Zod schema; report `ERR_*` codes with JSON pointers | `{ plan }` | `{ ok, issues[] }` |
| `axiom_plan_compile` | read | Compile `Plan` → `ManifestBundle` (JCS manifest, sha256 per artifact, inline/CAS blobs) | `{ plan, blobTransport? }` | `{ manifestDigest, bundle }` |
| `axiom_manifest_verify` | read | Re-verify a bundle: canonical form, digest, every blob hash | `{ bundle }` | `{ ok, manifestDigest, issues[] }` |
| `axiom_check` | read | Run a `Profile` of predicates over a bundle against a root; fails closed on provider errors | `{ bundle, root, profile? }` | `CheckReport` |
| `axiom_apply_dry_run` | read | Containment + pre-image check + unified diff, no writes | `{ bundle, root }` | `{ manifestDigest, diff[], wouldWrite[] }` |
| `axiom_apply` | destructive | Two-phase commit: stage → journal → rename; requires `confirmDigest === manifestDigest`; single writer via `.axiom/lock` | `{ bundle, root, confirmDigest }` | `ApplyResult` |
| `axiom_rollback` | destructive | Restore the tree recorded in a journal entry, scoped to that entry's paths | `{ root, journalId }` | `{ restored[], journalId }` |
| `axiom_manifest_diff` | read | Structural diff between two manifests (added/removed/changed artifacts) | `{ before, after }` | `{ added[], removed[], changed[] }` |
| `axiom_roots_list` | read | List the allowlisted roots the server may touch | `{}` | `{ roots[] }` |

## Resources

`axiom://journal/<root-id>` (recent journal entries), `axiom://profile/<name>`
(built-in check profiles: `default`, `strict`, `permissive`).

## Error contract

Every failure is `{ code: ErrorCode, message, details? }` where `code` is a member of
`ERROR_CODES` in `packages/schema/src/errors.ts`. Clients and tests branch on `code`,
never on `message`.
