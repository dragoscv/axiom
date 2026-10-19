# Glossary

*The words AXIOM uses with one fixed meaning: gate, guard, hook, plan, manifest, bundle, profile, the two kinds of verdict, relaxed and override, hard codes, slots, the daemon, the journal and attestations.*

Each term links to the page that defines it in full.

## The two halves

| Term | Meaning |
|---|---|
| **gate** | The per-tool-call decision AXIOM makes when a harness asks "may the agent run this?": `axiom hook gate --stdin` (old verb `axiom gate`) reads one harness payload and answers allow, deny, ask or warn. It judges write targets (containment, `deny`/`allow`/`ask` globs, secrets, size) and shell commands (command rules, git state, sessions). Configured by the `gate` section of the [policy file](../reference/profiles.md#gate-keys). See [Hooks](../getting-started/hooks.md). |
| **pipeline** | The per-change-set path: Plan → Manifest → checks → apply → journal. Used through MCP tools (`axiom_write`, `axiom_apply`, …) or `axiom plan …`. See [Pipeline](pipeline.md). |

## Objects

| Term | Meaning |
|---|---|
| **plan** | What an agent wants to change: `apiVersion`, `name`, `intent`, `artifacts[]` (path, op, source) and optional `checks[]`. JSON, YAML or `.axm`. Not hashed as-is. [Plan format](../reference/plan-format.md#plan-input). |
| **manifest** | The canonical, content-addressed form of a plan: every artifact as path + op + sha256, no content, no timestamps. `manifestDigest = sha256(JCS(body))`. [Plan format](../reference/plan-format.md). |
| **bundle** | A manifest plus the bytes it needs to apply: `{ manifest, manifestDigest, blobs }` (`ManifestBundle`). Blobs are inline (≤ 256 KiB each, ≤ 4 MiB total) or live in the CAS. |
| **CAS** | The per-root content-addressed store under `.axiom/cas/sha256/`. Bytes are re-hashed on every read. [CAS](cas.md). |
| **profile** | Two things share the name. A **check profile** is a named list of predicates plus limits (`default`, `strict`, `permissive`, or your own in `.axiom/profiles/<name>.json`) that `check`/`apply` evaluate over a whole manifest. The **gate policy** is the flat object the gate reads, from the `gate` section of `.axiom/axiom.json` (or the legacy `.axiom/gate-profile.json`). [Profiles](../reference/profiles.md). |
| **pack** | A reusable policy layer pulled in with `extends`: built-in `axiom:default|strict|permissive`, a relative file, or an npm package `@codai/axiom-pack-*`. Also the `house` command-rule pack (`commands.pack: "house"`). |

## Decisions

| Term | Meaning |
|---|---|
| **gate verdict** | The gate's answer for one tool call: **allow** (proceed), **deny** (the harness blocks the call; the reason goes back to the agent), **ask** (the harness asks the human; formats without an ask prompt get deny), **warn** (allowed, with the would-be deny shown to the agent as a warning). |
| **check verdict** | The result of running predicates over a manifest: **pass**, **fail** (a predicate found a violation) or **error** (a predicate or its fact provider could not run). Only `pass` lets `apply` proceed — `error` blocks, never a silent pass. [Checks](../guides/checks.md). |
| **finding** | One reason inside a check verdict: `{ id, severity, message, path? }`. Its `id` is the check id, not an `ERR_*` code. |
| **rule code** | The id of the gate rule that decided (`path.deny`, `house.forcePush`, `git.destructiveTree`, `sessions.budget`, …). Appears in the deny reason, the decision journal and `axiom explain`. [Error codes § Gate rule codes](../reference/error-codes.md#gate-rule-codes). |
| **error code** | A member of the closed `ERR_*` enum — what went wrong in AXIOM itself or in the input. Branch on it, never on message text. [Error codes](../reference/error-codes.md). |
| **relaxed** | A deny that was let through, recorded in the decision journal as `relaxed: "warn"` (profile `mode: "warn"`) or `relaxed: "override"` (the agent stated a reason). Relaxed decisions are always journaled. |
| **override** | The agent passes a non-hard deny by writing `axiom-override: <reason>` (≥ 3 words, ≥ 12 letters) in the tool's explanation / goal / description / reason field, or as a trailing `# axiom-override: …` shell comment outside quotes. Off unless the policy sets `override: true`. Never read from file content or command bodies. |
| **hard code** | A rule code listed in the policy's `hard` array (exact, `prefix.*` or `*`). It denies in every mode and cannot be overridden. `axiom setup init` hardens `house.forcePush`, `house.resetHard`, `house.cleanForce` and `house.worktreeRemoveForce`. |
| **enforce / warn** | The two gate `mode`s. `enforce` (default) blocks denies; `warn` turns non-hard denies into warnings — useful for a trial week before switching to enforce. |
| **shadow** | `shadow: true`: the gate never denies and records what it would have decided, for a parity replay before a cutover. |

## Machinery

| Term | Meaning |
|---|---|
| **hook** | The harness side of the gate: an entry in the harness's config (`.claude/settings.json`, `.github/hooks/axiom-gate.json`, Codex/Cursor/Kiro/… hook files) that runs `axiom gate --stdin --format <harness>` before a tool call. `axiom setup init` writes it. [Harnesses](../integration/harnesses.md). |
| **guard** | Only an **external check**: your own script (`scripts/check-*.mjs`) run as the `guard.external` predicate inside a check profile. Needs both `facts.allowGuards: true` and the `--allow-guards` process flag. The gate is never called a guard. [Checks](../guides/checks.md). |
| **daemon** | `axiom hook daemon` (`axiom serve --hook`): a resident gate on loopback that answers hooks in a few milliseconds instead of starting a process per call. Responses are authenticated (token + MAC); a client that cannot verify one decides in-process. |
| **root** | A directory AXIOM may read and write, given explicitly with `--root`. There is no `cwd` fallback. [Trust model](trust-model.md). |
| **slot** | A linked git worktree used as an agent's private checkout. A slot without its own policy, or with an older one, inherits the main clone's policy. [Profiles](../reference/profiles.md). |
| **two-phase commit (2PC)** | How `apply` writes: stage every file under `.axiom/`, re-verify every pre-image hash, then rename into place; any failure rolls back to the byte-identical prior tree. Requires `confirmDigest === manifestDigest`. [Apply](../guides/apply.md). |
| **pre-image** | The sha256 of a file *before* a change (`absent` for a file that must not exist). Checked at prepare and again at commit. |
| **journal** | Two records under `.axiom/`. The **apply journal** (`.axiom/journal/`) records every apply step by manifest digest, hash-chained in `chain.jsonl`, and drives rollback and crash recovery. The **decision journal** (`.axiom/decisions.jsonl`) records gate decisions (with `record: true`, and always for relaxed ones), redacted; `axiom explain` and `axiom setup stats` read it. |
| **undo** | `axiom journal undo --session <id>`: restores every file one agent session wrote through the gate (including allowed outside-root writes) from the pre-images the gate captured with `undo: true`. [Undo](../guides/undo.md). |
| **rollback** | `axiom journal rollback <digest>`: reverse-replays one apply. Refuses when a file it wrote has since changed, or when a backup is missing. |
| **attestation** | A signed or uploadable in-toto statement about something AXIOM did: the [apply attestation](../spec/attestation/apply/v1.md) ("this tree matches manifest M") or an [agent-decision attestation](../spec/attestation/agent-decision/v0.1.md) (one gate decision). DSSE-signed with Ed25519 or uploaded to Sigstore from CI. |
| **harness** | The agent runtime that calls tools: Claude Code, Copilot CLI, VS Code, Codex, Cursor, Windsurf, Gemini CLI, Junie, Cline, Kiro, OpenCode, or any ACP client. |
