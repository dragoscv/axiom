I have what I need from today's verified facts (memory) plus the proposal itself. No further digging changes the argument, so here is the critique.

## Steelman first

The strongest version of v2: *"Agents already write files. Nobody records **what** they intended to write, **why**, under **which rules**, and nobody can prove afterwards that the tree matches the approved plan. AXIOM is the notary between an agent's intent and the repo."* That is a real gap — every harness has hooks, none has a portable, content-addressed, checkable **record** of an agent write that survives the session. If v2 is that, it's worth building. If it's "a DSL that compiles to a JSON that runs checks that a hook already runs", it isn't.

---

## (a) Plan abstraction vs "agent writes files + hooks + tests"

**What a 200-line PreToolUse hook already does**: intercept Write/Edit, run `check-*.mjs`, block. The user has 75 of those in brivio. They work, they're in-repo, they need no server.

**What the hook genuinely cannot do**:
1. **Atomicity across files.** Hooks fire per tool call. An agent editing 9 files for one feature has 8 intermediate states where checks pass individually and the set is wrong. A Plan is a *transaction*.
2. **Whole-set checks.** "Migration exists iff schema changed", "all 3 SDKs updated iff route added" (ripple-completeness.md — the user's own measured 3–6% ripple rate) are predicates over a *set of files*, unexpressable per-write.
3. **A durable artifact.** After the session, the hook has left nothing. A manifest with sha256 + provenance is greppable, diffable, attachable to a PR.
4. **Cross-harness portability.** Copilot CLI, Claude Code, VS Code, CI all have different hook shapes; one MCP tool + one CLI is the same everywhere.

**What the Plan adds that is *not* value**: templates ("template refs"). Agents generate content; a template registry is v1's notes-app mistake with a JSON coat. **Cut `templateRef` from the Plan schema.** Content is bytes or a patch, nothing else.

**Blunt verdict on (a)**: the Plan is better than hooks *only* for points 1–3. Argue v2 exclusively on transaction + set-level checks + record. If a feature doesn't serve one of those, it's out.

## (b) Determinism — where it breaks

- **Content-addressing is deterministic; nothing upstream is.** The agent producing the Plan is stochastic. "Same `.axm` → same output" was v1's marketing and is meaningless when the emitter is an LLM. Reframe: *determinism of the gate, not the generation*. Same Plan + same repo state → same verdict + same manifest hash. That's provable; the other isn't.
- **"Repo facts" in CEL are the leak.** `fileExists`, `gitBranch`, `package.json.version`, mtime, line endings (CRLF on Windows — the user's own rules note this), `.gitattributes` normalization, the working tree being *shared with other agents mid-edit* (multi-agent-coordination.md). Any predicate over the tree is only as deterministic as the snapshot you evaluate it on. You need: evaluate against a **captured snapshot** (list of path→sha256 at plan-check time), record that snapshot hash in the manifest, and **re-verify at apply** that the touched paths still match — otherwise you've reinvented TOCTOU.
- **Guard runners (`check-*.mjs`) are arbitrary code.** They read env, network, time. The moment you shell out, "deterministic" is a lie unless you record their stdout+exit as *evidence*, not as *proof*.
- **Canonicalization**: in-toto Statement canonical JSON needs JCS (RFC 8785); key ordering, Unicode normalization of paths (NFC vs NFD on macOS), path separators. Codai rules-core already has a canon — reuse it verbatim or you get a *fourth* manifest schema. Today there are three.
- **Rollback isn't determinstic on a shared tree**: rollback to "before" while another agent wrote to a neighbouring file = you've just done the CHANGELOG incident with extra steps. Rollback must be *scoped to the exact paths in the Plan*, and must refuse if the pre-image hash of any touched path changed between check and apply.

## (c) Scope creep — what to cut for weeks-not-months

Cut from v2.0 entirely:
- **Langium LSP package** (weeks of work, zero users).
- **Streamable-HTTP transport** — stdio is what every harness speaks today; HTTP brings auth, CORS, sessions.
- **DSSE signing** — see (g); a solo dev signing his own manifest with his own key proves nothing to anyone. Ship a `provenance.builder`+sha256 and *leave a hook* for a signer.
- **Own CEL parser** — see (e).
- **Codai RiskClass integration** — a `riskClass` string field in the Plan, no code dependency.
- **Metu skills emit Plans** — that's a metu change, not an axiom one.
- **Git PR mode** — keep fs apply; PRs are `gh pr create` after apply.

Keep for v2.0 (this *is* the product):
1. `Plan` Zod schema (files: path, content|patch, mode; checks[]; provenance).
2. `plan check` → snapshot + predicates + guard runners → manifest.
3. `plan apply` → pre-image verify → temp-write → fsync → rename, scoped rollback.
4. MCP stdio with 3 tools: `axiom_check`, `axiom_apply`, `axiom_status`. CLI `axiom verify` for CI.
5. **Fix or delete the 38 failing tests first.** A v2 on top of a red suite inherits the red.

Realistic effort for that: **2–3 weeks solo with agents**, if the DSL is not on the critical path.

## (d) The DSL

**Kill it from the critical path; don't delete the repo history.** Arguments:
- Agents don't need syntax sugar; they produce JSON natively and a Zod schema *is* the grammar with free validation errors. A Chevrotain grammar is a second source of truth that will drift from the Zod schema (exactly what happened with 3 manifest schemas).
- Humans writing `.axm` by hand: who? The author, in demos. That is not a user.
- Every DSL-based "intent" project (AIDL-style, `spec.md` compilers, Cursor rules languages) converges on Markdown/YAML because the *consumer is an LLM* and LLMs read prose+YAML best.
- If you want a human front-end later: **YAML with the Plan JSON Schema attached** (`# yaml-language-server: $schema=`) gives you completion, validation and an LSP for free, today. That beats Langium at ~0 cost.
- TOML: no. Multi-line content blocks in TOML are miserable; YAML block scalars or JSON are fine.

Keep `.axm` as a *converter* sample in `examples/` if it hurts to delete. It must not be in `axiom-core`.

## (e) CEL subset custom parser

**Not worth it.** Concretely:
- A "CEL subset" is neither CEL (so no spec compatibility, no docs to point at) nor small (precedence, string methods, macros `all/exists`, type coercion, error semantics). Realistic: 1.5–3k lines + a fuzz surface. The user's own principle: measure before building.
- `cel-js` exists on npm and is actively maintained; if you want CEL, use it — but its type system + the "repo facts" ambient environment is the actual hard part, not parsing.
- **JSONLogic**: agents emit it fine (it's JSON), it's ~2k stars, but its operator set is weak on strings/globs and error messages are poor.
- **Recommended**: **Zod-described predicate objects** (a discriminated union: `{kind:"fileExists", path}`, `{kind:"glob-count", glob, max}`, `{kind:"regex-absent", glob, pattern}`, `{kind:"json-path-eq", file, path, value}`, `{kind:"guard", cmd}`), 10–15 kinds. Reasons: validated by the same Zod schema as the Plan, trivially deterministic, JSON-native for agents, each kind is unit-testable, no parser. The 75 brivio guards tell you what predicates people actually write — mine them for the kind list. Add a `cel` kind later behind `cel-js` if someone asks.

## (f) MCP tool design pitfalls

- **cwd**: stdio MCP servers inherit the *harness's* cwd, which in VS Code is often not the workspace (and in a tunnel is the host). Never use `process.cwd()`. Require `repoRoot` explicitly; resolve to realpath; refuse if it's not a git toplevel unless `--allow-non-git`.
- **repoPath trust**: the model supplies it. Enforce an **allowlist of roots** from server args (`--root E:\gh\brivio`) — a path outside is a hard error, not a warning. Realpath after symlink resolution; reject `..`, absolute paths in Plan files, and NTFS ADS (`file.txt:stream`) and Windows reserved names (`CON`, `NUL`) — v1's POSIX-only check misses the latter two.
- **stderr noise**: any `console.log` on stdout corrupts the framing. Route all logs to stderr, structured, and honour `MCP` logging capability; default quiet.
- **Large payloads**: a Plan with 40 files × 50 KB inline content = 2 MB in one JSON-RPC message; some hosts choke >1 MB and the model has to *emit* it as tokens (expensive, error-prone). Design: `axiom_plan_begin` → `axiom_plan_add_file` (chunked) → `axiom_check` → `axiom_apply`, with plan state on disk under `.axiom/plans/<id>/`. Also accept `patch` (unified diff) instead of full content for edits — it's what agents already produce and it's 10× smaller.
- **Annotations**: `readOnlyHint: true` on check/status, `destructiveHint: true` on apply, `idempotentHint: true` on apply-by-manifest-hash (apply the same hash twice = no-op). `outputSchema` yes, but keep output *small* — return manifest hash + verdict + failing checks, never the whole manifest.
- **Concurrency**: two agents in the same clone (the user's daily reality) both calling `axiom_apply`. You need a lock (`.axiom/apply.lock` with PID + reclaim, exactly like `run-build.ps1`).
- **Timeouts**: guard runners must have a wall-clock cap; a hung `check-*.mjs` hangs the MCP call and the harness turn.

## (g) The "verified apply" trust model

Ask the three questions:
- **Who signs?** For a solo dev, the same process that generated the Plan. A key on the same machine, with the same user, signing content that machine produced. **Threat stopped: none.** It stops tampering by a party who doesn't have your laptop — i.e. nobody in this threat model.
- **Who verifies?** CI (`axiom verify`) could — *if* the manifest is committed and the key is elsewhere. That's the only configuration where a signature means anything: **signing happens in CI or on a separate key**, verification happens at merge/deploy. That's SLSA's builder model and it's not what P1 describes.
- **What is realistically at risk for a solo dev with agents?** Not forgery. It's (1) an agent writing outside the intended path set, (2) an agent writing files that pass individually and break jointly, (3) another agent's concurrent edit being clobbered, (4) no record of what changed and why. **None of those need a signature.** They need path allowlists, set-level checks, pre-image hash verification, and a committed manifest.

So: keep sha256 manifest + pre-image verify + the provenance *statement* (unsigned in-toto Statement is still useful as a record). DSSE becomes a flag in v2.x with the key living in CI. Don't make codai rules-core a runtime dependency for this; import its canonicalization function or copy it with attribution.

## (h) Adoption

Honest answer: **nobody besides the author, in the current framing.** Evidence: 25 npm releases in 19 hours, 0 external issues, no integration with the author's own repos after a year. Reasons other people won't adopt: their harness already has hooks; a DSL is a learning tax; "provenance for agent writes" is something people say they want and never install.

Where there *is* a possible external audience: **teams running multiple agents in one repo who need a transactional, auditable write gate** — a small but real, growing niche, and the author is literally living it. The pitch has to be "multi-agent write transactions", not "intent DSL". Also: the CI mode (`axiom verify` fails a PR whose tree doesn't match its committed plan manifest) is the one thing a *third party* could plausibly turn on in 5 minutes.

## (i) Alternative framings

1. **"Transactional write gate for agents"** — library + MCP + CLI; Plan = the transaction. Strictly better than v2 as written: same core, minus DSL/CEL/DSSE/HTTP.
2. **"Plan format standard"** — publish the JSON Schema and hope others implement. Dead on arrival; standards need two implementations and you have zero users.
3. **"Provenance + gate library"** — pure library, no server. Better than #2, but without the MCP surface, agents can't call it, so it's #1 minus distribution.
4. **"AXIOM = codai capability"** — fold it into codai's agent-core as `agent-core/apply` with RiskClass gating. Highest leverage *for the author* (codai is the top-priority repo, already has RiskClass + APPROVAL_MATRIX + canon/envelope), zero standalone brand, ends the 3-schema problem by adopting codai's. Cost: axiom stops being a product.

---

## Biggest risks (ranked)

1. **Blocking** — building on a red test suite and 3 manifest schemas. v2 must start by collapsing to one schema (codai canon) and a green suite, or it inherits v1's credibility problem.
2. **Blocking** — TOCTOU on a shared working tree: check-then-apply without pre-image hash verification and a lock = data loss for the other agent.
3. **High** — DSL + Langium + custom CEL are three parsers of homework that delay the only valuable part (transaction + set checks) by months.
4. **High** — DSSE signing with a local key gives a false sense of security and costs a dependency on codai internals.
5. **Medium** — MCP payload size and cwd trust; both are solvable but will bite in the first real session if not designed in.
6. **Medium** — no user besides the author; mitigate by making CI `verify` the 5-minute on-ramp.

## What I'd change

Plan = `{files:[{path, content|patch, mode}], checks:[Predicate], provenance:{agent, session, riskClass}}`. Predicate = Zod discriminated union, ~12 kinds + `guard`. Snapshot → check → manifest (in-toto Statement, unsigned, canon from codai) → lock → pre-image verify → atomic apply → scoped rollback. MCP stdio, 4 tools, chunked plan build. CLI `verify` for CI. Nothing else in 2.0.

## Ranked framings

| # | Framing | Pitch | Effort |
|---|---|---|---|
| **1** | **Transactional write gate for multi-agent repos** | "One approved Plan, checked as a set, applied atomically, recorded as a manifest — or nothing." | 2–3 wks to 2.0; MCP + CLI |
| 2 | codai capability (`agent-core/apply`) | "Every codai agent write goes through RiskClass-gated, manifest-recorded apply." | 1–2 wks inside codai; kills axiom as a product |
| 3 | Provenance + gate library (no server) | "Import `@codai/axiom` to make your own agent's writes auditable." | 1–2 wks; no distribution |

**Recommended: #1**, with #2 as the *first consumer* (codai calls the library; RiskClass is a string field, not a dependency). Reasons: it's the only framing where AXIOM does something a hook can't (transaction + set checks + record), it's the problem the author actually has daily (231 concurrent session pairs in brivio, measured), it keeps a standalone surface a third party could adopt via CI `verify`, and it deletes the three things (DSL, CEL parser, signing) most likely to turn "weeks" into "months". Ship with changes — the core idea survives; the v2 as written does not.