# Reality check: AXIOM 2.7.0 (2026-10-19)

**Scope.** AXIOM 2.7.0 (`main` db1728c), checked from 13 angles: product, three architecture
splits (core / mcp / tooling + Rust), QA, red team, legal, design and accessibility, DX writing,
SRE plus release, how agents actually used it on this machine, the consumer repos, and harness
interop. Each persona worked read-only and backed every claim with a command and its output.
The raw notes and probe scripts are in `.copilot-tmp/rc3/<persona>/`, which is gitignored and
stays local. Before ranking anything P0 I re-ran it against the published 2.7.0 binary myself:
`.copilot-tmp/rc3/verify/v.mjs` reproduced 12 of 12 gate bypasses, and the arch1
`probe3.mjs`/`probe4.mjs` scripts reproduced the apply and ref findings.

**Headline.** The tracker shows 149 stories done, and the build is not broken. But the gate's
security claims break under a determined agent: 13 bypasses reproduce, and the apply layer
can be made to overwrite its own trust store. Docs and onboarding have drifted from the code.
On the owner's machine the gate costs about 1.3 s per tool call, while the gate logic itself
takes about 18 ms. Every surface that published 2.7.0 shows 2.7.0, with one exception:
CITATION.cff still says 2.2.1.

**Local state warning.** The local `packages/mcp/dist` predates 3970fb4 and rejects the 2.7
profile keys. The local `crates/axiom-hook/target` binary is 2.5.0. Several local guards were
failing for that reason alone, so rebuild before measuring anything.

## 1. P0: verified, must fix before any release

