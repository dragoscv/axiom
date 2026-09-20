<#
.SYNOPSIS
  Enable npm trusted publishing (GitHub Actions OIDC) for every publishable @codai/axiom-*
  package in one go, and print the resulting trust list per package.

.DESCRIPTION
  npm ≥ 12 `npm trust github` is per package and defaults to STAGE-ONLY; release.yml runs
  `changeset publish`, so `--allow-publish` is required or the workflow 404s (the v2.1.0
  partial release). Requires an interactive `npm login` first (web auth); this script never
  reads or prints tokens. Idempotent: an existing identical relationship is reported, not
  duplicated (npm answers 409 → treated as OK).

.EXAMPLE
  npm login
  pwsh -NoProfile -File scripts/npm-trust-all.ps1
  pwsh -NoProfile -File scripts/npm-trust-all.ps1 -ListOnly
#>
param(
  [string]$Repo = 'dragoscv/axiom',
  # npm wants the bare file name under .github/workflows ("must be just a file not a path").
  [string]$Workflow = 'release.yml',
  [switch]$ListOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ignored = @('@codai/axiom-testkit', '@codai/axiom-conformance')

$who = npm whoami 2>$null
if (-not $who) { Write-Error 'not logged in to npm — run `npm login` (web) first'; exit 2 }
Write-Host "npm user: $who"

$pkgs = Get-ChildItem (Join-Path $root 'packages') -Directory | ForEach-Object {
  $pj = Join-Path $_.FullName 'package.json'
  if (-not (Test-Path $pj)) { return }
  $p = Get-Content $pj -Raw | ConvertFrom-Json
  if ($p.private -eq $true) { return }
  if ($ignored -contains $p.name) { return }
  [pscustomobject]@{ name = $p.name; dir = $_.FullName; version = $p.version }
}

$failed = 0
foreach ($p in $pkgs) {
  Write-Host "== $($p.name)@$($p.version)"
  Push-Location $p.dir
  try {
    if (-not $ListOnly) {
      # Every call needs a browser OTP approval (EOTP → npm prints an auth URL and waits).
      # Output must NOT be captured or piped, or the URL never reaches the operator.
      npm trust github $p.name --file $Workflow --repo $Repo --allow-publish --yes --loglevel warn
      if ($LASTEXITCODE -ne 0) {
        Write-Host "   FAIL trust github ($($p.name))"
        $failed++
        continue
      }
    }
    npm trust list $p.name --loglevel warn
  } finally { Pop-Location }
}
if ($failed -gt 0) { Write-Host "$failed package(s) failed"; exit 1 }
Write-Host "trusted publishing configured for $($pkgs.Count) package(s)"
