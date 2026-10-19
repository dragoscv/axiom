# AXIOM documentation

*Everything about the transactional write gate for coding agents, organised the way the site sidebar is: start here, concepts, guides, reference, integrations, design & research.*

AXIOM takes a **Plan** from an agent, compiles it to a canonical content-addressed **Manifest**,
runs **checks** over the whole change set, and **applies** it with a hash-gated two-phase commit
that leaves a journal and, optionally, a signed attestation. One npm package — `@codai/axiom-mcp` —
is an MCP server, a CLI, a PreToolUse hook and a GitHub Action. These pages are the reference for
3.x; the root [README](../README.md) is the one-page tour, [PLAN.md](../PLAN.md) the canonical
tracker of decisions and stories.

```mermaid
flowchart LR
  accTitle: Documentation map
  accDescr: How the documentation sections lead from getting started through concepts and guides to reference, integrations and design.
  GS[Getting started] --> C[Concepts] --> G[Guides] --> R[Reference]
  GS --> I[Integrations]
  C --> D[Design & research]
```

## Getting started

| Page | Purpose |
|---|---|
| [Install](getting-started/install.md) | Every channel — `npx`, global bin, standalone binary, VS Code extension, GitHub Action, MCP Registry — with per-OS notes and how to verify downloads |
| [Quickstart](getting-started/quickstart.md) | The 60-second flow: `mcp.json`, a first Plan, compile → check → apply, what `.axiom/` now contains |
| [Hooks](getting-started/hooks.md) | `axiom gate --stdin` as a fail-closed PreToolUse hook: contract, wiring, profile file, latency budget |

## Concepts

| Page | Purpose |
|---|---|
| [Pipeline](concepts/pipeline.md) | Plan → Manifest → checks → apply → journal, the two-phase commit as a sequence diagram, and the three content transports |
| [Invariants](concepts/invariants.md) | The nine invariants every change must keep, each with what it protects against |
| [Trust model](concepts/trust-model.md) | Roots allowlist, no `cwd` fallback, fail-closed predicates, signing, anti-rollback, attestation |
| [CAS](concepts/cas.md) | The per-root content-addressed store and `axiom gc` |
| [Glossary](concepts/glossary.md) | Glossary — gate, guard, hook, bundle, manifest, verdicts and the other terms these pages use |

## Guides

| Page | Purpose |
|---|---|
| [Apply](guides/apply.md) | Guarantees, non-guarantees, `.axiom/` layout, two-phase flow, rollback, dry-run, PR mode, Windows notes |
| [Checks](guides/checks.md) | The 18 built-in predicates with params, verdict semantics, built-in profiles, custom profiles |
| [Signing](guides/signing.md) | DSSE envelopes, trust store, anti-rollback counter, root binding, CI key ceremony |
| [Verify tree](guides/verify-tree.md) | `axiom plan verify --tree`, `--pre`, in-toto attestation and how to verify it later |
| [Snapshot](guides/snapshot.md) | `axiom_repo_snapshot`: deterministic inventory of a root, diffing two snapshots |
| [Emitters](guides/emitters.md) | `template` sources: determinism contract, the opt-in `@codai/axiom-emitters-web` catalogue, authoring an emitter |
| [Migrate](guides/migrate.md) | `axiom setup migrate v1`: lifting a 1.x manifest into a Plan |
| [Command rules](guides/command-rules.md) | `commands` in the gate policy, the `house` pack, `axiom setup import-guard`, shadow-mode cutover |
| [Sessions](guides/sessions.md) | Cross-session overwrite detection, blind whole-file overwrite, stale-script guard |
| [Undo](guides/undo.md) | `axiom journal undo --session`: gate-side pre-images, conflict-aware restore, gc TTL |
| [Coordination](guides/coordination.md) | File protocol for marks, leases, queue-required commands; git-state facts without spawning git |
| [Stats](guides/stats.md) | `axiom setup stats`: decisions, latency, harness hook logs, silent-gate alarms |
| [Human confirm](guides/human-confirm.md) | `requiresUserInteraction`, MCP elicitation, `--require-human` for `axiom_apply` / `axiom_write` |
| [Managed policy](guides/managed.md) | `axiom setup init --managed`: enterprise policy layers per harness |
| [SARIF](guides/sarif.md) | `axiom plan check --format sarif` and GitHub code scanning |
| [OpenTelemetry](guides/otel.md) | `axiom serve --hook --otel`: GenAI `execute_tool` spans |

## Reference