| # | Area | Finding | Evidence | Fix |
|---|---|---|---|---|
| P0-1 | daemon | Any local process can take over gate decisions. It writes `~/.axiom/daemon.json` pointing at its own loopback port and answers `x-axiom-exit: 0`, and both the node client and `axiom-hook` then allow everything, `--deny-exit 2` included. The client also sends its bearer token to that squatter. The gate does not protect `~/.axiom/**` from writes. | rt `fake-daemon.mjs`, arch2 probe5 | Daemon protocol 2: a token is always minted, every response carries an HMAC of `(nonce, exit, stdout)`, and the client checks the pid is alive. `~/.axiom/**` and the hook config files go on a built-in hard deny list. |
| P0-2 | gate | Hard codes are matched by rule id, and evaluation stops at the first rule that matches. `git worktree remove --force x # axiom-override: …` is allowed as `OVERRIDE house.worktreeRawRemove`. `git reset HEAD --hard` and `git clean -d -f` are allowed through override or warn mode. | verify/v.mjs lines 10–11 | Evaluate every command rule and refuse if any matching rule is hard. Give the whole-tree destructive-git branch its own code, `git.destructiveTree`, that inherits hard. Normalise git argv before matching (see P0-4). |
| P0-3 | gate | The override reason is read from the `command` field, which includes apply_patch bodies, heredocs and quoted strings. File content can therefore unlock a deny, and an 8-character reason is accepted. | verify/v.mjs lines 5–6; arch2 | Accept an override only from explanation/goal/description/reason, or from a trailing `# axiom-override:` comment that the lexer finds outside quotes and heredocs. Never read apply_patch-class `command`. Require at least 3 words and 12 letters. Strip the comment before scanning the shell command. |
| P0-4 | gate | The shell scan has gaps. A newline is not treated as a command separator (`echo ok\nrm .env` is allowed). The force-push regex misses `-uf`/`-fu`, `+refspec`, `--mirror`, `git -C . push -f`, `git -c x=y push -f`, `git.exe`, quoted or backticked flags, `-EncodedCommand`, and `iex '…'`. `gate.ts` and `command-rules.ts` each have their own tokenizer, and the two have drifted. | verify/v.mjs 1, 7–9; rt b4.sum (40 cases) | One shared `shell-lex.ts` that splits on `;`, `&`, `\|` and newline. It strips PowerShell backticks and quotes, folds git global options, recurses into `-c`/`/c`/`-Command`, and decodes `-enc`/`-EncodedCommand`. Force push is detected semantically: `-f`/`--force*` anywhere in a short-flag cluster, a `+` refspec, `--mirror`, or `--delete` on the default branch. |
| P0-5 | gate | Glob matching is case-sensitive on Windows and macOS. Relative `.ENV`, `.GIT/config` and `SECRETS/x` are allowed, as are 8.3 short names (`VERYLO~1`). | verify/v.mjs 3–4; rt paths.log | On win32/darwin, match with picomatch `nocase`. Canonicalise relative targets through `canonicalizeExisting`. Refuse segments matching `~\d`. |
| P0-6 | gate | A target of `.` (the repo root) is classified as `ERR_CONTAINMENT` before the destructive-git branch runs. With `outside: allow` or warn mode, `git clean -fdx`, `git reset --hard` and `git rm -r --cached .` go through. | arch2 | Treat `rel === ""` as the root itself, which is not an escape. Handle the root before the outside/relax path. |
| P0-7 | daemon | The daemon checks its root allowlist against `cwd` only. A payload carrying `workspace_roots`, `workspaceRoots` or `tool_info.cwd` gets a repo outside the allowlist judged with that repo's own profile. This breaks invariant 8. | arch2 | Check roots against `normalizePayload().cwd`, the same value `runGate` resolves, and refuse with 421 when it is outside the allowlist. |
| P0-8 | apply | The `.axiom/` reserved-prefix check is case-sensitive and does not resolve 8.3 names. A manifest writing to `.AXIOM/trust/keys.json` or `AXIOM~1/…` overwrites the trust keys, journal, lock and CAS. | arch1 probe3 `[8.3]` | Compare the first path segment NFC-normalised and lowercased. After `resolveContained`, refuse any parentReal under `realpath(root/.axiom)`. New code `ERR_PATH_RESERVED_DIR`. |
| P0-9 | apply | A journal step's `backup` path is never validated. A journal planted through P0-8 makes the next apply's recovery step move any file the user can rename into the repo. | arch1 probe3 `[chain]` | `backup` must start with `.axiom/backup/<own digest>/`. `rollbackJournal` runs both `path` and `backup` through `resolveContained`. |
| P0-10 | plan | When a `ref` source hits the CAS, the content is returned without re-hashing, so a poisoned CAS entry replaces the pinned bytes. | arch1 probe4 | Re-hash after `casGet` and raise `ERR_DIGEST_MISMATCH` on a mismatch. Rename the raw function to `casGetUnverified`. |
| P0-11 | gate/compat | `GateProfileSchema` is `.strict()`. An older bin reading a newer profile denies every write with `ERR_INTERNAL`. Combined with `--fail-open`, which all three consumer hooks use, it instead turns the gate off silently. That is exactly what will happen during a 2.x→3.0 rollout. | consumers g4.txt; sre realhome.mjs | Ignore unknown keys and print one WARN naming them. Add a profile `version` field: deny only when it is above the running major. Profile errors are never covered by `--fail-open`. `doctor` flags keys newer than the installed bin. |
| P0-12 | defaults | The profile `axiom init` writes has no `commands` block, so `git push --force` and `curl … \| sh` are allowed out of the box, while `git reset --hard` is denied. | qa e2e.log | `init` writes `commands: {pack: "house"}` plus the four hard codes. An e2e test checks that force push is denied after a fresh init. |
| P0-13 | legal | The bundled dist (mcp, vscode-axm) and the SEA binaries ship third-party code with no notices: the MCP SDK and chevrotain under Apache-2.0, plus MIT/BSD/ISC packages and the Node runtime. The JSDoc-strip plugin also removes `@license` comments. The LICENSE file names no copyright holder. | legal | Generate `THIRD_PARTY_NOTICES.md` at build time and ship it in every tarball, the .vsix and the release assets. Keep `/*! @license */` comments. Name the holder in LICENSE. |
| P0-14 | a11y | In dark mode the primary hero button has white text on `#f0703d`: 2.96:1, and 1.99:1 on hover. WCAG requires 4.5:1. | design contrast.mjs | Use dark ink text on the seal colour in dark mode (about 6.2:1). |

## 2. P1

