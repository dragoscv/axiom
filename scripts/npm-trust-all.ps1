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
# `npm trust github ... --loglevel warn` mis-parses `warn` as a positional (EUSAGE); use the env var.
$env:npm_config_loglevel = 'warn'
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
      # Every call (including `trust list`) needs a browser OTP approval: npm prints an auth
      # URL on STDOUT and waits. stdout must stay a TTY — any pipe makes npm non-interactive
      # and it dies with EOTP instead of waiting. Only stderr (where E409 lands) goes to a file.
      $log = Join-Path ([IO.Path]::GetTempPath()) "npm-trust-$([IO.Path]::GetRandomFileName()).log"
      npm trust github $p.name --file $Workflow --repo $Repo --allow-publish --yes 2> $log
      $rc = $LASTEXITCODE
      $text = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
      Remove-Item $log -ErrorAction SilentlyContinue
      if ($rc -ne 0 -and $text -match 'E409|already exists') {
        # Idempotency: a matching relationship is already configured (observed 2026-09-20:
        # 9/9 "failed" while every package was already trusted). That is success.
        Write-Host "   already trusted — nothing to do"
      } elseif ($rc -ne 0) {
        Write-Host "   FAIL trust github ($($p.name))"
        $failed++
        continue
      }
    }
    npm trust list $p.name
  } finally { Pop-Location }
}
if ($failed -gt 0) { Write-Host "$failed package(s) failed"; exit 1 }
Write-Host "trusted publishing configured for $($pkgs.Count) package(s)"
