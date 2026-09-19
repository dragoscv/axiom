<#
.SYNOPSIS
  One-time first publish of the @codai/axiom-* v2 packages from a logged-in terminal.

.DESCRIPTION
  npm trusted publishing (OIDC) is configured PER PACKAGE on npmjs.com, so it cannot
  authorize a package that does not exist yet. Release run 35322058007 failed with 404 for
  exactly that reason. Run this ONCE, interactively, after `npm login` (2FA prompt will
  appear). Every later release goes through .github/workflows/release.yml.

  Publishes in dependency order so `workspace:*` (rewritten to exact versions by pnpm)
  always resolves. Idempotent: skips versions already on the registry.

  -Missing: repair mode. Publishes ONLY the packages whose current package.json version is
  absent from the registry (e.g. after a partial CI release such as v2.1.0, where trusted
  publishing was enabled for 2 of 9 packages). Same dependency order; no version bump.

.EXAMPLE
  pwsh -NoProfile -File scripts/release-bootstrap.ps1            # dry run (default)
  pwsh -NoProfile -File scripts/release-bootstrap.ps1 -Publish   # real publish
  pwsh -NoProfile -File scripts/release-bootstrap.ps1 -Publish -Missing   # repair partial release
#>
param([switch]$Publish, [switch]$Missing)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# Dependency order: every package after its @codai/axiom-* dependencies.
$order = @('schema', 'canon', 'plan', 'checks', 'apply', 'axm', 'axm-lsp', 'emitters-web', 'mcp')

$mode = if ($Missing) { 'REPAIR (-Missing)' } else { 'BOOTSTRAP' }
if (-not $Publish) { Write-Host "$mode DRY RUN (pass -Publish to publish). Checking registry state..." }
else { Write-Host "$mode publish" }
$who = npm whoami 2>$null
if (-not $who) { throw 'Not logged in to npm. Run "npm login" first.' }
Write-Host "npm user: $who"

pnpm build | Out-Null
node scripts/run-guards.mjs --quiet
if ($LASTEXITCODE -ne 0) { throw "guards failed; not publishing" }

$published = @()
foreach ($p in $order) {
  $dir = Join-Path 'packages' $p
  $pkg = Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.private) { continue }
  $name = $pkg.name; $ver = $pkg.version
  if ($Missing) {
    # Repair mode only re-publishes a version that was already RELEASED (tagged); never
    # pushes an in-progress version from the working tree.
    $tag = git tag -l "v$ver"
    if (-not $tag) { throw "repair: tag v$ver does not exist for $name - not a released version" }
  }
  $live = npm view "$name@$ver" version 2>$null
  if ($live) { Write-Host "skip  $name@$ver (already published)"; continue }
  if ($Publish) {
    Write-Host "publish $name@$ver"
    pnpm --filter $name publish --access public --no-git-checks
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $name" }
    $published += "$name@$ver"
  } else {
    Write-Host "would publish $name@$ver"
  }
}

if ($Publish) {
  Write-Host ""
  Write-Host "published: $($published.Count) -> $($published -join ', ')"
  Write-Host "Next: on npmjs.com, for EACH package -> Settings -> Trusted publishing -> GitHub Actions:"
  Write-Host "  owner dragoscv, repo axiom, workflow release.yml, allow 'npm publish'."
  Write-Host "  CLI: npm trust github --file .github/workflows/release.yml --allow-publish (run inside each package dir)."
  Write-Host "Then future tags v* publish via CI with provenance."
}
