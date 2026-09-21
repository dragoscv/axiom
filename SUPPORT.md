# Support

[Docs site](https://dragoscv.github.io/axiom/) · [README](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

AXIOM is a small open-source project maintained by one person plus contributors. Support is
community-driven and best-effort; there is no commercial support, SLA or paid tier.

## Where to ask

| I want to… | Go to |
|---|---|
| Ask a question, share a setup, discuss a design | [GitHub Discussions](https://github.com/dragoscv/axiom/discussions) |
| Report a bug | [Bug report form](https://github.com/dragoscv/axiom/issues/new?template=bug_report.yml) |
| Propose a feature or a new predicate/tool | [Feature request form](https://github.com/dragoscv/axiom/issues/new?template=feature_request.yml) |
| Report a security problem | **Privately** — [SECURITY.md](SECURITY.md) (GitHub advisories, never a public issue) |
| Read how something works | [Docs site](https://dragoscv.github.io/axiom/) — the same content as `docs/` in this repo |

Before opening an issue, check `axiom --version`, the [MCP API](docs/reference/mcp-tools.md) and
[Checks](docs/guides/checks.md) reference, and the closed error-code list in
`packages/schema/src/errors.ts` — most "unexpected" results are a documented `ERR_*` code.

## Filing a good bug

The issue form asks for these; the fastest fixes come from reports that include them:

- `axiom --version`, Node version (`node --version`), OS, and how you installed it
  (`npx`, global bin, standalone binary, `.vsix`, GitHub Action).
- The **error code** (`ERR_*`) and the JSON returned — not a paraphrase.
- A minimal `Plan` (or `.axm` file) and the exact CLI verb / MCP tool call that reproduces it.
  Redact content; AXIOM only needs the shape and the paths.
- For `apply` problems: the `.axiom/journal/` entry for the manifest digest — see the
  [apply guide](docs/guides/apply.md) for the layout.

## Supported versions

| Series | Status | What you get |
|---|---|---|
| **2.2.x** | Current | Features, fixes and security patches, released as patch versions of the fixed group |
| 2.0.x – 2.1.x | Supported for security fixes | Upgrade to 2.2.x for everything else; no breaking change between them |
| 1.0.x | **Deprecated** on npm, no fixes | See [MIGRATION.md](MIGRATION.md) and `axiom migrate v1` |

All nine `@codai/axiom-*` packages share one version; mixing versions is unsupported.
Compatibility rules (what counts as breaking, JSON Schema `$id`s, Node floor ≥ 22.14):
[docs/reference/versioning.md](docs/reference/versioning.md).

## Response expectations

- Discussions and issues: usually within a few days; no guarantee.
- Security reports: acknowledgement within 72 hours, fix or mitigation for containment,
  TOCTOU or integrity bypasses within 7 days ([SECURITY.md](SECURITY.md)).
- Pull requests: reviewed in order; the [contributing guide](CONTRIBUTING.md) lists the checks
  a PR must pass, which is the fastest way to get one merged.

## Integrations

Reference wirings exist for Copilot CLI / VS Code and Claude Code hooks
([docs/getting-started/hooks.md](docs/getting-started/hooks.md)), GitHub Actions ([docs/guides/verify-tree.md](docs/guides/verify-tree.md)),
and the sibling repos brivio, metu and codai (`docs/integration/`). Questions about a
*specific* harness's hook behaviour belong to that harness; questions about what the gate
decided and why belong here.
