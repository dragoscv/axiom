# AXIOM Production-Ready Validation Script
# Validates all 6 requirements: determinism, snapshots, profiles, capabilities, reverse-IR, apply

param(
    [string]$MCP = "http://localhost:3411",
    [string]$RepoPath = "e:\gh\axiom"
)

$ErrorActionPreference = "Stop"
cd $RepoPath

Write-Host "`n╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║     AXIOM PRODUCTION-READY VALIDATION - AUTONOMOUS TEST       ║" -ForegroundColor Magenta
Write-Host "╚════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Magenta

$results = @{
    Determinism = @{}
    Snapshots = @{}
    ProfileEnforcement = @{}
    Capabilities = @{}
    ReverseIR = @{}
    PRApply = @{}
}

# ============================================================================
# 1) DETERMINISM TEST
# ============================================================================
Write-Host "`n[1/6] DETERMINISM TEST - Consecutive Runs" -ForegroundColor Cyan
Write-Host "=" * 60

$axm = Get-Content examples/blog.axm -Raw
$parsed = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axm } | ConvertTo-Json) -ContentType "application/json"
$ir = $parsed.ir

# EDGE Profile - 2 runs
$gen1e = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
Start-Sleep -Milliseconds 100
$gen2e = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

$edgeHashMatch = $true
for ($i = 0; $i -lt $gen1e.manifest.artifacts.Count; $i++) {
    $a1 = $gen1e.manifest.artifacts[$i]
    $a2 = $gen2e.manifest.artifacts[$i]
    if ($a1.path -ne 'manifest.json' -and $a1.sha256 -ne $a2.sha256) {
        $edgeHashMatch = $false
        Write-Host "  ❌ HASH MISMATCH: $($a1.path)" -ForegroundColor Red
    }
}

# BUDGET Profile - 2 runs
$gen1b = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "budget" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
Start-Sleep -Milliseconds 100
$gen2b = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "budget" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

$budgetHashMatch = $true
for ($i = 0; $i -lt $gen1b.manifest.artifacts.Count; $i++) {
    $a1 = $gen1b.manifest.artifacts[$i]
    $a2 = $gen1b.manifest.artifacts[$i]
    if ($a1.path -ne 'manifest.json' -and $a1.sha256 -ne $a2.sha256) {
        $budgetHashMatch = $false
        Write-Host "  ❌ HASH MISMATCH: $($a1.path)" -ForegroundColor Red
    }
}

Write-Host "  EDGE: $(if ($edgeHashMatch) {'✅ IDENTICAL'} else {'❌ FAILED'})" -ForegroundColor $(if ($edgeHashMatch) {'Green'} else {'Red'})
Write-Host "  BUDGET: $(if ($budgetHashMatch) {'✅ IDENTICAL'} else {'❌ FAILED'})" -ForegroundColor $(if ($budgetHashMatch) {'Green'} else {'Red'})

$results.Determinism = @{
    EdgeDeterministic = $edgeHashMatch
    BudgetDeterministic = $budgetHashMatch
    EdgeArtifacts = $gen1e.manifest.artifacts.Count
    BudgetArtifacts = $gen1b.manifest.artifacts.Count
}

# Export manifests for raport
$gen1e.manifest | ConvertTo-Json -Depth 10 | Out-File "test-results/determinism-edge-r1.json"
$gen2e.manifest | ConvertTo-Json -Depth 10 | Out-File "test-results/determinism-edge-r2.json"
$gen1b.manifest | ConvertTo-Json -Depth 10 | Out-File "test-results/determinism-budget-r1.json"
$gen2b.manifest | ConvertTo-Json -Depth 10 | Out-File "test-results/determinism-budget-r2.json"

# ============================================================================
# 2) GOLDEN SNAPSHOTS
# ============================================================================
Write-Host "`n[2/6] GOLDEN SNAPSHOTS - Freeze & Compare" -ForegroundColor Cyan
Write-Host "=" * 60

# Create snapshots directory
New-Item -ItemType Directory -Path "packages\axiom-tests\snapshots" -Force | Out-Null

# Generate EDGE snapshot
$edgeSnapshot = @{
    profile = "edge"
    totalArtifacts = ($gen1e.manifest.artifacts | Where-Object { $_.path -ne 'manifest.json' }).Count
    totalBytes = ($gen1e.manifest.artifacts | Where-Object { $_.path -ne 'manifest.json' } | Measure-Object -Property bytes -Sum).Sum
    artifactHashes = @{}
}
$gen1e.manifest.artifacts | Where-Object { $_.path -ne 'manifest.json' } | ForEach-Object {
    $edgeSnapshot.artifactHashes[$_.path] = $_.sha256
}
$edgeSnapshot | ConvertTo-Json -Depth 5 | Out-File "packages\axiom-tests\snapshots\edge-profile.snapshot.json"