**Gate and ops**
- Worktree slots keep stale gate profiles: 9 of 16 codai slots and 14 of 15 brivio slots, so D-40 never reached them. The journal records the main profile, not the one that decided. Fix: the slot falls back to the main clone profile when it has none or an older one; journal `profile_path`; `doctor --fleet`.
- 41 % of journal "denies" come from `hook-pre.ps1` running in observe mode and were never enforced. Fix: journal `enforced:false`, and have stats filter on it.
- Empty stdin ("no payload") fails closed: 36 denies in 3 days from long-running chats still on the old hook command. Fix: empty stdin after timeout → allow + WARN (the harness timeout fails open anyway). Unparseable JSON stays fail-closed.
- Overrides and warn passes reach the journal only when `record` is set. Fix: always journal any relaxed decision.
- Warn mode does not relax `ERR_UNSUPPORTED_OP` for unknown MCP tools. `create_and_run_task` is not scanned as a shell tool.
- Write classification is substring heuristics: `rename_file newPath`, `move_file destination`, `create_directory .git/hooks` and `mcp__fs__put` slip through. Fix: add the missing path keys and hints; v3 gets an explicit per-harness tool table.
- The shell scan misses `Remove-Item -Path:.git`, `ri`/`sc`/`ac`/`ni` aliases, `cmd /c del`, `pwsh -c`, `python -c`/`node -e` writes, `find -delete`, `$( … )`, and `git -C . checkout -- .env`.
- The daemon accepts profile argv from the URL query: any local process can make it read any file, and JSON parse errors echo the file's first bytes. Fix: allowlist the argv; errors print fixed messages with no echo (same for the `payload is not JSON` message).
- noSecrets email/credential/PII rules fire 75–92 % of the time on `.copilot-tmp`, tests and fixtures. Fix: `noSecretsExclude` defaults for the PII-class rules only. Keep privateKey/awsKey/token everywhere.
- Ops data shows no rule for `rm -rf <dir>`, `Remove-Item -Recurse -Force <dir>` or `git stash drop|clear`. Fix: house rules (warn-class).

**Harnesses**
- Codex `commandWindows` is the PowerShell form (`; exit $LASTEXITCODE`). If Codex runs it under cmd it never denies. Fix: plain `axiom.cmd gate --stdin --format codex`.
- The Claude deny carries extra top-level keys, which may fail Claude's strict schema and turn into a non-blocking error. Fix: `--format claude` emits only `hookSpecificOutput`.
- When node is missing, the npm shim exits 1, which VS Code Local and Claude treat as fail-open. Fix: the PowerShell hook command maps any exit other than 0/2 to 2 for formats that block on exit 2. `doctor` checks node is on PATH.
- Kiro has a real PreToolUse API (non-zero exit blocks) and is not supported. Junie supports `ask`, but AXIOM maps it to deny. Windsurf `pre_mcp_tool_use` is not wired.
- `harnesses.md`, the `quickstart` and the README still say Codex has no hooks. The Claude snippet is stale and fails open (5 s timeout, no `onFailure`). VS Code agent targets (Copilot / Claude / Codex / Local) are not distinguished.

**Apply / checks**
- Contained reads: compile follows junctions when reading pre-images (outside bytes end up in the bundle), and `checks/facts/repo.ts` follows junctions too.
- `rollback` does not check the journal phase: a second rollback deletes later work. There is no drift check before restoring. A rollback whose backup was pruned reports success. Rolling back an overwrite of a missing file leaves the new file behind.

**Docs and DX**
- `<verb> --help` prints the global 70-line usage. Usage errors bury the message under the full help. Ordinary user errors (missing file, bad JSON, broken profile) come back as `ERR_INTERNAL`.
- Only 4 of 64 error codes say what to do. The quickstart shows outputs the CLI does not produce. Profile docs cover 10 of 19 gate keys. Tool count says 18 (actual 19), verb count 23 (actual 26). The `cli.md` error envelope is wrong (the real one is flat).
- Human-readable output uses `—`, `→` and `…`, which garble on PowerShell 5.1 and OEM-codepage consoles. Use ASCII output.
- Mermaid diagrams have no `accTitle`/`accDescr`, and readers without JS see the raw source. Light-mode muted text is 4.49:1, links on cards 4.44:1, and the digest on inline code 4.16:1 (all below 4.5:1).
- The VS Code extension does `.axm` language support only: nothing for gate users, no LICENSE in the vsix, no screenshots, no Workspace Trust declaration.

