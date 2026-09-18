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

.EXAMPLE
  pwsh -NoProfile -File scripts/release-bootstrap.ps1            # dry run (default)
  pwsh -NoProfile -File scripts/release-bootstrap.ps1 -Publish   # real publish
#>
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$order = @('schema', 'canon', 'plan', 'checks', 'apply', 'axm', 'mcp')

if (-not $Publish) { Write-Host "DRY RUN (pass -Publish to publish). Checking registry state..." }
$who = npm whoami 2>$null
if (-not $who) { throw 'Not logged in to npm. Run "npm login" first.' }
Write-Host "npm user: $who"

pnpm build | Out-Null
node scripts/run-guards.mjs --quiet
if ($LASTEXITCODE -ne 0) { throw "guards failed; not publishing" }

foreach ($p in $order) {
  $dir = Join-Path 'packages' $p
  $pkg = Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json
  $name = $pkg.name; $ver = $pkg.version
  $live = npm view "$name@$ver" version 2>$null
  if ($live) { Write-Host "skip  $name@$ver (already published)"; continue }
  if ($Publish) {
    Write-Host "publish $name@$ver"
    pnpm --filter $name publish --access public --no-git-checks
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $name" }
  } else {
    Write-Host "would publish $name@$ver"
  }
}

if ($Publish) {
  Write-Host ""
  Write-Host "Next: on npmjs.com, for EACH package -> Settings -> Trusted publishing -> GitHub Actions:"
  Write-Host "  owner dragoscv, repo axiom, workflow release.yml, allow 'npm publish'."
  Write-Host "Then future tags v* publish via CI with provenance."
}
