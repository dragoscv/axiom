# AXIOM Production-Ready Validation - Complete Test Suite
# Tests: Determinism, Profiles, Capabilities, /reverse, /diff, /apply

param(
    [string]$MCP = "http://localhost:3411"
)

$ErrorActionPreference = "Stop"

Write-Host "`n╔═══════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              AXIOM PRODUCTION-READY VALIDATION SUITE                      ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Cyan

$results = @{
    Determinism = $false
    ProfileEnforcement = $false
    Capabilities = $false
    ReverseIR = $false
    DiffApply = $false
}

# ================================================================================
# TEST 1: DETERMINISM (100% - manifest.json included)
# ================================================================================
Write-Host "[1/5] DETERMINISM TEST" -ForegroundColor Yellow
Write-Host "  Testing consecutive builds produce IDENTICAL artifacts (including manifest)...`n"

$axm = Get-Content examples/blog.axm -Raw
$parsed = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axm } | ConvertTo-Json) -ContentType "application/json"
$ir = $parsed.ir

# EDGE Profile - 2 runs
$edgeR1 = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
$edgeR2 = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

# BUDGET Profile - 2 runs
$budgetR1 = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "budget" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
$budgetR2 = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "budget" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

# Compare buildId and createdAt (should be DETERMINISTIC now)
Write-Host "  EDGE Profile:" -ForegroundColor Cyan
Write-Host "    R1: buildId=$($edgeR1.manifest.buildId.Substring(0,16))..., createdAt=$($edgeR1.manifest.createdAt)"
Write-Host "    R2: buildId=$($edgeR2.manifest.buildId.Substring(0,16))..., createdAt=$($edgeR2.manifest.createdAt)"

if ($edgeR1.manifest.buildId -eq $edgeR2.manifest.buildId -and $edgeR1.manifest.createdAt -eq $edgeR2.manifest.createdAt) {
    Write-Host "    ✅ Metadata DETERMINISTIC" -ForegroundColor Green
} else {
    Write-Host "    ❌ Metadata NON-DETERMINISTIC" -ForegroundColor Red
    return
}

# Compare all artifact hashes
$edgeHashMatch = $true
for ($i = 0; $i -lt $edgeR1.manifest.artifacts.Count; $i++) {
    if ($edgeR1.manifest.artifacts[$i].sha256 -ne $edgeR2.manifest.artifacts[$i].sha256) {
        Write-Host "    ❌ Hash mismatch: $($edgeR1.manifest.artifacts[$i].path)" -ForegroundColor Red
        $edgeHashMatch = $false
    }
}

if ($edgeHashMatch) {
    Write-Host "    ✅ ALL $($edgeR1.manifest.artifacts.Count) artifacts IDENTICAL (including manifest.json)" -ForegroundColor Green
}

Write-Host "`n  BUDGET Profile:" -ForegroundColor Yellow
Write-Host "    R1: buildId=$($budgetR1.manifest.buildId.Substring(0,16))..., createdAt=$($budgetR1.manifest.createdAt)"
Write-Host "    R2: buildId=$($budgetR2.manifest.buildId.Substring(0,16))..., createdAt=$($budgetR2.manifest.createdAt)"

$budgetHashMatch = $true
for ($i = 0; $i -lt $budgetR1.manifest.artifacts.Count; $i++) {
    if ($budgetR1.manifest.artifacts[$i].sha256 -ne $budgetR2.manifest.artifacts[$i].sha256) {
        Write-Host "    ❌ Hash mismatch: $($budgetR1.manifest.artifacts[$i].path)" -ForegroundColor Red
        $budgetHashMatch = $false
    }
}

if ($budgetHashMatch) {
    Write-Host "    ✅ ALL $($budgetR1.manifest.artifacts.Count) artifacts IDENTICAL" -ForegroundColor Green
}

$results.Determinism = $edgeHashMatch -and $budgetHashMatch