**Release and QA**
- During every release, "latest" points at a release with only the vsix for about 4 minutes (the installers and brew 404 in that window). The `v2` action tag can move backwards on a re-run.
- CITATION.cff is stuck at 2.2.1 and SECURITY.md at "2.2.x current", and no guard catches either.
- The mutation workflow does not trigger on changes to `gate.ts` or `command-rules.ts`. There are no mutants for rollback, recovery, lock or the force-push regex. 59 assertions check message text. The `hasDist` skip can go silent in CI.
- 4 consecutive red pushes to main on 10-14 came from realpath traps (macOS and Windows). A pre-push changed-tests hook would have caught them.

**Legal and privacy**
- The docs site loads Google Fonts (sends visitor IPs to Google: GDPR). `llms-full.txt` publishes local user paths from the research notes.
- `decisions.jsonl` stores the OS username, the full command text in shadow mode, and free-text override reasons, unscanned and with no retention limit.
- "AXIOM" collides with axiom.co (Axiom, Inc., observability, same developer audience, ships an `axiom` CLI). Trademark search → lawyer. `axiom.dev` is not controlled by the project but appears in `apiVersion` and in the attestation predicate URI.

## 3. P2 (abridged; full lists in the persona notes)

**Code quality**
- `.axm` `meta` as a plan name breaks the parser.
- The TextMate grammar is missing the `patch` keywords.
- An LSP hover cites a template that does not exist.
- `emitters-web` hard-codes `web@2.0.0` in four places.
- `testkit` is built but nobody depends on it.
- Dead exports: `runGatePredicates` and roughly 15 apply/canon/plan helpers.
- `runGate` is a single 400-line function.
- 7 plain `throw new Error` calls in canon/plan.

**Rust hook client (`axiom-hook`)**
- The fallback has no wait timeout.
- The pnpm global layout is hard-coded.
- The release only *warns* on a version mismatch.

**Performance**
- On this box the native hook was not faster than plain node: the unsigned exe pays roughly 235 ms at spawn.
- The npm `.cmd` shim adds about 225 ms per hook.
- A stale `daemon.json` costs 1.1 s on fallback.

**CI cost**
- Node 22 runs on all three OSes, and golden checks run as separate jobs: about 72 billable-equivalent minutes per push.
- The release job rebuilds and retests what CI already proved.

**Docs**
- The `cli.md` init table is stale.
- The quickstart claims "60 s", but npx takes 10–20 s per call.
- Integration guides still have pre-2.0 conditionals.
- About 60 inline version tags clutter the reference.
- No glossary (gate / guard / hook / bundle / manifest).

**Site**
- The 404 page's canonical URL returns 404.
- One OG image is shared by every page.
- No version is shown on the site.
- There is no dark `theme-color`.

**Process**
- No CLA/DCO.
- The CoC contact channel does not exist.
- No SBOM.
- CRA position not stated.

## 4. What only AXIOM does (positioning, from the PM review)

MCP gateways (Docker, Snyk/Invariant, Lasso, MintMCP, Kong, Zuplo) control *which tools* an
agent may call. Harness checkpoints are per-turn snapshots. AXIOM is the only tool that treats
an agent's edits as a transaction:
- a change set confirmed by digest
- two-phase apply with a pre-image check
- a byte-exact rollback
- DSSE/in-toto attestation
- one gate across 9 harnesses, with a 4 ms daemon path
- session undo

The wedge is "undo for agents, plus a gate that never times out". The obstacles to adoption are
the name collision, a 0-star / roughly 440 downloads per week footprint that comes mostly from
the owner's own repos, onboarding that starts with writing a Plan in JSON, and an extension that
does nothing for gate users.

## 5. Options for the real decisions

1. **Breadth of v3.**
   - (a) Fixes plus compatibility only.
   - (b) **Fixes, plus tolerant profiles with a `version` field, daemon protocol 2, emitters-web made optional (not bundled), a one-command-table CLI with per-verb help, and Kiro/Junie-ask.** Breaking changes kept to what the fixes need.
   - (c) Also unify gate-profile and checks profiles into one `axiom.json`, regroup verbs into nouns (`axiom journal log`), and drop `.axm`/LSP.

   (c) breaks codai `swe-harness`, `hook-pre.ps1` (which parses the output fields) and every consumer's skill docs.
