#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# setup-claudia-remote.sh
#
# Run on your Mac. Sets up a remote Ubuntu host to run Claude Code + Claudia.
# MCP tool calls travel through claudia-client (running on the client machine),
# which spawns filesystem-mcp and shell-mcp as child processes. No sshfs or
# system-level service installation is needed on the client.
#
# Prerequisites:
#   - SSH access to the remote host (password or existing key)
#
# Usage:
#   bash setup-claudia-remote.sh user@host
#
# What it does (all over SSH from this Mac):
#   1.  Verifies SSH access to remote host
#   2.  Discovers Mac IP reachable from remote
#   3.  Installs Node.js 22, Claude Code CLI, Claudia
#   4.  Runs 'claude login' (interactive — opens URL in your Mac browser)
#   5.  Syncs ~/.claude config from GitHub
#   6.  Creates systemd service for Claudia
#   7.  Writes ~/.config/claudia/config on this Mac
#   8.  Installs bin/claudia and bin/mcp helpers to ~/.local/bin
#
# Idempotent: safe to re-run — skips completed steps.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="$HOME/projects"
CLAUDIA_PORT=4001
FS_PORT=8100
SHELL_PORT=8101
BINDIR="$HOME/.local/bin"
CLAUDIA_CONFIG_DIR="$HOME/.config/claudia"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
step() { echo -e "${CYAN}[→]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# =============================================================================
# Args
# =============================================================================

if [ $# -eq 0 ]; then
    echo "Usage: bash setup-claudia-remote.sh user@host"
    echo ""
    echo "  user@host — SSH target for the remote Ubuntu server"
    echo ""
    echo "Prerequisites:"
    echo "  - SSH access to the remote host (test: ssh user@host echo ok)"
    exit 1
fi

REMOTE_HOST="$1"
REMOTE_USER="${REMOTE_HOST%%@*}"
REMOTE_ADDR="${REMOTE_HOST##*@}"
MAC_USER="$USER"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Claudia Remote Setup${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Remote host : $REMOTE_HOST"
echo "  Mac user    : $MAC_USER"
echo "  Projects    : $PROJECTS_DIR"
echo ""

# =============================================================================
# Helpers: run scripts on remote host
# =============================================================================

# Run a heredoc script on remote via login bash
remote_run() {
    local script_file
    script_file=$(mktemp /tmp/claudia-remote-XXXXXX.sh)
    trap 'rm -f "$script_file"' RETURN
    cat > "$script_file"
    # -l (login shell) ensures .bashrc is sourced for PATH
    ssh "$REMOTE_HOST" -- bash -ls < "$script_file"
}

# Run a single command on remote
remote_cmd() {
    ssh "$REMOTE_HOST" -- "$@"
}

# Run a command on remote with a PTY (for interactive steps)
remote_interactive() {
    ssh -t "$REMOTE_HOST" -- "$@"
}

mkdir -p "$BINDIR" "$CLAUDIA_CONFIG_DIR" "$PROJECTS_DIR"

# =============================================================================
# Phase 1: Verify SSH access
# =============================================================================

step "Verifying SSH access to $REMOTE_HOST..."

if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$REMOTE_HOST" -- echo ok >/dev/null 2>&1; then
    err "Cannot reach $REMOTE_HOST. Ensure SSH access works: ssh $REMOTE_HOST echo ok"
fi
ok "SSH access confirmed"

# =============================================================================
# Phase 2: Discover Mac IP reachable from remote
#
# We try each of Mac's network IPs and test which is pingable from remote.
# If none auto-detect, the user is prompted to enter it manually.
# =============================================================================

step "Discovering Mac IP reachable from $REMOTE_ADDR..."

HOST_IP=""

# Collect candidate IPs from Mac interfaces
CANDIDATE_IPS=()
for iface in en0 en1 en2 en3; do
    ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    [ -n "$ip" ] && CANDIDATE_IPS+=("$ip")
done

# Test each candidate from the remote host
for ip in "${CANDIDATE_IPS[@]}"; do
    if remote_cmd -- ping -c1 -W3 "$ip" >/dev/null 2>&1; then
        HOST_IP="$ip"
        ok "Mac IP: $HOST_IP (reachable from remote via ping)"
        break
    fi
done

if [ -z "$HOST_IP" ]; then
    warn "Could not auto-detect Mac IP. Mac interfaces found: ${CANDIDATE_IPS[*]:-none}"
    echo ""
    read -rp "  Enter Mac IP reachable from $REMOTE_ADDR: " HOST_IP
    [ -n "$HOST_IP" ] || err "Mac IP is required."
fi

# Persist for mcp helpers to read
MCP_DIR="$HOME/.local/share/claudia-mcp"
mkdir -p "$MCP_DIR"
echo "$HOST_IP" > "$MCP_DIR/host-ip.txt"

# =============================================================================
# Phase 3: Install Node.js 22, Claude Code CLI, Claudia
# (Inner script is identical to setup-claudia-vm.sh — transport-agnostic)
# =============================================================================

step "Installing Node.js, Claude Code, Claudia on remote (first run ~2 min)..."

remote_run << 'INSTALLSCRIPT'
set -euo pipefail

# --- Node.js 22 ---
if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
        echo "[✓] Node.js already installed: $(node -v)"
    else
        echo "[!] Node.js $(node -v) too old, upgrading..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
        sudo apt-get install -y nodejs
    fi
else
    echo "[→] Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
    sudo apt-get install -y nodejs git build-essential
    echo "[✓] Node.js installed: $(node -v)"
fi

# --- Claude Code CLI ---
export PATH="$HOME/.local/bin:$PATH"
if command -v claude &>/dev/null; then
    echo "[✓] Claude Code already installed"
else
    echo "[→] Installing Claude Code CLI..."
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    echo "[✓] Claude Code installed"
fi

# Persist PATH
if ! grep -q '\.local/bin' ~/.bashrc 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

# --- npm global prefix (user-writable, no sudo) ---
NPM_GLOBAL="$HOME/.npm-global"
mkdir -p "$NPM_GLOBAL"
npm config set prefix "$NPM_GLOBAL"
export PATH="$NPM_GLOBAL/bin:$PATH"
if ! grep -q 'npm-global' ~/.bashrc 2>/dev/null; then
    echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
fi

# --- Claudia ---
if command -v claudia &>/dev/null; then
    echo "[✓] Claudia already installed"
else
    echo "[→] Installing Claudia..."
    npm install -g @ahoffer/claudia
    echo "[✓] Claudia installed"
fi
INSTALLSCRIPT

ok "All software installed on remote"

# =============================================================================
# Phase 11: Claude Code authentication
# =============================================================================

step "Checking Claude Code auth on remote..."

if remote_cmd -- bash -lc \
    'claude -p "respond with only the word hello" --max-turns 1 2>/dev/null' \
    2>/dev/null | grep -qi hello; then
    ok "Claude Code already authenticated"
else
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  CLAUDE CODE AUTH (one-time)${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "  'claude login' will print a URL."
    echo "  Open it in your Mac browser and sign in with your Anthropic account."
    echo ""
    read -rp "  Press ENTER when ready..."
    echo ""

    remote_interactive -- bash -lc \
        'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; claude login'

    echo ""
    step "Verifying auth..."
    if remote_cmd -- bash -lc \
        'claude -p "respond with only the word hello" --max-turns 1 2>/dev/null' \
        2>/dev/null | grep -qi hello; then
        ok "Claude Code is working"
    else
        warn "Verification inconclusive — re-run or check manually:"
        warn "  ssh $REMOTE_HOST then: claude login"
    fi
fi

# =============================================================================
# Phase 12: Sync ~/.claude config from GitHub
# =============================================================================

step "Syncing Claude Code config from GitHub..."

remote_run << 'CONFIGSYNC'
set -euo pipefail

if ! command -v git &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq git
fi

REPO="https://github.com/ahoffer/claudecode.git"
CLAUDE_DIR="$HOME/.claude"

if [ -d "$CLAUDE_DIR/.git" ]; then
    echo "[✓] ~/.claude is already a git repo — pulling latest..."
    cd "$CLAUDE_DIR"
    git pull --ff-only origin main || {
        echo "[!] Fast-forward failed — resetting to origin/main"
        git fetch origin
        git reset --hard origin/main
    }
else
    echo "[→] Setting up ~/.claude from GitHub..."
    mkdir -p "$CLAUDE_DIR"
    cd "$CLAUDE_DIR"
    git init
    git remote add origin "$REPO"
    git fetch origin
    git checkout -b main
    git reset --hard origin/main
    git branch --set-upstream-to=origin/main main
    echo "[✓] ~/.claude synced from GitHub"
fi
CONFIGSYNC

ok "Claude Code config synced"

# =============================================================================
# Phase 13: Create systemd service for Claudia
# =============================================================================

step "Creating systemd service for Claudia..."

remote_run << CLAUDIASVC
set -euo pipefail

# Stop running Claudia before overwriting the service file so the daemon
# picks up changes cleanly on the next start. Skipped if not running.
if systemctl is-active claudia >/dev/null 2>&1; then
    echo "[→] Stopping Claudia to reload service file..."
    sudo systemctl stop claudia
fi

# Get full paths inside remote
CLAUDE_BIN=\$(bash -lc 'which claudia 2>/dev/null' || true)
if [ -z "\$CLAUDE_BIN" ]; then
    CLAUDE_BIN="\$HOME/.npm-global/bin/claudia"
fi

sudo tee /etc/systemd/system/claudia.service > /dev/null << SVCUNIT
[Unit]
Description=Claudia AI task server
After=network.target

[Service]
Type=simple
User=$REMOTE_USER
WorkingDirectory=/home/$REMOTE_USER
Environment=PATH=/home/$REMOTE_USER/.npm-global/bin:/home/$REMOTE_USER/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=\$CLAUDE_BIN
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCUNIT

sudo systemctl daemon-reload
sudo systemctl enable claudia

# Allow the remote user to start/stop/restart the claudia service without
# a password so 'claudia start' and 'claudia stop' work non-interactively.
echo "$REMOTE_USER ALL=(ALL) NOPASSWD: /bin/systemctl start claudia, /bin/systemctl stop claudia, /bin/systemctl restart claudia, /bin/systemctl status claudia" \
    | sudo tee /etc/sudoers.d/claudia > /dev/null
sudo chmod 440 /etc/sudoers.d/claudia

echo "[✓] claudia.service created, enabled, and sudoers entry written"
CLAUDIASVC

ok "Claudia systemd service ready"

# =============================================================================
# Phase 14: Write ~/.config/claudia/config on Mac
# =============================================================================

step "Writing ~/.config/claudia/config..."

mkdir -p "$CLAUDIA_CONFIG_DIR"
cat > "$CLAUDIA_CONFIG_DIR/config" << CONFEOF
# Claudia configuration — written by setup-claudia-remote.sh

MODE=remote
REMOTE_HOST=$REMOTE_HOST
CLAUDIA_PORT=$CLAUDIA_PORT
FS_MCP_PORT=$FS_PORT
SHELL_MCP_PORT=$SHELL_PORT
PROJECTS_DIR=$PROJECTS_DIR
CLAUDIA_SERVER_URL=wss://${REMOTE_ADDR}:${CLAUDIA_PORT:-4443}
# CLAUDIA_TOKEN must be set before claudia-client can connect.
# Set it to the shared bearer token configured on the server, then run: mcp restart
CLAUDIA_TOKEN=
CONFEOF

ok "Config written: $CLAUDIA_CONFIG_DIR/config"
warn "Action required: set CLAUDIA_TOKEN in $CLAUDIA_CONFIG_DIR/config, then run: mcp restart"

# =============================================================================
# Phase 15: Install bin/ helpers to ~/.local/bin
# =============================================================================

step "Installing claudia and mcp helpers..."

if [ -f "$SCRIPT_DIR/bin/claudia" ]; then
    cp "$SCRIPT_DIR/bin/claudia" "$BINDIR/claudia"
    chmod +x "$BINDIR/claudia"
    ok "Installed: claudia"
else
    warn "bin/claudia not found in $SCRIPT_DIR/bin — skipping"
fi

if [ -f "$SCRIPT_DIR/bin/mcp" ]; then
    cp "$SCRIPT_DIR/bin/mcp" "$BINDIR/mcp"
    chmod +x "$BINDIR/mcp"
    ok "Installed: mcp"
else
    warn "bin/mcp not found in $SCRIPT_DIR/bin — skipping"
fi

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
    warn "~/.local/bin is not in your PATH."
    warn "Add to your shell rc: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# =============================================================================
# Done
# =============================================================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  REMOTE SETUP COMPLETE${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Remote host : $REMOTE_HOST"
echo "  Projects    : $PROJECTS_DIR"
echo ""
echo "  REQUIRED before claudia-client can connect:"
echo "    1. Edit $CLAUDIA_CONFIG_DIR/config — fill in CLAUDIA_TOKEN"
echo "    2. Run:  mcp start"
echo ""
echo "  NEXT STEP — run this on your Mac to configure claudia-client:"
echo ""
echo "    bash setup-mcp-host.sh"
echo ""
echo "  Daily workflow:"
echo "    claudia start       # start Claudia on remote, prints URL"
echo "    claudia stop        # stop Claudia"
echo "    claudia logs        # tail Claudia logs"
echo "    claudia ssh         # shell into $REMOTE_HOST"
echo ""
echo "  claudia-client (on this Mac):"
echo "    mcp start           # start claudia-client in background"
echo "    mcp status          # check process and port status"
echo "    mcp stop            # stop claudia-client"
echo "    mcp logs            # tail claudia-client log"
echo ""