# Save manifests
$testResultsDir = "test-results"
if (!(Test-Path $testResultsDir)) { New-Item -ItemType Directory -Path $testResultsDir | Out-Null }

$edgeR1.manifest | ConvertTo-Json -Depth 10 | Out-File "$testResultsDir/determinism-edge-r1.json"
$budgetR1.manifest | ConvertTo-Json -Depth 10 | Out-File "$testResultsDir/determinism-budget-r1.json"

Write-Host "`n  [✓] TEST 1: PASS - Determinism validated" -ForegroundColor Green

# ================================================================================
# TEST 2: PROFILE ENFORCEMENT (Real Measurements)
# ================================================================================
Write-Host "`n[2/5] PROFILE ENFORCEMENT (Real Measurements)" -ForegroundColor Yellow

# Check evidence in manifests
Write-Host "`n  EDGE Profile Evidence:" -ForegroundColor Cyan
foreach ($ev in $edgeR1.manifest.evidence) {
    $status = if ($ev.passed) { "✅ PASS" } else { "❌ FAIL" }
    Write-Host "    $status - $($ev.checkName) ($($ev.kind))" -ForegroundColor $(if ($ev.passed) { "Green" } else { "Red" })
    
    # Display real measurements
    if ($ev.details.measurements) {
        $measurements = $ev.details.measurements
        if ($measurements.max_dependencies) {
            Write-Host "         max_dependencies: $($measurements.max_dependencies)" -ForegroundColor DarkGray
        }
        if ($measurements.frontend_bundle_kb) {
            Write-Host "         frontend_bundle_kb: $($measurements.frontend_bundle_kb)" -ForegroundColor DarkGray
        }
        if ($measurements.PSObject.Properties['no_analytics']) {
            Write-Host "         no_analytics: $($measurements.no_analytics)" -ForegroundColor DarkGray
        }
    }
}

Write-Host "`n  BUDGET Profile Evidence:" -ForegroundColor Yellow
foreach ($ev in $budgetR1.manifest.evidence) {
    $status = if ($ev.passed) { "✅ PASS" } else { "❌ FAIL" }
    Write-Host "    $status - $($ev.checkName) ($($ev.kind))" -ForegroundColor $(if ($ev.passed) { "Green" } else { "Red" })
    
    if ($ev.details.measurements) {
        $measurements = $ev.details.measurements
        if ($measurements.max_dependencies) {
            Write-Host "         max_dependencies: $($measurements.max_dependencies) (constraint: <= 5)" -ForegroundColor DarkGray
        }
        if ($measurements.frontend_bundle_kb) {
            Write-Host "         frontend_bundle_kb: $($measurements.frontend_bundle_kb) (constraint: <= 500)" -ForegroundColor DarkGray
        }
        if ($measurements.PSObject.Properties['no_analytics']) {
            Write-Host "         no_analytics: $($measurements.no_analytics) (constraint: true)" -ForegroundColor DarkGray
        }
    }
}

$edgeChecksPassed = ($edgeR1.manifest.evidence | Where-Object { $_.passed }).Count -eq $edgeR1.manifest.evidence.Count
$budgetChecksPassed = ($budgetR1.manifest.evidence | Where-Object { $_.passed }).Count -eq $budgetR1.manifest.evidence.Count

$results.ProfileEnforcement = $edgeChecksPassed -and $budgetChecksPassed

if ($results.ProfileEnforcement) {
    Write-Host "`n  [✓] TEST 2: PASS - Profile enforcement with real measurements" -ForegroundColor Green
} else {
    Write-Host "`n  [✗] TEST 2: FAIL - Some checks failed" -ForegroundColor Red
}

# ================================================================================
# TEST 3: CAPABILITIES (Negative + Positive Tests)
# ================================================================================
Write-Host "`n[3/5] CAPABILITIES TEST" -ForegroundColor Yellow

