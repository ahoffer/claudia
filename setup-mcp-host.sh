#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# setup-mcp-host.sh
#
# One-time setup for running claudia-client on your machine.
# claudia-client spawns MCP servers as child processes — no launchd or system
# service installation required.
#
# What this does:
#   1. Checks Node.js 18+
#   2. Writes ~/.config/claudia/config
#   3. Creates ~/.local/share/claudia-mcp/logs/
#   4. Prints how to start
#
# Usage:
#   bash setup-mcp-host.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-$HOME/projects}"
MCP_DIR="$HOME/.local/share/claudia-mcp"
CLAUDIA_CONFIG_DIR="$HOME/.config/claudia"
CLAUDIA_CONFIG="$CLAUDIA_CONFIG_DIR/config"
FS_PORT=8100
SHELL_PORT=8101

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
step() { echo -e "${CYAN}[→]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# 1. Node.js check
command -v node >/dev/null 2>&1 || err "node not found. Install Node.js 18+."
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || err "Node.js 18+ required (found $(node -v))"
ok "Node.js $(node -v)"

# 2. Config
step "Configuring claudia-client..."
mkdir -p "$CLAUDIA_CONFIG_DIR"

EXISTING_SERVER_URL=""
EXISTING_TOKEN=""
EXISTING_PROJECTS_DIR=""
if [ -f "$CLAUDIA_CONFIG" ]; then
    EXISTING_SERVER_URL=$(grep '^CLAUDIA_SERVER_URL=' "$CLAUDIA_CONFIG" | cut -d= -f2- || true)
    EXISTING_TOKEN=$(grep '^CLAUDIA_TOKEN=' "$CLAUDIA_CONFIG" | cut -d= -f2- || true)
    EXISTING_PROJECTS_DIR=$(grep '^PROJECTS_DIR=' "$CLAUDIA_CONFIG" | cut -d= -f2- || true)
fi

read -rp "  CLAUDIA_SERVER_URL [${EXISTING_SERVER_URL:-e.g. wss://myhost:4443}]: " INPUT_SERVER_URL
CLAUDIA_SERVER_URL="${INPUT_SERVER_URL:-$EXISTING_SERVER_URL}"
[ -n "$CLAUDIA_SERVER_URL" ] || warn "CLAUDIA_SERVER_URL left blank — edit $CLAUDIA_CONFIG before starting"

read -rp "  CLAUDIA_TOKEN [${EXISTING_TOKEN:+leave blank to keep existing}]: " INPUT_TOKEN
CLAUDIA_TOKEN="${INPUT_TOKEN:-$EXISTING_TOKEN}"
[ -n "$CLAUDIA_TOKEN" ] || warn "CLAUDIA_TOKEN left blank — edit $CLAUDIA_CONFIG before starting"

read -rp "  PROJECTS_DIR [${EXISTING_PROJECTS_DIR:-$PROJECTS_DIR}]: " INPUT_PROJECTS_DIR
FINAL_PROJECTS_DIR="${INPUT_PROJECTS_DIR:-${EXISTING_PROJECTS_DIR:-$PROJECTS_DIR}}"

cat > "$CLAUDIA_CONFIG" << CFGEOF
# Claudia client configuration
# Edit this file if connection details change, then restart claudia-client.

CLAUDIA_SERVER_URL=${CLAUDIA_SERVER_URL}
CLAUDIA_TOKEN=${CLAUDIA_TOKEN}
PROJECTS_DIR=${FINAL_PROJECTS_DIR}
FS_MCP_PORT=${FS_PORT}
SHELL_MCP_PORT=${SHELL_PORT}
CFGEOF
ok "Config written: $CLAUDIA_CONFIG"

# 3. Log directory
mkdir -p "$MCP_DIR"
ok "Log directory: $MCP_DIR"

# 4. Instructions
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  SETUP COMPLETE${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  claudia-client spawns filesystem-mcp and shell-mcp automatically."
echo "  No system service installation required."
echo ""
echo "  Start (background):    mcp start"
echo "  Or run directly:       npx tsx ${SCRIPT_DIR}/bin/claudia-client.ts"
echo ""
echo "  mcp status             check process and port status"
echo "  mcp logs               tail the log"
echo "  mcp stop               stop claudia-client"
echo ""
echo "  Config: $CLAUDIA_CONFIG"
echo ""
