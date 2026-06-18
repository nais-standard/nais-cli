#!/bin/bash
# Test script for {{AGENT_NAME}} ({{DOMAIN}})
# Usage: ./test.sh [base_url]    (default: http://localhost:8080)

BASE_URL="${1:-http://localhost:8080}"

echo "=================================================="
echo "  NAIS Agent Test: {{DOMAIN}}"
echo "=================================================="
echo ""

echo "1. Signed card"
echo "   GET ${BASE_URL}/.well-known/agent.json"
curl -s "${BASE_URL}/.well-known/agent.json" | python3 -m json.tool 2>/dev/null || curl -s "${BASE_URL}/.well-known/agent.json"
echo ""

echo "2. MCP initialize"
curl -s -X POST "${BASE_URL}/mcp" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' | python3 -m json.tool 2>/dev/null
echo ""

echo "3. tools/list"
curl -s -X POST "${BASE_URL}/mcp" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}' | python3 -m json.tool 2>/dev/null
echo ""

echo "4. tools/call ping"
curl -s -X POST "${BASE_URL}/mcp" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"ping","arguments":{}}}' | python3 -m json.tool 2>/dev/null
echo ""

echo "Done. Once the DNS record is live, verify end-to-end:"
echo "  nais verify {{DOMAIN}}"
