#!/bin/bash
# Claude Code Stop Hook - notifies backend when Claude finishes

# Read the JSON input from stdin
input=$(cat)

# Extract session_id using basic string parsing (no jq dependency)
session_id=$(echo "$input" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)

# Log for debugging
echo "[StopHook] Session: $session_id" >> /tmp/codeui-hooks.log 2>&1

# Send notification to our backend via HTTP
# The backend listens on port 4001 (see shared/src/config.ts)
response=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:4001/api/claude-stopped" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\": \"$session_id\"}" 2>&1)

# Log response
echo "[StopHook] Response: $response" >> /tmp/codeui-hooks.log 2>&1

exit 0
