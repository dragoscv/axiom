#Requires -Version 5.1
<#
.SYNOPSIS
  AXIOM installer for Windows - downloads axiom-win-x64.exe from the GitHub release, verifies it
  against SHA256SUMS and installs it to %LOCALAPPDATA%\axiom\bin (added to the user PATH).

.EXAMPLE
  irm https://dragoscv.github.io/axiom/install.ps1 | iex

.EXAMPLE
  $env:AXIOM_VERSION = 'v2.2.1'; irm https://dragoscv.github.io/axiom/install.ps1 | iex
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'dragoscv/axiom'
$Version = if ($env:AXIOM_VERSION) { $env:AXIOM_VERSION } else { 'latest' }
$InstallDir = if ($env:AXIOM_INSTALL_DIR) { $env:AXIOM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'axiom\bin' }
$Asset = 'axiom-win-x64.exe'

function Write-Step([string]$Message) { Write-Host "axiom-install: $Message" }
function Fail([string]$Message) { Write-Error "axiom-install: error: $Message"; exit 1 }

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'only 64-bit Windows is supported; use: npx @codai/axiom-mcp' }
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Write-Step 'ARM64 detected - installing the x64 binary (runs under emulation)' }

$headers = @{ 'User-Agent' = 'axiom-install.ps1' }
if ($Version -eq 'latest') {
  Write-Step 'resolving latest release'
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  } catch {
    Fail "could not resolve the latest release ($($_.Exception.Message)). Set `$env:AXIOM_VERSION = 'vX.Y.Z' and retry."
  }
  $Tag = $release.tag_name
  if (-not $Tag) { Fail 'GitHub API returned no tag_name' }
} else {
  $Tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
}

$Base = "https://github.com/$Repo/releases/download/$Tag"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('axiom-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

try {
  Write-Step "downloading $Asset ($Tag)"
  try {
    Invoke-WebRequest -Uri "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset) -Headers $headers -UseBasicParsing
    Invoke-WebRequest -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp 'SHA256SUMS') -Headers $headers -UseBasicParsing
  } catch {
    Fail "download failed: $($_.Exception.Message) (does release $Tag ship $Asset?)"
  }

  $pattern = '\s\*?' + [regex]::Escape($Asset) + '$'
  $line = Get-Content (Join-Path $Tmp 'SHA256SUMS') | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) { Fail "$Asset is not listed in SHA256SUMS for $Tag" }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $Tmp $Asset)).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail "checksum mismatch for $Asset - expected $expected, got $actual - refusing to install" }
  Write-Step 'checksum verified'

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $Target = Join-Path $InstallDir 'axiom.exe'
  Move-Item -Path (Join-Path $Tmp $Asset) -Destination $Target -Force
  Write-Step "installed to $Target"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  $onUserPath = ($userPath -split ';' | Where-Object { $_ }) -contains $InstallDir
  if (-not $onUserPath) {
    $newPath = if ($userPath.Trim()) { $userPath.TrimEnd(';') + ';' + $InstallDir } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Step "added $InstallDir to the user PATH (open a new terminal to pick it up)"
  }
  if (-not (($env:Path -split ';') -contains $InstallDir)) { $env:Path = "$env:Path;$InstallDir" }

  & $Target --version
  Write-Step "done. Verify provenance with: gh attestation verify $Target --repo $Repo"
} finally {
  Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
