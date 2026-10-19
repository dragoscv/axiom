<#
.SYNOPSIS
  I-21: post a one-line weekly AXIOM gate summary per repo to the agentq journal.

.DESCRIPTION
  Runs `axiom stats --json --since <Days>d --root <repo>` for every repo and posts ONE agentq note:
    axiom weekly (7d): brivio 812 (deny 14, ask 3, relaxed 22, p95 41 ms) | codai ...
  Only counts and latency are posted: no paths, commands, reasons or user names.
  Does not register a scheduled task; wire it yourself if you want it weekly.

.EXAMPLE
  pwsh -NoProfile -File scripts/weekly-stats-note.ps1 -Repos E:\gh\brivio,E:\gh\codai
  pwsh -NoProfile -File scripts/weekly-stats-note.ps1 -Repos E:\gh\axiom -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Repos,
  [ValidateRange(1, 366)][int]$Days = 7,
  [string]$Axiom = 'axiom',
  [string]$AgentQ = (Join-Path $env:USERPROFILE '.copilot\bin\agentq.ps1'),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Get-RepoSummary {
  param([string]$Repo)
  $name = Split-Path -Leaf $Repo
  if (-not (Test-Path -LiteralPath $Repo -PathType Container)) { return "$name n/a (missing)" }
  $raw = & $Axiom stats --json --since "$($Days)d" --root $Repo 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return "$name n/a (stats exit $LASTEXITCODE)" }
  try { $s = ($raw -join "`n") | ConvertFrom-Json } catch { return "$name n/a (bad json)" }
  $d = $s.decisions
  $p95 = if ($null -eq $d.p95) { '-' } else { "$($d.p95) ms" }
  $alarms = @($s.alarms).Count
  $alarmText = if ($alarms -gt 0) { ", alarms $alarms" } else { '' }
  return "$name $($d.total) (deny $($d.deny), ask $($d.ask), relaxed $($d.relaxed), p95 $p95$alarmText)"
}

$parts = foreach ($r in $Repos) { Get-RepoSummary -Repo $r }
$message = "axiom weekly ($($Days)d): " + ($parts -join ' | ')
# ASCII only: agentq notes land in a JSONL journal read by many tools.
$message = $message -replace '[^\x20-\x7E]', '?'

if ($DryRun) {
  Write-Output $message
  exit 0
}
if (-not (Test-Path -LiteralPath $AgentQ)) {
  Write-Error "agentq not found at $AgentQ"
  exit 1
}
& $AgentQ note -Message $message
exit $LASTEXITCODE
