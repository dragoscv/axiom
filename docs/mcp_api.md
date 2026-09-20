# AXIOM MCP API (v2)

> The v1 HTTP demo API this file used to describe is archived at
> `docs/archive/v1/mcp_api-v1-http.md`. v1 is superseded (see `PLAN.md` §0).

`@codai/axiom-mcp` exposes the transactional write gate as an MCP **stdio** server by
default, or as a **Streamable HTTP** server with `--http` (see Transports). Every tool carries `annotations` and an
`outputSchema`; stdout is JSON-RPC only, logs go to stderr at `warn`. Roots are an
explicit allowlist (`--root <dir>`, repeatable) — there is no `cwd` fallback.

The registry of record is `packages/mcp/spec/tools.json`; `scripts/check-tool-parity.mjs`
fails CI when this table, `packages/mcp/README.md` and that file disagree.

## Tools

| Tool | Risk | Purpose | Input (summary) | Output (summary) |
|------|------|---------|-----------------|------------------|
| `axiom_plan_validate` | read | Validate a `Plan` against the Zod schema; report `ERR_*` codes with JSON pointers | `{ plan }` | `{ ok, planDigest?, errors[] }` |
| `axiom_plan_compile` | act | Compile `Plan` → `ManifestBundle` (JCS manifest, sha256 per artifact, inline/CAS blobs); writes only under `<root>/.axiom/` when a root is given. `ref` sources resolve from the root's CAS only — the tool has no network switch (`ERR_NET_DISABLED`; fetch with the CLI `compile --allow-net`) | `{ plan, store?, root? }` | `ManifestBundle { manifest, manifestDigest, attestation?, envelope?, blobs }` |
| `axiom_manifest_verify` | read | Re-verify a bundle: canonical form, digest, every blob hash; with `root`, also the detached DSSE signatures against `<root>/.axiom/trust/keys.json` ([signing.md](signing.md)) | `{ bundle, root? }` | `{ ok, manifestDigest?, canonical, signed, missing[], errors[], signatures?: { trustFile, keyids[], findings[], ok, code? } }` — `signatures` present only when the root has a trust store; `ok` is `false` when it fails and `code` is `ERR_SIGNATURE_MISSING` (no signature at all) or `ERR_SIGNATURE_INVALID` |
| `axiom_check` | read | Run a `Profile` of predicates over a bundle against a root; fails closed on provider errors; with a root, verifies `manifest.preImage` against the tree (`report.preImage: verified \| drifted \| unverified`, drift → `verdict: error`) | `{ bundle, profile?, root? }` | `CheckReport` |
| `axiom_apply_dry_run` | read | Containment + pre-image check + staging + unified diff, no user files touched | `{ bundle, root, profile? }` | `ApplyResult { mode: "dry-run", diff, files[] }` |
| `axiom_apply` | destructive | Two-phase commit: stage → journal → rename; requires `confirmDigest === manifestDigest`; single writer via `.axiom/lock` | `{ bundle, root, profile?, confirmDigest }` | `ApplyResult` |
| `axiom_rollback` | destructive | Reverse-replay the journal of an applied manifest, scoped to its recorded paths | `{ root, manifestDigest }` | `{ manifestDigest, status, phase, steps[], root }` |
| `axiom_manifest_diff` | read | Structural diff between two manifests (added/removed/changed artifacts) | `{ a, b }` (bundle or `sha256:` ref) | `{ added[], removed[], changed[] }` |
| `axiom_axm_parse` | read | Parse `.axm` v2 DSL text into a `Plan`; diagnostics carry 1-based `{line, column}` ranges and `ERR_*` codes; `plan` present only when error-free (parser loaded lazily) | `{ source }` | `{ plan?, diagnostics[] }` |
| `axiom_roots_list` | read | List the allowlisted roots the server may touch | `{}` | `{ roots[] }` |
| `axiom_repo_snapshot` | read | Deterministic, content-addressed inventory of a root ([snapshot.md](snapshot.md)): regular files and symlinks as `{ path, bytes, sha256?, mode, kind }` sorted by code point, `snapshotDigest = sha256(JCS(body))`; honours the root `.gitignore`, always skips `.git/` and `.axiom/`, never follows symlinks or leaves the root; globs containing `..` → `ERR_CONTAINMENT` | `{ root?, include?[], exclude?[], maxFiles?, maxBytes?, respectGitignore?, withContentDigest? }` | `RepoSnapshot { apiVersion, kind, root: { kind: "relative" }, snapshotDigest, body: { files[], truncated, counts: { files, bytes } } }` — text summary is `{ snapshotDigest, counts, truncated, paths[≤20] }` |

Risk classes are derived from the MCP annotations (`readOnlyHint` → READ, `destructiveHint` →
SENSITIVE, otherwise ACT). `packages/mcp/spec/codai-tools.json` re-emits the same registry in the
entry shape of codai's `packages/agent-core/spec/tools-v2.json` so codai agents can gate these
tools under their `APPROVAL_MATRIX` — see `docs/integration/codai.md`.