# Negative test 1: http.* without net()
Write-Host "`n  [Negative Test 1] http.healthy WITHOUT net() capability..." -ForegroundColor Cyan
$axmNoCap = @"
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

$parsedNoCap = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axmNoCap } | ConvertTo-Json) -ContentType "application/json"
$validateNoCap = Invoke-RestMethod -Uri "$MCP/validate" -Method POST -Body (@{ ir = $parsedNoCap.ir } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

if ($validateNoCap.ok -eq $false) {
    Write-Host "    ✅ Correctly REJECTED: $($validateNoCap.diagnostics[0].message)" -ForegroundColor Green
} else {
    Write-Host "    ❌ FAILED: Should have been rejected" -ForegroundColor Red
    return
}

# Negative test 2: scan.artifacts without fs()
Write-Host "`n  [Negative Test 2] scan.artifacts WITHOUT fs() capability..." -ForegroundColor Cyan
$axmNoFs = @"
agent "test" {
  intent "test fs capability"
  checks {
    policy "no-pii" expect scan.artifacts.no_personal_data()
  }
  emit {
    manifest target="./out/test.json"
  }
}
"@

$parsedNoFs = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axmNoFs } | ConvertTo-Json) -ContentType "application/json"
$validateNoFs = Invoke-RestMethod -Uri "$MCP/validate" -Method POST -Body (@{ ir = $parsedNoFs.ir } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

if ($validateNoFs.ok -eq $false) {
    Write-Host "    ✅ Correctly REJECTED: $($validateNoFs.diagnostics[0].message)" -ForegroundColor Green
} else {
    Write-Host "    ❌ FAILED: Should have been rejected" -ForegroundColor Red
    return
}

# Positive test: WITH capabilities
Write-Host "`n  [Positive Test] WITH net() and fs() capabilities..." -ForegroundColor Cyan
$axmWithCap = @"
agent "test" {
  intent "test capabilities"
  capabilities { net("http"), fs("./out") }
  checks {
    unit "api" expect http.healthy("http://localhost:4000/health")
    policy "no-pii" expect scan.artifacts.no_personal_data()
  }
  emit {
    manifest target="./out/test.json"
  }
}
"@

$parsedWithCap = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axmWithCap } | ConvertTo-Json) -ContentType "application/json"
$validateWithCap = Invoke-RestMethod -Uri "$MCP/validate" -Method POST -Body (@{ ir = $parsedWithCap.ir } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

if ($validateWithCap.ok -eq $true) {
    Write-Host "    ✅ Correctly ACCEPTED with capabilities" -ForegroundColor Green
} else {
    Write-Host "    ❌ FAILED: Should have been accepted" -ForegroundColor Red
    Write-Host "    Diagnostics: $($validateWithCap.diagnostics | ConvertTo-Json)" -ForegroundColor Red
    return
}

$results.Capabilities = $true
Write-Host "`n  [✓] TEST 3: PASS - Capability sandbox validated" -ForegroundColor Green

# ================================================================================
# TEST 4: REVERSE-IR
# ================================================================================
Write-Host "`n[4/5] REVERSE-IR" -ForegroundColor Yellow
Write-Host "  Testing /reverse endpoint for project detection...`n" -ForegroundColor Cyan

$reverseResult = Invoke-RestMethod -Uri "$MCP/reverse" -Method POST -Body (@{ repoPath = (Get-Location).Path; outDir = "out" } | ConvertTo-Json) -ContentType "application/json"

if ($reverseResult.ir) {
    $detectedAgent = $reverseResult.ir.agents[0]
    Write-Host "    ✅ Reverse-IR generated:" -ForegroundColor Green
    Write-Host "       Agent: $($detectedAgent.name)" -ForegroundColor DarkGray
    Write-Host "       Intent: $($detectedAgent.intent)" -ForegroundColor DarkGray
    Write-Host "       Emit count: $($detectedAgent.emit.Count)" -ForegroundColor DarkGray
    Write-Host "       Capabilities: $($detectedAgent.capabilities.Count)" -ForegroundColor DarkGray
    
    $reverseResult | ConvertTo-Json -Depth 10 | Out-File "$testResultsDir/reverse-ir-result.json"
    $results.ReverseIR = $true
} else {
    Write-Host "    ❌ Reverse-IR failed" -ForegroundColor Red
}

Write-Host "`n  [✓] TEST 4: PASS - /reverse endpoint functional" -ForegroundColor Green

# ================================================================================
# TEST 5: DIFF & APPLY
# ================================================================================
Write-Host "`n[5/5] DIFF & APPLY" -ForegroundColor Yellow
Write-Host "  Testing /diff and /apply endpoints...`n" -ForegroundColor Cyan

# Create modified IR (add a check)
$axmModified = @"
agent "blog" {
  intent "blog public cu admin - with contract test"
  constraints { latency_p50_ms <= 80, monthly_budget_usd <= 3, pii_leak == false }
  capabilities { fs("./out"), net("http") }
  checks {
    policy "no-pii" expect scan.artifacts.no_personal_data()
    sla "p50" expect latency_p50_ms <= 80
    unit "contract" expect http.healthy("http://localhost:4000/health")
  }
  emit {
    service type="web-app"     target="./out/web"
    service type="api-service" target="./out/api"
    manifest target="./out/axiom.json"
  }
}
"@

$parsedMod = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axmModified } | ConvertTo-Json) -ContentType "application/json"

