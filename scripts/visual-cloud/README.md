# visual-cloud — screenshots + axe for the docs site, on a cloud VM

Browser tests never run on the workstation. This runner starts an ephemeral
GCE **spot** VM, captures the docs site there, runs axe, copies the results
back and deletes the VM.

```powershell
# live site (default https://dragoscv.github.io/axiom/)
node scripts/visual-cloud/run.mjs
node scripts/visual-cloud/run.mjs --base https://dragoscv.github.io/axiom/

# a local Astro build, before it is deployed (served on the VM with serve@14.2.6 under /axiom/)
pnpm --filter @codai/axiom-site build
node scripts/visual-cloud/run.mjs --site-dist apps/site/dist
```

Options: `--out <dir>`, `--machine <type>` (default `e2-standard-4`),
`--zone` (default `europe-central2-a`), `--keep` (leave the VM up, debugging only).

## Files

| File | Runs on | Role |
|---|---|---|
| `run.mjs` | workstation | uploads inputs, creates the VM, tails the log, downloads results, deletes the VM in `finally` and proves it |
| `vm-run.sh` | VM (startup script) | installs `playwright@1.64.1` + `@axe-core/playwright@4.14.0` + chromium, optional `serve`, runs `capture.mjs`, uploads results, self-deletes |
| `capture.mjs` | VM | the Playwright "spec": screenshots + axe, writes `report.json` |

No repo dependency is added: Playwright and axe are installed on the VM at
pinned versions (`npm view <pkg> version`, 2026-10-19). Bump the constants at
the top of `run.mjs` to move them.

## What is captured

- Pages: `/`, quickstart, hooks, pipeline, apply, undo, cli, mcp-tools,
  error-codes, profiles, vscode, harnesses, and a 404 path.
- Viewports 390×844, 1440×900, 3440×1440 × themes light and dark
  (`localStorage['starlight-theme']` set by `addInitScript` before load), full page.
- The search dialog open on `/` (Ctrl+K, query `rollback`) at every viewport/theme,
  and the mobile menu open at 390 wide.
- Mermaid diagrams: waits until every `pre.mermaid` / `div.mermaid` holds an SVG (10 s cap).
- axe (`wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`) on every page in both themes at 1440×900;
  `report.json` → `pages[].byImpact` and `summary.violationsByImpact` / `summary.topRules`;
  `summary.md` renders the same as tables (per page × impact, top rules, capture errors).

Results land in `E:\gh\axiom\.copilot-tmp\rc3\visual\<ts>\` (the main clone's
gitignored scratch dir): `screens/*.png`, `report.json`, `summary.md`, `vm.log`.
`run.mjs` gives up after 25 min without the VM's `exit-code` marker.

## Infrastructure (reused from brivio)

Project `brivio-488003`, image family `brivio-e2e-runner`, bucket
`brivio-e2e-runs-brivio-488003` under the prefix `axiom/runs/<id>/`, service
account `brivio-e2e-runner`, zone `europe-central2-a`. The VM gets
`--max-run-duration=1h` and `--instance-termination-action=DELETE` as backstops;
it tries to delete itself at the end, but the `brivio-e2e-runner` SA lacks
`compute.instances.get` (serial log: `Required 'compute.instances.get' permission`),
so the deletion that actually happens is `run.mjs`'s in `finally`, which then checks
`gcloud compute instances list --filter=name=<vm> --format=json` returns `[]`.
No secret travels: the inputs are a config file, `capture.mjs` and the optional
site tarball.

**Cost**: e2-standard-4 spot ≈ 0.04 USD/h plus a 100 GB pd-balanced disk for the
~10–15 min run ≈ 0.01–0.02 USD per run (list prices).

## VS Code extension screenshots (`--vsix`): not supported

Screenshots of `packages/vscode-axm` need a VS Code that renders in a browser
(code-server or `@vscode/test-web`). The brivio image family has no
code-server (checked 2026-10-19: no `code-server` in brivio
`scripts/e2e-cloud/bake-image.sh` or any brivio script), so `--vsix` exits 2
with that message instead of pretending.
