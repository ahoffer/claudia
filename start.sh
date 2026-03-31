#!/bin/bash

# Claudia - Start Script

set -e

# ============================================
# PORT CONFIGURATION - Single source of truth
# ============================================
BACKEND_PORT=4001
FRONTEND_PORT=5173
OPENCODE_PORT=4097
# ============================================

# Ensure OpenCode CLI is in PATH
export PATH=$HOME/.opencode/bin:$PATH

# Load environment variables if .env exists
if [ -f .env ]; then
    set -a; source .env; set +a
fi

# ============================================
# DEPENDENCY CHECK
# ============================================
check_deps() {
    local missing=0

    if ! command -v node &>/dev/null; then
        echo "❌ Node.js is not installed."
        echo "   Install it from https://nodejs.org/ or via your package manager."
        missing=1
    fi

    if ! command -v npm &>/dev/null; then
        echo "❌ npm is not installed."
        echo "   It usually comes with Node.js. Install Node.js from https://nodejs.org/"
        missing=1
    fi

    if [ ! -d "node_modules" ] || [ ! -x "node_modules/.bin/tsx" ] || [ ! -x "node_modules/.bin/vite" ]; then
        echo "❌ Dependencies are not installed."
        echo "   Run: npm install"
        missing=1
    fi

    if [ $missing -eq 1 ]; then
        echo ""
        echo "Please install the missing dependencies and try again."
        exit 1
    fi
}

check_deps

# Fix node-pty spawn-helper permissions (npm doesn't preserve execute bits)
for helper in node_modules/node-pty/prebuilds/*/spawn-helper; do
    [ -f "$helper" ] && chmod +x "$helper"
done

# Ensure Playwright Chromium browser is installed (needed for UI tests and MCP Playwright)
if [ -x "node_modules/.bin/playwright" ]; then
    node_modules/.bin/playwright install chromium 2>/dev/null || true
fi

# Check if ports are available
echo "🔍 Checking ports..."
ports_busy=0
for port in $BACKEND_PORT $FRONTEND_PORT $OPENCODE_PORT; do
    if lsof -ti:$port >/dev/null 2>&1; then
        echo "❌ Port $port is already in use:"
        lsof -i:$port
        ports_busy=1
    fi
done

if [ $ports_busy -eq 1 ]; then
    echo ""
    echo "Please free the ports above and try again."
    echo "You can kill processes on a port with: kill \$(lsof -ti:<port>)"
    exit 1
fi

echo "✅ Ports are free"
echo ""
echo "🔮 Starting Claudia..."
echo "   Backend: http://localhost:$BACKEND_PORT"
echo "   Frontend: http://localhost:$FRONTEND_PORT"
echo ""

# Start from project root
cd "$(dirname "$0")"

# Export CLAUDIA_BACKEND_PORT for the backend to use
export CLAUDIA_BACKEND_PORT=$BACKEND_PORT

# CORS_ORIGINS: allow requests from a reverse proxy (e.g. Caddy on :4443).
# Read from environment if already set, otherwise derive from .env if present.
# The value set here is a fallback default for the common single-proxy case.
# Override by setting CORS_ORIGINS before running start.sh, or via .env.
if [ -z "$CORS_ORIGINS" ]; then
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "$HOST_IP" ]; then
        export CORS_ORIGINS="https://${HOST_IP}:4443,https://localhost:4443"
    fi
fi

# Increase Node.js memory limit for backend (handles many persisted tasks + archived tasks)
export NODE_OPTIONS="--max-old-space-size=8192"

# Start backend and frontend
# Backend: tsx watch - auto-reloads on file changes (or use restart button in UI)
# Frontend: Vite HMR auto-reloads on file changes
npm run dev -w backend & npm run dev -w frontend