2. **Name.** Keep `axiom`, add `axgate` as a second bin, or rename. Renaming costs every consumer, the brew formula, Marketplace and the registry; trademark risk is unconfirmed until a lawyer searches.
3. **apiVersion and predicate URIs.** `apiVersion` is inside the hashed body, so changing it re-pins every golden digest and every consumer's plans. The attestation predicate URI is not hashed into manifests.
4. **Override grammar.** Explanation/goal fields only, or also a trailing shell comment parsed by the lexer. The owner's own house practice uses the trailing-comment form.
5. **Init defaults.** Enforce + house pack, or warn for 7 days and then suggest enforce.
6. **MCP tool surface.** All 19 by default, or a core set (write/status/rollback/check/apply) with `--tools full`.
7. **VS Code extension.** Turn it into an "AXIOM" extension (status bar, decision view, doctor/init/undo commands) or freeze it as language-only.

## 6. New ideas (diverge → converge)

| # | Idea | Value | Effort | Risk |
|---|---|---|---|---|
| I-1 | `axiom doctor --fleet`: every repo and worktree slot on the machine, profile drift, stale hook commands seen in Hooks.log, bin skew | High (fixes D-40 drift for good) | S | Low |
| I-2 | Worktree slot profile inheritance from the main clone (via the git common dir) | High | S | Low |
| I-3 | `axiom suggest-profile` from 7 days of warn journal (proposes hard/ask/exclude rules) | High | M | Med (wrong rules) |
| I-4 | Budget gates: max files / deleted lines per session per hour, `ask` above the threshold | Med | S | Low |
| I-5 | `extends` policy packs (`@codai/axiom-pack-*` or relative files) | High | S–M | Low |
| I-6 | `axiom explain <decision-id>`: human-readable why, which rule, which profile, how to fix | High (DX) | S | Low |
| I-7 | VS Code "AXIOM" extension: gate status bar, decisions tree, doctor/init/undo commands, walkthrough | High (visibility) | M–L | Low |
| I-8 | GitHub Action PR comment: which agent session wrote which files, checks, attestation link | High (teams) | M | Low |
| I-9 | `axiom replay <session>` on a fresh worktree (reproduce or bisect an agent session) | Med | M | Low |
| I-10 | Audit sink: ship decisions + attestations to OTLP / a file rotation with retention, a static HTML report | Med | M | Low |
| I-11 | Kiro + OpenCode adapters (init, format, doctor) | Med | M | Low |
| I-12 | ACP permission adapter (Zed and other ACP clients) | Med | M | Med |
| I-13 | MCP config pinning: hash other servers' tool descriptions, warn on change (rug-pull) | Med | M | Med (scope) |
| I-14 | Per-platform `axiom-hook` via npm optionalDependencies (no separate download) | Med | M | Low |
| I-15 | Authenticode signing for Windows assets (Azure Trusted Signing; costs about USD 10/month) | Med (perf + trust) | M | Low |
| I-16 | One command table → CLI parser + per-verb help + `cli.md` generated + guard | High (kills drift) | M | Low |
| I-17 | Quickstart doc-test in CI (runs the commands and diffs key fields) | Med | M | Low |
| I-18 | Journal retention and redaction: `gc --decisions-older-than`, secret-scan commands and override reasons, hash the username | High (GDPR) | S | Low |
| I-19 | Interactive `axiom init` (harness detect + preview + diff before writing) | Med | S | Low |
| I-20 | Snapshot before an allowed outside-root write, so `undo` covers outside writes too | Med | M | Low |
| I-21 | Weekly stats digest as an agentq note (would-deny trends, override reasons) | Low–Med | S | Low |
| I-22 | Public attestation predicate spec page on the docs site (controlled URI) | Med | S | Low |

Converged recommendation for v3.0: all fixes (P0 plus P1) + I-1, I-2, I-5, I-6, I-16, I-18, I-22,
the Kiro part of I-11, and a first slice of I-7 (status bar + doctor/init commands + `.axm`).
The rest go to a later 3.x.

## 7. Status

Decisions and stories: PLAN.md D-41 onwards and S-1301 onwards (TRACKER.csv). This report records
the state found on 2026-10-19; the tracker is authoritative for progress.
