<#
.SYNOPSIS
  One-time bootstrap of the @codai/axiom-hook-<platform> npm packages (S-1318).

.DESCRIPTION
  npm trusted publishing (OIDC) can only be configured on a package that already exists.
  This publishes ONE placeholder version (0.0.0-bootstrap.0, dist-tag `bootstrap`, never
  `latest`) of each hook package from a logged-in terminal, deprecates it, and then runs
  npm-trust-all.ps1 -Only axiom-hook- so release.yml can publish the real binaries.
  Run it WITHOUT piping output (npm's browser-auth prompt must be visible).
  Idempotent: a placeholder already on the registry is skipped.

.EXAMPLE
  npm login
  pwsh -NoProfile -File scripts/bootstrap-hook-packages.ps1            # dry run
  pwsh -NoProfile -File scripts/bootstrap-hook-packages.ps1 -Publish   # real
#>
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$who = npm whoami 2>$null
if (-not $who) { throw 'Not logged in to npm. Run "npm login" first.' }
Write-Host "npm user: $who"
$version = '0.0.0-bootstrap.0'
$dirs = Get-ChildItem packages -Directory | Where-Object { $_.Name -like 'axiom-hook-*' }
foreach ($d in $dirs) {
  $pkg = Get-Content (Join-Path $d.FullName 'package.json') -Raw | ConvertFrom-Json
  $name = $pkg.name
  $exists = npm view "$name@$version" version 2>$null
  if ($exists) { Write-Host "skip  $name@$version (already published)"; continue }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("axiom-hook-boot-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $placeholder = [ordered]@{
      name        = $name
      version     = $version
      description = "Placeholder for trusted-publishing setup; real binaries ship from release.yml."
      license     = 'MIT'
      repository  = $pkg.repository
      os          = $pkg.os
      cpu         = $pkg.cpu
    }
    [IO.File]::WriteAllText((Join-Path $tmp 'package.json'), ($placeholder | ConvertTo-Json -Depth 5))
    [IO.File]::WriteAllText((Join-Path $tmp 'README.md'), "Placeholder. Install @codai/axiom-mcp instead.`n")
    if (-not $Publish) { Write-Host "would publish $name@$version (tag bootstrap)"; continue }
    Push-Location $tmp
    try { npm publish --access public --tag bootstrap } finally { Pop-Location }
    npm deprecate "$name@$version" 'bootstrap placeholder; use the version that matches @codai/axiom-mcp'
  } finally {
    Remove-Item -Recurse -Force $tmp
  }
}
if ($Publish) {
  pwsh -NoProfile -File (Join-Path $PSScriptRoot 'npm-trust-all.ps1') -Only 'axiom-hook-'
}
