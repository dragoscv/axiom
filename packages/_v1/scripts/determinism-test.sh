#!/bin/sh
# AXIOM Determinism Test (POSIX-compatible)
# Runs consecutive builds and compares ALL artifact hashes (including manifest.json)

set -e

MCP_URL="http://localhost:3411"
REPO_ROOT="$(pwd)"
TEST_RESULTS_DIR="$REPO_ROOT/test-results"

echo "=== AXIOM Determinism Test (POSIX) ==="
echo "Repository: $REPO_ROOT"
echo "MCP Server: $MCP_URL"
echo ""

# Ensure test-results directory exists
mkdir -p "$TEST_RESULTS_DIR"

# Test source
AXM_SOURCE=$(cat "$REPO_ROOT/examples/blog.axm")

# Test profiles
PROFILES="edge budget"

for profile in $PROFILES; do
  echo "=== Testing profile: $profile ==="
  
  # Run 1
  echo "  [Run 1] Parsing..."
  PARSED=$(curl -s -X POST "$MCP_URL/parse" \
    -H "Content-Type: application/json" \
    -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")
  
  IR=$(echo "$PARSED" | jq -c '.ir')
  
  echo "  [Run 1] Generating artifacts with profile=$profile..."
  MANIFEST_R1=$(curl -s -X POST "$MCP_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"ir\": $IR, \"profile\": \"$profile\"}")
  
  echo "$MANIFEST_R1" | jq '.' > "$TEST_RESULTS_DIR/determinism-${profile}-r1.json"
  echo "  [Run 1] Saved to test-results/determinism-${profile}-r1.json"
  
  # Run 2 (consecutive)
  echo "  [Run 2] Parsing..."
  PARSED2=$(curl -s -X POST "$MCP_URL/parse" \
    -H "Content-Type: application/json" \
    -d "{\"source\": $(echo "$AXM_SOURCE" | jq -Rs .)}")
  
  IR2=$(echo "$PARSED2" | jq -c '.ir')
  
  echo "  [Run 2] Generating artifacts with profile=$profile..."
  MANIFEST_R2=$(curl -s -X POST "$MCP_URL/generate" \
    -H "Content-Type: application/json" \
    -d "{\"ir\": $IR2, \"profile\": \"$profile\"}")
  
  echo "$MANIFEST_R2" | jq '.' > "$TEST_RESULTS_DIR/determinism-${profile}-r2.json"
  echo "  [Run 2] Saved to test-results/determinism-${profile}-r2.json"
  
  # Compare ALL hashes (including manifest.json now that buildId is deterministic)
  echo "  [Compare] Extracting artifact hashes..."
  
  HASHES_R1=$(echo "$MANIFEST_R1" | jq -r '.manifest.artifacts[] | "\(.path):\(.sha256)"' | sort)
  HASHES_R2=$(echo "$MANIFEST_R2" | jq -r '.manifest.artifacts[] | "\(.path):\(.sha256)"' | sort)
  
  # Save for comparison
  echo "$HASHES_R1" > "$TEST_RESULTS_DIR/hashes-${profile}-r1.txt"
  echo "$HASHES_R2" > "$TEST_RESULTS_DIR/hashes-${profile}-r2.txt"
  
  # Compare
  if diff -q "$TEST_RESULTS_DIR/hashes-${profile}-r1.txt" "$TEST_RESULTS_DIR/hashes-${profile}-r2.txt" >/dev/null; then
    ARTIFACT_COUNT=$(echo "$HASHES_R1" | wc -l)
    echo "  [✓] DETERMINISM VALIDATED: ALL $ARTIFACT_COUNT artifacts (including manifest.json) have IDENTICAL hashes"
  else
    echo "  [✗] DETERMINISM FAILED: Hashes differ between runs"
    echo ""
    echo "  Differences:"
    diff "$TEST_RESULTS_DIR/hashes-${profile}-r1.txt" "$TEST_RESULTS_DIR/hashes-${profile}-r2.txt" || true
    exit 1
  fi
  
  echo ""
done

echo "=== Determinism Test: PASS ==="
echo "All profiles produced identical artifacts across consecutive runs."
