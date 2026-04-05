#!/bin/bash

# Claudia - Production Start Script
# Runs the compiled backend which serves the frontend from dist/

set -e

# ============================================
# EXTRA SANs — pass additional Subject Alternative Names for the TLS cert
# Usage: ./start.sh --san DNS:myhost --san IP:10.0.0.5
# ============================================
EXTRA_SANS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --san) EXTRA_SANS+=("$2"); shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ============================================
# PORT CONFIGURATION - Single source of truth
# ============================================
BACKEND_PORT=4001
# ============================================

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

    if [ ! -f "backend/dist/index.js" ]; then
        echo "❌ Backend is not built."
        echo "   Run: npm run build"
        missing=1
    fi

    if [ ! -d "frontend/dist" ]; then
        echo "❌ Frontend is not built."
        echo "   Run: npm run build"
        missing=1
    fi

    if [ $missing -eq 1 ]; then
        echo ""
        echo "Please fix the above and try again."
        exit 1
    fi
}

check_deps

# ============================================
# TLS CERTIFICATE — auto-generate self-signed cert if missing
# ============================================
ensure_certs() {
    local cert_dir="$HOME/.claudia/certs"
    local key="$cert_dir/server.key"
    local cert="$cert_dir/server.crt"

    if [ -f "$key" ] && [ -f "$cert" ] && [ ${#EXTRA_SANS[@]} -eq 0 ]; then
        echo "🔒 TLS certificate found at $cert_dir"
    else
        [ ${#EXTRA_SANS[@]} -gt 0 ] && echo "🔒 Regenerating TLS certificate with extra SANs..." || true
        echo "🔒 Generating self-signed TLS certificate..."
        mkdir -p "$cert_dir"

        # Build SAN list: hostname + localhost + loopback + LAN IP
        local san="DNS:localhost,IP:127.0.0.1,IP:::1"
        local hname
        hname=$(hostname 2>/dev/null)
        if [ -n "$hname" ]; then
            san="DNS:$hname,$san"
        fi
        local host_ip
        host_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
        if [ -n "$host_ip" ]; then
            san="$san,IP:$host_ip"
        fi
        # Append any --san arguments from the command line
        for extra in "${EXTRA_SANS[@]}"; do
            san="$san,$extra"
        done

        openssl req -x509 -newkey rsa:2048 -nodes \
            -keyout "$key" -out "$cert" \
            -days 365 -subj "/CN=claudia" \
            -addext "subjectAltName=$san" \
            2>/dev/null

        echo "   Certificate generated at $cert_dir"
        echo "   ⚠  Accept the browser warning on first visit (self-signed cert)"
        echo "   To use a real cert, replace server.key and server.crt in that directory"
    fi

    export CLAUDIA_TLS_CERT="$cert"
    export CLAUDIA_TLS_KEY="$key"
}

ensure_certs

# Check if port is available
if lsof -ti:$BACKEND_PORT >/dev/null 2>&1; then
    echo "❌ Port $BACKEND_PORT is already in use:"
    lsof -i:$BACKEND_PORT
    echo ""
    echo "Kill it with: kill \$(lsof -ti:$BACKEND_PORT)"
    exit 1
fi

echo "🔮 Starting Claudia..."
echo "   https://localhost:$BACKEND_PORT"
echo ""

# Start from project root
cd "$(dirname "$0")"

# Export CLAUDIA_BACKEND_PORT for the backend to use
export CLAUDIA_BACKEND_PORT=$BACKEND_PORT

# CORS
if [ -z "$CORS_ORIGINS" ]; then
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    local_origins="https://localhost:$BACKEND_PORT,https://127.0.0.1:$BACKEND_PORT"
    if [ -n "$HOST_IP" ]; then
        local_origins="$local_origins,https://${HOST_IP}:$BACKEND_PORT"
        local_origins="$local_origins,https://${HOST_IP}:4443,https://localhost:4443"
    fi
    export CORS_ORIGINS="$local_origins"
fi

# Increase Node.js memory limit for backend (handles many persisted tasks + archived tasks)
# Accept self-signed certs for internal localhost connections (backend calling itself)
export NODE_OPTIONS="--max-old-space-size=8192"
export NODE_TLS_REJECT_UNAUTHORIZED=0

node backend/dist/index.js