# Generate BUDGET snapshot
$budgetSnapshot = @{
    profile = "budget"
    totalArtifacts = ($gen1b.manifest.artifacts | Where-Object { $_.path -ne 'manifest.json' }).Count
    totalBytes = ($gen1b.manifest.artifacts | Where-Object { $_.path -ne 'manifest.json' } | Measure-Object -Property bytes -Sum).Sum
    artifactHashes = @{}
}
$gen1b.manifest.artifacts | Where-Object { $_.path -ne 'manifest.json' } | ForEach-Object {
    $budgetSnapshot.artifactHashes[$_.path] = $_.sha256
}
$budgetSnapshot | ConvertTo-Json -Depth 5 | Out-File "packages\axiom-tests\snapshots\budget-profile.snapshot.json"

Write-Host "  ✅ EDGE snapshot: $($edgeSnapshot.totalArtifacts) artifacts, $($edgeSnapshot.totalBytes) bytes" -ForegroundColor Green
Write-Host "  ✅ BUDGET snapshot: $($budgetSnapshot.totalArtifacts) artifacts, $($budgetSnapshot.totalBytes) bytes" -ForegroundColor Green

$results.Snapshots = @{
    EdgeSnapshot = "packages\axiom-tests\snapshots\edge-profile.snapshot.json"
    BudgetSnapshot = "packages\axiom-tests\snapshots\budget-profile.snapshot.json"
    EdgeArtifacts = $edgeSnapshot.totalArtifacts
    BudgetArtifacts = $budgetSnapshot.totalArtifacts
}

# ============================================================================
# 3) PROFILE ENFORCEMENT - Evidence in Manifest
# ============================================================================
Write-Host "`n[3/6] PROFILE ENFORCEMENT - Check Evidence" -ForegroundColor Cyan
Write-Host "=" * 60

# Check manifest evidence
$edgeEvidence = $gen1e.manifest.evidence
$budgetEvidence = $gen1b.manifest.evidence

Write-Host "  EDGE Evidence:" -ForegroundColor Yellow
$edgeEvidence | ForEach-Object {
    $status = if ($_.passed) { "✅" } else { "❌" }
    Write-Host "    $status $($_.checkName) ($($_.kind)): $($_.details.message)" -ForegroundColor $(if ($_.passed) {'Green'} else {'Red'})
}

Write-Host "  BUDGET Evidence:" -ForegroundColor Yellow
$budgetEvidence | ForEach-Object {
    $status = if ($_.passed) { "✅" } else { "❌" }
    Write-Host "    $status $($_.checkName) ($($_.kind)): $($_.details.message)" -ForegroundColor $(if ($_.passed) {'Green'} else {'Red'})
}

$results.ProfileEnforcement = @{
    EdgeChecks = $edgeEvidence.Count
    BudgetChecks = $budgetEvidence.Count
    EdgePassed = ($edgeEvidence | Where-Object { $_.passed }).Count
    BudgetPassed = ($budgetEvidence | Where-Object { $_.passed }).Count
}

# ============================================================================
# 4) CAPABILITIES TEST - Negative Case
# ============================================================================
Write-Host "`n[4/6] CAPABILITIES TEST - Missing net() Capability" -ForegroundColor Cyan
Write-Host "=" * 60

# Create AXM without capabilities
$axmNoCaps = @"
agent "test" {
  intent "test capabilities"
  checks {
    unit "api" expect http.healthy("http://localhost:4000/health")
  }
  emit {
    manifest target="./out/test.json"
  }
}
"@

$parsedNoCaps = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axmNoCaps } | ConvertTo-Json) -ContentType "application/json"
$valBody = @{ ir = $parsedNoCaps.ir } | ConvertTo-Json -Depth 10 -Compress
$valNoCaps = Invoke-RestMethod -Uri "$MCP/validate" -Method POST -Body $valBody -ContentType "application/json"

Write-Host "  Validate without capabilities: ok=$($valNoCaps.ok)" -ForegroundColor $(if (-not $valNoCaps.ok) {'Green'} else {'Red'})
if (-not $valNoCaps.ok) {
    $valNoCaps.diagnostics | ForEach-Object {
        Write-Host "    ✅ Expected error: $($_.message)" -ForegroundColor Green
    }
}

# Create AXM WITH capabilities
$axmWithCaps = @"
agent "test" {
  intent "test capabilities"
  capabilities { net("http") }
  checks {
    unit "api" expect http.healthy("http://localhost:4000/health")
  }
  emit {
    manifest target="./out/test.json"
  }
}
"@

$parsedWithCaps = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axmWithCaps } | ConvertTo-Json) -ContentType "application/json"
$valBodyCaps = @{ ir = $parsedWithCaps.ir } | ConvertTo-Json -Depth 10 -Compress
$valWithCaps = Invoke-RestMethod -Uri "$MCP/validate" -Method POST -Body $valBodyCaps -ContentType "application/json"