CLI-only verbs (no MCP tool): `axiom migrate v1 <manifest.json>` lifts an AXIOM 1.0.x manifest
into a v2 `Plan` ([migrate.md](migrate.md)) — a one-off maintenance step that belongs to the
operator, not to an agent's tool surface. Its code is a lazy chunk (`dist/migrate-lazy.js`).

**Deliberately not tools.** `axiom gc` (CAS garbage collection, [cas.md](cas.md)) and network
fetching of `ref` sources (`compile --allow-net`, [plan-format.md](plan-format.md#ref-sources)) are
CLI-only: both are operator decisions (disk reclamation, egress), so an agent cannot trigger them
through the server.

## Resources

`axiom://journal/<root-id>` (recent journal entries), `axiom://profile/<name>`
(built-in check profiles: `default`, `strict`, `permissive`), `axiom://emitters` (static list of
`{emitter, version, template, description}` rows for the template emitters compiled into this
server — currently `web@2.0.0`; see [emitters.md](emitters.md)).

## Transports

| Transport | Start | Notes |
|-----------|-------|-------|
| stdio (default) | `axiom mcp --root <dir> [--wire 2026\|2025\|2026-only]` | JSON-RPC on stdout, JSON-line logs on stderr. |
| Streamable HTTP | `axiom mcp --root <dir> --http <host:port> [--http-token-env NAME] [--wire …]` | `POST/GET/DELETE /mcp`, `GET /health`; `--http 0` = random loopback port, URL in the `http listening` stderr log line (`--log-level info`). |

### Protocol revisions (`--wire`, D-19)

Since 2.2.0 the server is built on MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`
2.0.0) and speaks two *eras* from one entry point:

| Era | Revisions | Handshake | How AXIOM serves it |
|-----|-----------|-----------|---------------------|
| modern | `2026-07-28` | none — every request carries a `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `clientInfo`); `server/discover` advertises the server; no `Mcp-Session-Id` | **default**. stdio: `serveStdio` pins the connection on its opening exchange. HTTP: `createMcpHandler` builds one server instance per request; `tools/list`, `resources/*`, `server/discover` results carry `ttlMs`/`cacheScope` (SEP-2549) from AXIOM's static cache hints (`tools/list` 5 min public, `resources/read` 24 h public — digests are immutable, `resources/list` 10 s private). |
| legacy | `2024-10-07` … `2025-11-25` | `initialize` request; HTTP sessions via `Mcp-Session-Id` | served from the **same** factory (`--wire 2026`, the default, and `--wire 2025`): the SDK pins a stdio connection to the legacy era when it opens with `initialize`; over HTTP, `isLegacyRequest` routes claim-less traffic to the sessionful transport described below. `--wire 2026-only` refuses these openings with the SDK's unsupported-protocol-version error. |

A client on SDK v2 chooses its era with `versionNegotiation` (`{ mode: 'auto' }` probes and
lands on modern; the default is the 2025 handshake). Clients still on SDK v1 keep working
unchanged — they only ever send `initialize`. The SDK is reached through one seam,
`packages/mcp/src/adapter.ts` (guard `check-sdk-adapter`), and lives in the lazy chunks
`dist/mcp-lazy.js` / `dist/http-lazy.js`, so `compile`/`verify`/`gate`/`apply` never load it.

HTTP rules (v2-architecture §5.4): bind is loopback (`127.0.0.1`) unless a host is given; a
**non-loopback host requires a bearer token** from the env var named by `--http-token-env`
(default `AXIOM_HTTP_TOKEN`) or the server refuses to start (`ERR_INTERNAL`, exit 2). Clients send
`Authorization: Bearer <token>` (constant-time compare; `401` + `WWW-Authenticate` otherwise).
Legacy (2025-era) traffic: one `WebStandardStreamableHTTPServerTransport` + one server instance
per session (`Mcp-Session-Id`, UUID); a non-`initialize` request without the header is `400`, an
unknown/expired id is `404`; idle sessions are evicted after 30 min. Modern (2026-07-28) traffic
has no sessions. DNS-rebinding protection (Host allowlist) is on for loopback
binds; bodies over 4 MiB are `413`. The transport is a lazy chunk (`dist/http-lazy.js`) built on
`node:http` only — the stdio path and the bundle-size budget are unaffected.

Conformance: `packages/conformance` starts `axiom mcp --http 127.0.0.1:0` and runs
`@modelcontextprotocol/conformance server --url … --expected-failures baseline.yml` in CI
(ubuntu). The baseline lists the scenarios AXIOM fails by design (prompts, logging, subscribe,
sampling, elicitation, progress, non-text content, `test://`/`test_*` fixtures); the run fails on
any unexpected failure and on any stale baseline entry. Conformance 0.1.16 scores the 2025 eras
only (`--spec-version` ≤ `2025-11-25`), so it exercises the legacy leg; the 2026-07-28 leg is
covered by the SDK-v2 client tests in `packages/mcp/src/http.test.ts` / `cli.test.ts` (pinned
`2026-07-28`, `auto`, and `--wire 2026-only` rejection).

## Error contract

Every failure is `{ code: ErrorCode, message, details? }` where `code` is a member of
`ERROR_CODES` in `packages/schema/src/errors.ts`. Clients and tests branch on `code`,
never on `message`.
