# Determinism Test Script - Validates identical hash generation across consecutive runs

param(
    [string]$MCP = "http://localhost:3411"
)

Write-Host "`n╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║        DETERMINISM TEST - CONSECUTIVE RUNS            ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝`n" -ForegroundColor Cyan

# Parse source
$axm = Get-Content examples/blog.axm -Raw
$parsed = Invoke-RestMethod -Uri "$MCP/parse" -Method POST -Body (@{ source = $axm } | ConvertTo-Json) -ContentType "application/json"
$ir = $parsed.ir

Write-Host "✓ Parsed IR: version=$($ir.version), agent=$($ir.agents[0].name)`n" -ForegroundColor Green

# Generate EDGE profile - Runda 1
Write-Host "[1/4] Generating EDGE - Runda 1..." -ForegroundColor Yellow
$gen1e = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
$m1e = $gen1e.manifest

# Sleep to ensure different timestamp
Start-Sleep -Milliseconds 150

# Generate EDGE profile - Runda 2
Write-Host "[2/4] Generating EDGE - Runda 2..." -ForegroundColor Yellow
$gen2e = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "edge" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
$m2e = $gen2e.manifest

# Generate BUDGET profile - Runda 1
Write-Host "[3/4] Generating BUDGET - Runda 1..." -ForegroundColor Yellow
$gen1b = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "budget" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
$m1b = $gen1b.manifest

# Sleep to ensure different timestamp
Start-Sleep -Milliseconds 150

# Generate BUDGET profile - Runda 2
Write-Host "[4/4] Generating BUDGET - Runda 2..." -ForegroundColor Yellow
$gen2b = Invoke-RestMethod -Uri "$MCP/generate" -Method POST -Body (@{ ir = $ir; profile = "budget" } | ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json"
$m2b = $gen2b.manifest

Write-Host "`n╔═══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                   DETERMINISM RESULTS                 ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════╝`n" -ForegroundColor Green

# Compare EDGE runs
Write-Host "=== EDGE PROFILE ===" -ForegroundColor Cyan
Write-Host "Runda 1: $($m1e.artifacts.Count) artifacts, buildId=$($m1e.buildId), createdAt=$($m1e.createdAt)"
Write-Host "Runda 2: $($m2e.artifacts.Count) artifacts, buildId=$($m2e.buildId), createdAt=$($m2e.createdAt)"

$edgeHashMatch = $true
for ($i = 0; $i -lt $m1e.artifacts.Count; $i++) {
    $a1 = $m1e.artifacts[$i]
    $a2 = $m2e.artifacts[$i]
    
    if ($a1.sha256 -ne $a2.sha256) {
        Write-Host "  ❌ HASH MISMATCH: $($a1.path)" -ForegroundColor Red
        Write-Host "     R1: $($a1.sha256)" -ForegroundColor DarkGray
        Write-Host "     R2: $($a2.sha256)" -ForegroundColor DarkGray
        $edgeHashMatch = $false
    }
}

if ($edgeHashMatch) {
    Write-Host "  ✅ ALL HASHES IDENTICAL ($($m1e.artifacts.Count) artifacts)" -ForegroundColor Green
} else {
    Write-Host "  ❌ DETERMINISM FAILED FOR EDGE PROFILE" -ForegroundColor Red
}

# Compare BUDGET runs
Write-Host "`n=== BUDGET PROFILE ===" -ForegroundColor Yellow
Write-Host "Runda 1: $($m1b.artifacts.Count) artifacts, buildId=$($m1b.buildId), createdAt=$($m1b.createdAt)"
Write-Host "Runda 2: $($m2b.artifacts.Count) artifacts, buildId=$($m2b.buildId), createdAt=$($m2b.createdAt)"

$budgetHashMatch = $true
for ($i = 0; $i -lt $m1b.artifacts.Count; $i++) {
    $a1 = $m1b.artifacts[$i]
    $a2 = $m2b.artifacts[$i]
    
    if ($a1.sha256 -ne $a2.sha256) {
        Write-Host "  ❌ HASH MISMATCH: $($a1.path)" -ForegroundColor Red
        Write-Host "     R1: $($a1.sha256)" -ForegroundColor DarkGray
        Write-Host "     R2: $($a2.sha256)" -ForegroundColor DarkGray
        $budgetHashMatch = $false
    }
}

if ($budgetHashMatch) {
    Write-Host "  ✅ ALL HASHES IDENTICAL ($($m1b.artifacts.Count) artifacts)" -ForegroundColor Green
} else {
    Write-Host "  ❌ DETERMINISM FAILED FOR BUDGET PROFILE" -ForegroundColor Red
}

# Export manifests for inspection
$m1e | ConvertTo-Json -Depth 10 | Out-File "out-edge-r1-manifest.json"
$m2e | ConvertTo-Json -Depth 10 | Out-File "out-edge-r2-manifest.json"
$m1b | ConvertTo-Json -Depth 10 | Out-File "out-budget-r1-manifest.json"
$m2b | ConvertTo-Json -Depth 10 | Out-File "out-budget-r2-manifest.json"

Write-Host "`n📄 Manifests exported:" -ForegroundColor Magenta
Write-Host "  - out-edge-r1-manifest.json"
Write-Host "  - out-edge-r2-manifest.json"
Write-Host "  - out-budget-r1-manifest.json"
Write-Host "  - out-budget-r2-manifest.json"

# Overall result
Write-Host "`n╔═══════════════════════════════════════════════════════╗" -ForegroundColor $(if ($edgeHashMatch -and $budgetHashMatch) { "Green" } else { "Red" })
if ($edgeHashMatch -and $budgetHashMatch) {
    Write-Host "║          ✅ DETERMINISM TEST PASSED                   ║" -ForegroundColor Green
} else {
    Write-Host "║          ❌ DETERMINISM TEST FAILED                   ║" -ForegroundColor Red
}
Write-Host "╚═══════════════════════════════════════════════════════╝`n" -ForegroundColor $(if ($edgeHashMatch -and $budgetHashMatch) { "Green" } else { "Red" })

return @{
    EdgeDeterministic = $edgeHashMatch
    BudgetDeterministic = $budgetHashMatch
    EdgeR1 = $m1e
    EdgeR2 = $m2e
    BudgetR1 = $m1b
    BudgetR2 = $m2b
}