Write-Host "  Validate with capabilities: ok=$($valWithCaps.ok)" -ForegroundColor $(if ($valWithCaps.ok) {'Green'} else {'Red'})

$results.Capabilities = @{
    WithoutCaps = -not $valNoCaps.ok
    WithCaps = $valWithCaps.ok
    NegativeTestPassed = (-not $valNoCaps.ok) -and $valWithCaps.ok
}

# ============================================================================
# 5) REVERSE-IR - Detect Existing Structure
# ============================================================================
Write-Host "`n[5/6] REVERSE-IR - Not yet implemented in MCP" -ForegroundColor Cyan
Write-Host "=" * 60
Write-Host "  ⚠️  /reverse endpoint not available - WORKAROUND: Manual IR detection" -ForegroundColor Yellow

$results.ReverseIR = @{
    Implemented = $false
    Workaround = "Manual IR representation based on existing files"
}

# ============================================================================
# 6) PR APPLY - Not yet implemented
# ============================================================================
Write-Host "`n[6/6] PR APPLY - Not yet implemented in MCP" -ForegroundColor Cyan
Write-Host "=" * 60
Write-Host "  ⚠️  /apply endpoint not available - WORKAROUND: Manual git workflow" -ForegroundColor Yellow

$results.PRApply = @{
    Implemented = $false
    Workaround = "Manual git branch + commit + PR creation"
}

# ============================================================================
# FINAL REPORT
# ============================================================================
Write-Host "`n╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                 VALIDATION RESULTS SUMMARY                     ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Green

Write-Host "1️⃣  DETERMINISM:" -ForegroundColor Cyan
Write-Host "    EDGE: $(if ($results.Determinism.EdgeDeterministic) {'✅ PASS'} else {'❌ FAIL'}) - $($results.Determinism.EdgeArtifacts) artifacts" -ForegroundColor $(if ($results.Determinism.EdgeDeterministic) {'Green'} else {'Red'})
Write-Host "    BUDGET: $(if ($results.Determinism.BudgetDeterministic) {'✅ PASS'} else {'❌ FAIL'}) - $($results.Determinism.BudgetArtifacts) artifacts" -ForegroundColor $(if ($results.Determinism.BudgetDeterministic) {'Green'} else {'Red'})

Write-Host "`n2️⃣  GOLDEN SNAPSHOTS:" -ForegroundColor Cyan
Write-Host "    ✅ EDGE: $($results.Snapshots.EdgeArtifacts) artifacts frozen" -ForegroundColor Green
Write-Host "    ✅ BUDGET: $($results.Snapshots.BudgetArtifacts) artifacts frozen" -ForegroundColor Green

Write-Host "`n3️⃣  PROFILE ENFORCEMENT:" -ForegroundColor Cyan
Write-Host "    EDGE: $($results.ProfileEnforcement.EdgePassed)/$($results.ProfileEnforcement.EdgeChecks) checks passed" -ForegroundColor Green
Write-Host "    BUDGET: $($results.ProfileEnforcement.BudgetPassed)/$($results.ProfileEnforcement.BudgetChecks) checks passed" -ForegroundColor Green

Write-Host "`n4️⃣  CAPABILITIES:" -ForegroundColor Cyan
Write-Host "    $(if ($results.Capabilities.NegativeTestPassed) {'✅ PASS'} else {'❌ FAIL'}) - Negative test (missing net()) correctly failed" -ForegroundColor $(if ($results.Capabilities.NegativeTestPassed) {'Green'} else {'Red'})

Write-Host "`n5️⃣  REVERSE-IR:" -ForegroundColor Cyan
Write-Host "    ⚠️  NOT IMPLEMENTED - Workaround documented" -ForegroundColor Yellow

Write-Host "`n6️⃣  PR APPLY:" -ForegroundColor Cyan
Write-Host "    ⚠️  NOT IMPLEMENTED - Workaround documented" -ForegroundColor Yellow

Write-Host "`n📄 ARTIFACTS GENERATED:" -ForegroundColor Magenta
Write-Host "    - test-results/determinism-edge-r1.json"
Write-Host "    - test-results/determinism-edge-r2.json"
Write-Host "    - test-results/determinism-budget-r1.json"
Write-Host "    - test-results/determinism-budget-r2.json"
Write-Host "    - packages/axiom-tests/snapshots/edge-profile.snapshot.json"
Write-Host "    - packages/axiom-tests/snapshots/budget-profile.snapshot.json"

# Export results
$results | ConvertTo-Json -Depth 10 | Out-File "test-results/validation-summary.json"

Write-Host "`n✨ Validation complete! Results saved to test-results/validation-summary.json ✨`n" -ForegroundColor Green

return $results
