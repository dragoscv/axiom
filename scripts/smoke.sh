#!/usr/bin/env bash
set -euo pipefail

echo "🔬 AXIOM Smoke Test - Cross-Platform Validation"
echo "================================================"

# Start MCP server in background
echo "[1/6] Starting MCP server..."
node packages/axiom-mcp/dist/server.js &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

# Wait for server to start
echo "[2/6] Waiting for server..."
sleep 2

# Verify server is listening
if ! nc -z localhost 3411 2>/dev/null && ! timeout 1 bash -c '</dev/tcp/localhost/3411' 2>/dev/null; then
    echo "❌ FAIL: MCP server not listening on port 3411"
    exit 1
fi
echo "✅ Server listening on http://localhost:3411"

# Test /parse endpoint
echo "[3/6] Testing /parse endpoint..."
PARSE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST http://localhost:3411/parse \
    -H 'Content-Type: application/json' \
    -d @examples/blog.ir.json)
PARSE_HTTP_CODE=$(echo "$PARSE_RESPONSE" | tail -n1)
if [ "$PARSE_HTTP_CODE" != "200" ]; then
    echo "❌ FAIL: /parse returned HTTP $PARSE_HTTP_CODE"
    exit 1
fi
echo "✅ /parse OK"

# Test /generate endpoint (determinism test)
echo "[4/6] Testing /generate determinism..."
GEN1=$(curl -s -X POST http://localhost:3411/generate \
    -H 'Content-Type: application/json' \
    -d @examples/blog.ir.json)
sleep 1
GEN2=$(curl -s -X POST http://localhost:3411/generate \
    -H 'Content-Type: application/json' \
    -d @examples/blog.ir.json)

# Extract buildId from both responses
BUILD_ID_1=$(echo "$GEN1" | jq -r '.manifest.buildId // empty')
BUILD_ID_2=$(echo "$GEN2" | jq -r '.manifest.buildId // empty')

if [ -z "$BUILD_ID_1" ] || [ -z "$BUILD_ID_2" ]; then
    echo "❌ FAIL: Missing buildId in response"
    exit 1
fi

if [ "$BUILD_ID_1" != "$BUILD_ID_2" ]; then
    echo "❌ FAIL: Determinism broken"
    echo "   R1: $BUILD_ID_1"
    echo "   R2: $BUILD_ID_2"
    exit 1
fi
echo "✅ /generate deterministic (buildId: ${BUILD_ID_1:0:16}...)"

# Verify manifest.json hash
echo "[5/6] Verifying manifest.json hash..."
if [ ! -f manifest.json ]; then
    echo "❌ FAIL: manifest.json not generated"
    exit 1
fi

MANIFEST_HASH=$(sha256sum manifest.json | awk '{print $1}')
echo "✅ manifest.json hash: ${MANIFEST_HASH:0:16}..."

# Cleanup test - rerun and verify hash is identical
echo "[6/6] Final determinism check..."
curl -s -X POST http://localhost:3411/generate \
    -H 'Content-Type: application/json' \
    -d @examples/blog.ir.json >/dev/null
MANIFEST_HASH_2=$(sha256sum manifest.json | awk '{print $1}')

if [ "$MANIFEST_HASH" != "$MANIFEST_HASH_2" ]; then
    echo "❌ FAIL: manifest.json hash changed on re-run"
    echo "   First:  $MANIFEST_HASH"
    echo "   Second: $MANIFEST_HASH_2"
    exit 1
fi

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  ✅ SMOKE TEST PASSED                  ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Summary:"
echo "  • MCP server: OK"
echo "  • /parse: OK"
echo "  • /generate: OK (deterministic)"
echo "  • manifest.json: $MANIFEST_HASH"
echo ""