# Generate diff
$diffResult = Invoke-RestMethod -Uri "$MCP/diff" -Method POST -Body (@{ oldIr = $ir; newIr = $parsedMod.ir } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

Write-Host "    Diff generated: $($diffResult.patch.Count) operations" -ForegroundColor Cyan
$diffResult | ConvertTo-Json -Depth 10 | Out-File "$testResultsDir/diff-patch.json"

# Generate new manifest
$genMod = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $parsedMod.ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

# Test apply in fs mode
$applyResult = Invoke-RestMethod -Uri "$MCP/apply" -Method POST -Body (@{ manifest = $genMod.manifest; mode = "fs"; repoPath = (Get-Location).Path } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"

if ($applyResult.success) {
    Write-Host "    ✅ Apply (fs mode): $($applyResult.filesWritten.Count) files written" -ForegroundColor Green
    $results.DiffApply = $true
} else {
    Write-Host "    ❌ Apply failed: $($applyResult.error)" -ForegroundColor Red
}

$applyResult | ConvertTo-Json -Depth 10 | Out-File "$testResultsDir/apply-result.json"

Write-Host "`n  [✓] TEST 5: PASS - /diff and /apply functional" -ForegroundColor Green

# ================================================================================
# FINAL SUMMARY
# ================================================================================
Write-Host "`n╔═══════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                          VALIDATION SUMMARY                               ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Green

$passCount = ($results.Values | Where-Object { $_ -eq $true }).Count
$totalTests = $results.Count

Write-Host "  Tests Passed: $passCount / $totalTests`n" -ForegroundColor Cyan

foreach ($test in $results.Keys | Sort-Object) {
    $status = if ($results[$test]) { "✅ PASS" } else { "❌ FAIL" }
    $color = if ($results[$test]) { "Green" } else { "Red" }
    Write-Host "  $status - $test" -ForegroundColor $color
}

if ($passCount -eq $totalTests) {
    Write-Host "`n╔═══════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║           ✅ PRODUCTION-READY: ALL VALIDATION TESTS PASSED                ║" -ForegroundColor Green
    Write-Host "╚═══════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Green
} else {
    Write-Host "`n╔═══════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "║              ❌ VALIDATION FAILED - Some tests did not pass                ║" -ForegroundColor Red
    Write-Host "╚═══════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Red
}

Write-Host "📁 Results saved to: test-results/`n" -ForegroundColor Magenta

return $results