| Page | Purpose |
|---|---|
| [CLI](reference/cli.md) | Every noun group, command and flag, the hidden 2.x aliases, exit codes, examples |
| [MCP tools](reference/mcp-tools.md) | The 19 tools (6 in the default `core` set, all with `--tools full`), tasks and chunked plans, resources, transports, `--wire` eras |
| [Plan format](reference/plan-format.md) | Field-by-field wire types: Plan, Manifest, Profile, CheckReport, ApplyResult, Journal |
| [Error codes](reference/error-codes.md) | The closed `ERROR_CODES` enum with meaning and raising surface |
| [Profiles](reference/profiles.md) | `.axiom/axiom.json`, built-in `default` / `strict` / `permissive`, `extends`, discovery, the gate policy, migrating old profile files |
| [`.axm` syntax](reference/axm-syntax.md) | EBNF, semantics, heredocs, canonical form, LSP |
| [Versioning](reference/versioning.md) | Fixed version group, wire `apiVersion`, what is breaking |

## Spec

Stable identifiers that signed or attested documents point at. JSON Schemas for every wire kind
are published at `https://dragoscv.github.io/axiom/schemas/v3/<Kind>.schema.json`.

| Page | Purpose |
|---|---|
| [Apply attestation v1](spec/attestation/apply/v1.md) | `predicateType` of the in-toto Statement written by `apply` |
| [Agent decision v0.1](spec/attestation/agent-decision/v0.1.md) | Predicate of the per-call gate decision records |
| [Build type plan@v2](spec/build/plan@v2.md) | SLSA `buildType` for Plan → Manifest compilation |
| [Builder mcp@v2](spec/builder/mcp@v2.md) | SLSA builder id of the `@codai/axiom-mcp` compiler |

## Integrations

| Page | Purpose |
|---|---|
| [Harnesses](integration/harnesses.md) | Hook wiring and MCP config for all 12 harnesses: Claude Code, Copilot CLI, VS Code, Codex, Cursor, Windsurf, Gemini CLI, Junie, Cline, Kiro, OpenCode and ACP (via `axiom acp-proxy`) |
| [GitHub Action](integration/github-action.md) | The AXIOM GitHub Action: inputs, outputs, permissions, attestation |
| [VS Code](integration/vscode.md) | The AXIOM extension (gate status bar, Doctor/Init/Stats/Explain, `.axm` language support), `mcp.json` |
| [codai](integration/codai.md) | SWE harness default-on gate, agent-core risk classes, the eval arm |
| [brivio](integration/brivio.md) | `guard.external` over a 75-guard suite, tasks for the full run |
| [metu](integration/metu.md) | `repo.requireCompanion` rules transcribed from skills |
| [agentq](integration/agentq.md) | The gate profile and command rules used alongside the agentq build/commit queue |

## Design & research

| Page | Purpose |
|---|---|
| [v2 architecture](design/v2-architecture.md) | The design document, annotated as built, with the package graph |
| [Decisions](design/decisions.md) | D-01 … D-31 in one table, pointing at PLAN.md §1 |
| [Research](research/) | Dated records from 2026-09-18/19: landscape, v1 inventory and test audit, red-team critique, mutation baseline, sibling-repo integration, 2.2 roadmap. Kept verbatim; only chat preambles were removed |

## Reading order for a new user

1. [Install](getting-started/install.md) → [Quickstart](getting-started/quickstart.md) — ten minutes, a real apply on a scratch repo.
2. [Pipeline](concepts/pipeline.md) → [Trust model](concepts/trust-model.md) — why `confirmDigest`, why roots, why fail-closed.
3. [Hooks](getting-started/hooks.md) and your harness in [Harnesses](integration/harnesses.md) — the always-on seatbelt.
4. [Checks](guides/checks.md) → [Profiles](reference/profiles.md) — make the gate say what *your* repo requires.
5. [Signing](guides/signing.md) and [Verify tree](guides/verify-tree.md) when you want proof in CI.

## Reading order for a contributor

1. [`.github/instructions/axiom-conventions.instructions.md`](../.github/instructions/axiom-conventions.instructions.md) and [Invariants](concepts/invariants.md) — what must never weaken.
2. [v2 architecture](design/v2-architecture.md) → [Decisions](design/decisions.md) — how it is built and why.
3. [Plan format](reference/plan-format.md) → [Error codes](reference/error-codes.md) — the wire contract you are extending.
4. The skill for your change: [`add-predicate`](../.github/skills/add-predicate/SKILL.md), [`add-mcp-tool`](../.github/skills/add-mcp-tool/SKILL.md), [`add-golden-fixture`](../.github/skills/add-golden-fixture/SKILL.md), [`release-axiom`](../.github/skills/release-axiom/SKILL.md), [`debug-apply-journal`](../.github/skills/debug-apply-journal/SKILL.md).
5. [CONTRIBUTING.md](../CONTRIBUTING.md) — the five green gates and the 19 repo guards (`scripts/check-*.mjs`).

> [!NOTE]
> Links between pages are plain relative `.md` links; the docs site rewrites them at build time.
> Old top-level paths (`docs/apply.md`, `docs/mcp_api.md`, …) are three-line redirect stubs that
> the site build drops.
