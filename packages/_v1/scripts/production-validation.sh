#!/bin/sh
# AXIOM Production Validation Suite (POSIX-compatible)
# Complete validation: determinism, snapshots, profiles, capabilities, reverse, apply

set -e

MCP_URL="http://localhost:3411"
REPO_ROOT="$(pwd)"
TEST_RESULTS_DIR="$REPO_ROOT/test-results"
SNAPSHOTS_DIR="$REPO_ROOT/packages/axiom-tests/snapshots"

echo "=== AXIOM Production Validation Suite (POSIX) ==="
echo ""

# Ensure directories exist
mkdir -p "$TEST_RESULTS_DIR"
mkdir -p "$SNAPSHOTS_DIR"

# Read test source
AXM_SOURCE=$(cat "$REPO_ROOT/examples/blog.axm")

# ===========================
# 1. DETERMINISM TEST
# ===========================
echo "[1/6] DETERMINISM TEST"
echo "  Running consecutive builds for edge and budget profiles..."

for profile in edge budget; do
  # Run 1
  PARSED=$(curl -s -X POST "$MCP_URL/parse" \
    -H "Content-Type: application/json" \
    -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")
  
  IR=$(echo "$PARSED" | jq -c '.ir')
  
  MANIFEST_R1=$(curl -s -X POST "$MCP_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"ir\": $IR, \"profile\": \"$profile\"}")
  
  # Run 2
  PARSED2=$(curl -s -X POST "$MCP_URL/parse" \
    -H "Content-Type: application/json" \
    -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")
  
  IR2=$(echo "$PARSED2" | jq -c '.ir')
  
  MANIFEST_R2=$(curl -s -X POST "$MCP_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"ir\": $IR2, \"profile\": \"$profile\"}")
  
  # Compare all hashes
  HASHES_R1=$(echo "$MANIFEST_R1" | jq -r '.manifest.artifacts[] | "\(.path):\(.sha256)"' | sort)
  HASHES_R2=$(echo "$MANIFEST_R2" | jq -r '.manifest.artifacts[] | "\(.sha256)"' | sort)
  
  if [ "$HASHES_R1" = "$HASHES_R2" ]; then
    COUNT=$(echo "$HASHES_R1" | wc -l)
    echo "  [✓] $profile: ALL $COUNT artifacts identical (including manifest.json)"
  else
    echo "  [✗] $profile: Hash mismatch detected"
    exit 1
  fi
done

echo ""

# ===========================
# 2. GOLDEN SNAPSHOTS
# ===========================
echo "[2/6] GOLDEN SNAPSHOTS"
echo "  Generating frozen snapshots..."

for profile in edge budget; do
  PARSED=$(curl -s -X POST "$MCP_URL/parse" \
    -H "Content-Type: application/json" \
    -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")
  
  IR=$(echo "$PARSED" | jq -c '.ir')
  
  MANIFEST=$(curl -s -X POST "$MCP_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"ir\": $IR, \"profile\": \"$profile\"}")
  
  # Extract snapshot
  SNAPSHOT=$(echo "$MANIFEST" | jq '{
    profile: .manifest.profile,
    artifacts: [.manifest.artifacts[] | {path: .path, sha256: .sha256, bytes: .bytes}],
    totalBytes: (.manifest.artifacts | map(.bytes) | add)
  }')
  
  echo "$SNAPSHOT" | jq '.' > "$SNAPSHOTS_DIR/${profile}-profile.snapshot.json"
  
  ARTIFACT_COUNT=$(echo "$SNAPSHOT" | jq '.artifacts | length')
  TOTAL_BYTES=$(echo "$SNAPSHOT" | jq '.totalBytes')
  
  echo "  [✓] $profile: $ARTIFACT_COUNT artifacts, $TOTAL_BYTES bytes frozen"
done

echo ""

# ===========================
# 3. PROFILE ENFORCEMENT
# ===========================
echo "[3/6] PROFILE ENFORCEMENT"
echo "  Validating real measurements from manifests..."

for profile in edge budget; do
  PARSED=$(curl -s -X POST "$MCP_URL/parse" \
    -H "Content-Type: application/json" \
    -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")
  
  IR=$(echo "$PARSED" | jq -c '.ir')
  
  MANIFEST=$(curl -s -X POST "$MCP_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"ir\": $IR, \"profile\": \"$profile\"}")
  
  # Extract evidence
  EVIDENCE=$(echo "$MANIFEST" | jq '.manifest.evidence')
  CHECKS_PASSED=$(echo "$EVIDENCE" | jq '[.[] | select(.passed == true)] | length')
  CHECKS_TOTAL=$(echo "$EVIDENCE" | jq 'length')
  
  if [ "$CHECKS_PASSED" = "$CHECKS_TOTAL" ]; then
    echo "  [✓] $profile: $CHECKS_PASSED/$CHECKS_TOTAL checks passed with evidence"
  else
    echo "  [✗] $profile: Only $CHECKS_PASSED/$CHECKS_TOTAL checks passed"
    exit 1
  fi
done

echo ""

# ===========================
# 4. CAPABILITIES TEST
# ===========================
echo "[4/6] CAPABILITIES TEST (Negative + Positive)"

# Negative test: http.healthy without net()
echo "  [Negative] Testing http.healthy without net() capability..."
AXM_NO_CAP='agent "test" {
  intent "test capabilities"
  checks {
    unit "api" expect http.healthy("http://localhost:4000/health")
  }
  emit {
    manifest target="./out/test.json"
  }
}'

PARSED_NO_CAP=$(curl -s -X POST "$MCP_URL/parse" \
  -H "Content-Type: application/json" \
  -d "{\"source\": $(echo "$AXM_NO_CAP" | jq -Rs .)}")

IR_NO_CAP=$(echo "$PARSED_NO_CAP" | jq -c '.ir')

VALIDATE_NO_CAP=$(curl -s -X POST "$MCP_URL/validate" \
  -H "Content-Type: application/json" \
  -d "{\"ir\": $IR_NO_CAP}")

OK_NO_CAP=$(echo "$VALIDATE_NO_CAP" | jq -r '.ok')

if [ "$OK_NO_CAP" = "false" ]; then
  DIAG_MSG=$(echo "$VALIDATE_NO_CAP" | jq -r '.diagnostics[0].message')
  echo "  [✓] Negative test PASSED: Validation correctly rejected (message: $DIAG_MSG)"
else
  echo "  [✗] Negative test FAILED: Should have been rejected"
  exit 1
fi

# Positive test: with net()
echo "  [Positive] Testing http.healthy WITH net() capability..."
AXM_WITH_CAP='agent "test" {
  intent "test capabilities"
  capabilities { net("http") }
  checks {
    unit "api" expect http.healthy("http://localhost:4000/health")
  }
  emit {
    manifest target="./out/test.json"
  }
}'

PARSED_WITH_CAP=$(curl -s -X POST "$MCP_URL/parse" \
  -H "Content-Type: application/json" \
  -d "{\"source\": $(echo "$AXM_WITH_CAP" | jq -Rs .)}")

IR_WITH_CAP=$(echo "$PARSED_WITH_CAP" | jq -c '.ir')

VALIDATE_WITH_CAP=$(curl -s -X POST "$MCP_URL/validate" \
  -H "Content-Type: application/json" \
  -d "{\"ir\": $IR_WITH_CAP}")

OK_WITH_CAP=$(echo "$VALIDATE_WITH_CAP" | jq -r '.ok')

if [ "$OK_WITH_CAP" = "true" ]; then
  echo "  [✓] Positive test PASSED: Validation accepted with capability"
else
  echo "  [✗] Positive test FAILED: Should have been accepted"
  exit 1
fi

# Negative test 2: scan.artifacts without fs()
echo "  [Negative] Testing scan.artifacts without fs() capability..."
AXM_NO_FS='agent "test" {
  intent "test fs capability"
  checks {
    policy "no-pii" expect scan.artifacts.no_personal_data()
  }
  emit {
    manifest target="./out/test.json"
  }
}'

PARSED_NO_FS=$(curl -s -X POST "$MCP_URL/parse" \
  -H "Content-Type: application/json" \
  -d "{\"source\": $(echo "$AXM_NO_FS" | jq -Rs .)}")

IR_NO_FS=$(echo "$PARSED_NO_FS" | jq -c '.ir')

VALIDATE_NO_FS=$(curl -s -X POST "$MCP_URL/validate" \
  -H "Content-Type: application/json" \
  -d "{\"ir\": $IR_NO_FS}")

OK_NO_FS=$(echo "$VALIDATE_NO_FS" | jq -r '.ok')

if [ "$OK_NO_FS" = "false" ]; then
  DIAG_MSG_FS=$(echo "$VALIDATE_NO_FS" | jq -r '.diagnostics[0].message')
  echo "  [✓] Negative test PASSED: scan.artifacts rejected without fs() (message: $DIAG_MSG_FS)"
else
  echo "  [✗] Negative test FAILED: Should have been rejected"
  exit 1
fi

echo ""

# ===========================
# 5. REVERSE-IR
# ===========================
echo "[5/6] REVERSE-IR"
echo "  Testing /reverse endpoint..."

REVERSE_RESULT=$(curl -s -X POST "$MCP_URL/reverse" \
  -H "Content-Type: application/json" \
  -d "{\"repoPath\": \"$REPO_ROOT\", \"outDir\": \"out\"}")

REVERSE_IR=$(echo "$REVERSE_RESULT" | jq -c '.ir')
AGENT_NAME=$(echo "$REVERSE_IR" | jq -r '.agents[0].name')
EMIT_COUNT=$(echo "$REVERSE_IR" | jq '.agents[0].emit | length')

if [ -n "$REVERSE_IR" ] && [ "$REVERSE_IR" != "null" ]; then
  echo "  [✓] Reverse-IR generated: agent=\"$AGENT_NAME\", emit count=$EMIT_COUNT"
  echo "$REVERSE_RESULT" | jq '.' > "$TEST_RESULTS_DIR/reverse-ir.json"
else
  echo "  [✗] Reverse-IR failed"
  exit 1
fi

echo ""

# ===========================
# 6. DIFF & APPLY
# ===========================
echo "[6/6] DIFF & APPLY"
echo "  Testing /diff and /apply endpoints..."

# Generate original IR
PARSED_ORIG=$(curl -s -X POST "$MCP_URL/parse" \
  -H "Content-Type: application/json" \
  -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")

IR_ORIG=$(echo "$PARSED_ORIG" | jq -c '.ir')

# Create modified IR (add a test check)
AXM_MODIFIED='agent "blog" {
  intent "blog public cu admin"
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
}'

PARSED_MOD=$(curl -s -X POST "$MCP_URL/parse" \
  -H "Content-Type: application/json" \
  -d "{\"source\": $(echo "$AXM_MODIFIED" | jq -Rs .)}")

IR_MOD=$(echo "$PARSED_MOD" | jq -c '.ir')

# Generate diff
DIFF_RESULT=$(curl -s -X POST "$MCP_URL/diff" \
  -H "Content-Type: application/json" \
  -d "{\"oldIr\": $IR_ORIG, \"newIr\": $IR_MOD}")

PATCH=$(echo "$DIFF_RESULT" | jq '.patch')
PATCH_OPS=$(echo "$PATCH" | jq 'length')

if [ "$PATCH_OPS" -gt 0 ]; then
  echo "  [✓] Diff generated: $PATCH_OPS patch operations"
  echo "$DIFF_RESULT" | jq '.' > "$TEST_RESULTS_DIR/diff-patch.json"
else
  echo "  [✗] Diff failed: No patch operations"
  exit 1
fi

# Generate manifest for apply
MANIFEST_FOR_APPLY=$(curl -s -X POST "$MCP_URL/generate" \
  -H "Content-Type: application/json" \
  -d "{\"ir\": $IR_MOD, \"profile\": \"edge\"}")

MANIFEST_JSON=$(echo "$MANIFEST_FOR_APPLY" | jq -c '.manifest')

# Test apply in fs mode
APPLY_FS=$(curl -s -X POST "$MCP_URL/apply" \
  -H "Content-Type: application/json" \
  -d "{\"manifest\": $MANIFEST_JSON, \"mode\": \"fs\", \"repoPath\": \"$REPO_ROOT\"}")

APPLY_FS_SUCCESS=$(echo "$APPLY_FS" | jq -r '.success')

if [ "$APPLY_FS_SUCCESS" = "true" ]; then
  FILES_WRITTEN=$(echo "$APPLY_FS" | jq '.filesWritten | length')
  echo "  [✓] Apply (fs mode): $FILES_WRITTEN files written"
else
  echo "  [✗] Apply (fs mode) failed"
  exit 1
fi

echo ""

# ===========================
# SUMMARY
# ===========================
echo "=== ✓ PRODUCTION VALIDATION: ALL TESTS PASSED ==="
echo ""
echo "Summary:"
echo "  [✓] Determinism: edge and budget profiles produce identical artifacts"
echo "  [✓] Golden snapshots: Frozen snapshots created for CI"
echo "  [✓] Profile enforcement: All checks passed with real measurements"
echo "  [✓] Capabilities: Negative and positive tests validated"
echo "  [✓] Reverse-IR: /reverse endpoint functional"
echo "  [✓] Diff & Apply: /diff and /apply endpoints functional"
echo ""
echo "Results saved to: $TEST_RESULTS_DIR/"
