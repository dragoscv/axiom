# Running brivio's repo guards through AXIOM (S-202)

brivio keeps ~40 read-only guards in `scripts/check-*.mjs`, orchestrated by
`scripts/run-guards.mjs` (worker pool, per-guard buffered output, `OK    name` /
`FAIL  name: reason` lines, exit 0/1). AXIOM's `guard.external` predicate
(`docs/checks.md`) lets the same guards veto a manifest **before** `apply`
writes anything, with the bundle on stdin and no shell in between.

Two ways to wire it; the adapter is the recommended one.

## 1. Adapter (recommended) — `scripts/axiom-guard-adapter.mjs` in brivio

brivio's `run-guards.mjs` has no machine-readable mode: it prints a
`FAILED <guard> (exit N, Ns)` header plus the guard's buffered text only for
failures, and a human summary line. Rather than teach it JSON, add a thin
adapter next to it that runs the same guards and emits `GuardOutput`. Nothing
else in brivio changes.

```js
#!/usr/bin/env node
// scripts/axiom-guard-adapter.mjs — run scripts/check-*.mjs and print AXIOM GuardOutput JSON.
// Contract: stdout = one JSON object { ok, findings[] }; exit 0 (verdict is in `ok`).
// stdin carries the JCS ManifestBundle; AXIOM_MANIFEST_DIGEST / AXIOM_ROOT are set by AXIOM.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

const root = process.env.AXIOM_ROOT ?? process.cwd();
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const guards = readdirSync(join(root, "scripts"))
  .filter((f) => f.startsWith("check-") && f.endsWith(".mjs"))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

// Drain stdin so the parent never blocks on a full pipe; the bundle is not needed here.
process.stdin.resume();
process.stdin.on("data", () => {});

const FAIL_LINE = /^FAIL\s+([^:\n]+?)(?::\s*(.*))?$/;

function run(name) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, "scripts", name)],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (err.code ?? 1) : 0;
        const findings = [];
        for (const line of `${stdout ?? ""}`.split(/\r?\n/)) {
          const m = FAIL_LINE.exec(line);
          if (m) findings.push({ id: m[1].trim(), message: (m[2] ?? "").trim() || "guard failed" });
        }
        if (code !== 0 && findings.length === 0) {
          findings.push({
            id: name.replace(/^check-|\.mjs$/g, ""),
            message: `exit ${code}`,
            facts: { stderr: `${stderr ?? ""}`.slice(-4096) },
          });
        }
        resolve(findings);
      },
    );
  });
}

const limit = Math.max(2, Math.min(guards.length, Number(process.env.GUARD_CONCURRENCY) || Math.min(16, cpus().length)));
const queue = [...guards];
const all = [];
await Promise.all(
  Array.from({ length: limit }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) all.push(...(await run(next)));
  }),
);
all.sort((a, b) => a.id.localeCompare(b.id));
process.stdout.write(JSON.stringify({ ok: all.length === 0, findings: all }));
```

Profile (`E:\gh\brivio\.axiom\profiles\brivio.json`):

```json
{
  "apiVersion": "axiom.dev/v2",
  "kind": "Profile",
  "name": "brivio",
  "extends": "strict",
  "facts": { "allowRepo": true, "allowGuards": true },
  "checks": [
    {
      "id": "brivio.guards",
      "predicate": "guard.external",
      "params": {
        "command": "scripts/axiom-guard-adapter.mjs",
        "timeoutMs": 60000,
        "stdin": "bundle",
        "env": { "GUARD_CONCURRENCY": "8" }
      },
      "severity": "error"
    }
  ]
}
```

Start the server with guards enabled (they are off by default even with the
profile above):

```
npx @codai/axiom-mcp mcp --root E:\gh\brivio --allow-guards
axiom check bundle.json --root E:\gh\brivio --profile brivio --allow-guards
```

Every `FAIL  <name>: <reason>` line any brivio guard prints becomes an `error`
finding `{ id: "<name>", message: "<reason>", predicate: "guard.external" }`
in the `CheckReport`; a guard that dies without a `FAIL` line becomes
`{ id: "<guard>", message: "exit N", facts.stderr }`. `ok: true` with no
findings → `verdict: pass`.

Notes:

- `timeoutMs` max is 60 s; brivio's full suite measured ~42–46 s on a 32-core
  box, so restrict with `args: ["vacuous", "action-pins"]` or a per-call
  `GUARD_CONCURRENCY` if it gets close. A timeout is `ERR_GUARD_TIMEOUT` →
  `verdict: error`, never a silent pass.
- The adapter always exits 0; the verdict travels in `ok`. AXIOM also accepts
  exit ≠ 0 with valid JSON, so either is fine.
- The child sees only `PATH/HOME/USERPROFILE/SYSTEMROOT/TEMP/TMP/…` plus
  `params.env` and `AXIOM_*`. Guards that need `.env` values must read the
  file themselves — nothing from the agent's environment leaks in.

## 2. Without an adapter — `legacyText: true`

A single brivio guard can be pointed at directly; its `OK`/`FAIL` lines are
parsed by AXIOM when `legacyText` is on:

```json
{
  "id": "brivio.vacuous",
  "predicate": "guard.external",
  "params": { "command": "scripts/check-vacuous-assertions.mjs", "legacyText": true, "stdin": "none" }
}
```

This is per-guard (one CheckRef each; they run in AXIOM's `min(4, cpus)` pool)
and depends on the text format staying stable, which is why the adapter is
preferred for the whole suite. `run-guards.mjs` itself is **not** usable this
way: it prints `FAILED name (exit N)` headers, not `FAIL  name:` lines.

## What brivio's runner would need to emit natively (alternative to the adapter)

If `run-guards.mjs` grows a `--json` flag instead, it must print exactly one
object matching AXIOM's `GuardOutputSchema` and nothing else on stdout:

```json
{ "ok": false,
  "findings": [
    { "id": "vacuous-assertions", "severity": "error", "message": "tests/x.test.ts:12 always-true", "path": "tests/x.test.ts" }
  ] }
```

`severity` defaults to `error` when `ok` is false; `path` must be a
repo-relative POSIX path (otherwise it is kept under `facts.rawPath`).
