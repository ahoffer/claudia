#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# setup-claudia-remote.sh
#
# Run on your Mac. Sets up a remote Ubuntu host to run Claude Code + Claudia,
# with Mac's ~/projects accessible via SSHFS.
#
# Prerequisites:
#   - SSH access to the remote host (password or existing key)
#   - macOS Remote Login enabled: System Settings > General > Sharing > Remote Login
#   - setup-mcp-host.sh has been run (MCP servers running on Mac)
#
# Usage:
#   bash setup-claudia-remote.sh user@host
#
# What it does (all over SSH from this Mac):
#   1.  Verifies SSH access to remote host
#   2.  Discovers Mac IP reachable from remote
#   3.  Generates SSH keypair on remote for Mac access (SSHFS)
#   4.  Authorizes remote's key on Mac
#   5.  Configures SSH client on remote (mac alias)
#   6.  Tests remote → Mac SSH
#   7.  Installs sshfs + fuse3 on remote
#   8.  Creates systemd automount for Mac ~/projects
#   9.  Installs Node.js 22, Claude Code CLI, Claudia
#   10. Runs 'claude login' (interactive — opens URL in your Mac browser)
#   11. Syncs ~/.claude config from GitHub
#   12. Configures Claude Code MCP servers (mac-filesystem, mac-shell)
#   13. Creates systemd service for Claudia
#   14. Writes ~/.config/claudia/config on this Mac
#   15. Installs bin/claudia and bin/mcp helpers to ~/.local/bin
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
    echo "  - macOS Remote Login enabled (System Settings > General > Sharing > Remote Login)"
    echo "  - setup-mcp-host.sh already run on this Mac"
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
# Phase 3: Check macOS Remote Login (SSH server on Mac)
# =============================================================================

step "Checking macOS Remote Login..."

if sudo systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
    ok "Remote Login is enabled"
else
    warn "Remote Login appears to be off on this Mac."
    warn "The remote host needs to SSH back to your Mac for SSHFS mounts."
    echo ""
    echo "  Enable it: System Settings > General > Sharing > Remote Login"
    echo "  Or run:    sudo systemsetup -setremotelogin on"
    echo ""
    read -rp "  Enable Remote Login now? [Y/n] " REPLY
    case "${REPLY:-Y}" in
        n|N) warn "Skipping — SSHFS mount will fail without this." ;;
        *)
            sudo systemsetup -setremotelogin on \
                && ok "Remote Login enabled" \
                || warn "Could not enable — do it manually in System Settings."
            ;;
    esac
fi

# =============================================================================
# Phase 4: Generate SSH keypair on remote for Mac access
# =============================================================================

step "Setting up SSH keypair on remote..."

remote_run << 'SSHSCRIPT'
set -euo pipefail
KEY="$HOME/.ssh/claudia_ed25519"

if [ -f "$KEY" ]; then
    echo "[✓] SSH keypair already exists: $KEY"
else
    echo "[→] Generating Ed25519 keypair..."
    ssh-keygen -t ed25519 -C "claudia-remote" -f "$KEY" -N ""
    echo "[✓] Keypair created: $KEY"
fi
chmod 600 "$KEY"
chmod 644 "${KEY}.pub"
SSHSCRIPT

ok "SSH keypair ready on remote"

# =============================================================================
# Phase 5: Authorize remote's key on this Mac
# =============================================================================

step "Authorizing remote host key on Mac..."

REMOTE_PUBKEY=$(remote_cmd -- cat '$HOME/.ssh/claudia_ed25519.pub')
if [ -z "$REMOTE_PUBKEY" ]; then
    err "Could not read public key from remote host."
fi

AUTH_KEYS="$HOME/.ssh/authorized_keys"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

if grep -qF "$REMOTE_PUBKEY" "$AUTH_KEYS" 2>/dev/null; then
    ok "Remote key already in Mac authorized_keys"
else
    echo "$REMOTE_PUBKEY" >> "$AUTH_KEYS"
    ok "Remote key added to Mac authorized_keys"
fi

# =============================================================================
# Phase 6: Configure SSH client on remote (mac alias)
# =============================================================================

step "Configuring SSH client on remote..."

remote_run << SSHCONF
set -euo pipefail
SSH_CONFIG="\$HOME/.ssh/config"
touch "\$SSH_CONFIG"
chmod 600 "\$SSH_CONFIG"

# Remove any existing 'Host mac' block (idempotent)
if grep -q '^Host mac$' "\$SSH_CONFIG" 2>/dev/null; then
    # Remove the block — from 'Host mac' to the next 'Host ' line (or EOF)
    awk '/^Host mac\$/{skip=1} skip && /^Host / && !/^Host mac\$/{skip=0} !skip' \
        "\$SSH_CONFIG" > "\$SSH_CONFIG.tmp" && mv "\$SSH_CONFIG.tmp" "\$SSH_CONFIG"
fi

cat >> "\$SSH_CONFIG" << 'EOF'
Host mac
    HostName $HOST_IP
    User $MAC_USER
    IdentityFile ~/.ssh/claudia_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
    StrictHostKeyChecking accept-new
EOF

echo "[✓] SSH config written (Host mac → $HOST_IP)"
SSHCONF

# =============================================================================
# Phase 7: Test remote → Mac SSH
# =============================================================================

step "Testing SSH from remote to Mac..."

if remote_cmd -- ssh -o ConnectTimeout=10 -o BatchMode=yes mac "echo ok" 2>/dev/null | grep -q ok; then
    ok "Remote → Mac SSH works"
else
    warn "Remote → Mac SSH test failed."
    warn "Check: Mac Remote Login is on, authorized_keys was written, firewall allows port 22."
    warn "You can test manually: ssh $REMOTE_HOST then: ssh mac 'echo ok'"
    read -rp "  Continue anyway? [y/N] " REPLY
    case "$REPLY" in
        y|Y) warn "Continuing — SSHFS mount may fail." ;;
        *) err "Aborted." ;;
    esac
fi

# =============================================================================
# Phase 8: Install SSHFS + FUSE on remote
# =============================================================================

step "Installing SSHFS on remote..."

remote_run << 'FUSEINSTALL'
set -euo pipefail
if command -v sshfs &>/dev/null; then
    echo "[✓] sshfs already installed: $(sshfs --version 2>&1 | head -1)"
else
    echo "[→] Installing sshfs..."
    sudo apt-get update -qq
    sudo apt-get install -y sshfs fuse3
    echo "[✓] sshfs installed"
fi

# Allow other users to access FUSE mounts (needed so Claudia's Node process
# can read the mounted files even if it runs as a different uid)
if grep -q '^#.*user_allow_other' /etc/fuse.conf 2>/dev/null; then
    sudo sed -i 's/^#\s*user_allow_other/user_allow_other/' /etc/fuse.conf
    echo "[✓] Enabled user_allow_other in /etc/fuse.conf"
elif ! grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null; then
    echo "user_allow_other" | sudo tee -a /etc/fuse.conf >/dev/null
    echo "[✓] Added user_allow_other to /etc/fuse.conf"
else
    echo "[✓] user_allow_other already set"
fi
FUSEINSTALL

ok "SSHFS ready on remote"

# =============================================================================
# Phase 9: Create systemd automount for Mac ~/projects
#
# Mounts mac:/Users/<mac-user>/projects at /Users/<mac-user>/projects on the
# remote, preserving path structure so Claudia workspace paths match exactly.
#
# systemd unit name = path with / → - and leading / dropped:
#   /Users/aaron/projects → Users-aaron-projects
# =============================================================================

step "Setting up systemd automount for Mac ~/projects..."

MOUNT_PATH="/Users/${MAC_USER}/projects"
# systemd-escape: / → -, leading / dropped
UNIT_STEM="Users-${MAC_USER}-projects"

remote_run << AUTOMOUNT
set -euo pipefail

MOUNT_PATH="$MOUNT_PATH"
UNIT_STEM="$UNIT_STEM"
MAC_USER="$MAC_USER"

# Create mount point
sudo mkdir -p "\$MOUNT_PATH"
sudo chown "$REMOTE_USER":"$REMOTE_USER" "\$MOUNT_PATH" 2>/dev/null || true
echo "[✓] Mount point: \$MOUNT_PATH"

# .mount unit
sudo tee "/etc/systemd/system/\${UNIT_STEM}.mount" > /dev/null << MOUNTUNIT
[Unit]
Description=Mac ~/projects via SSHFS
After=network-online.target
Wants=network-online.target

[Mount]
What=mac:$PROJECTS_DIR
Where=\$MOUNT_PATH
Type=fuse.sshfs
Options=_netdev,allow_other,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,IdentityFile=/home/$REMOTE_USER/.ssh/claudia_ed25519,StrictHostKeyChecking=accept-new,uid=\$(id -u $REMOTE_USER),gid=\$(id -g $REMOTE_USER)
TimeoutSec=60

[Install]
WantedBy=multi-user.target
MOUNTUNIT

# .automount unit — remounts on access after disconnect
sudo tee "/etc/systemd/system/\${UNIT_STEM}.automount" > /dev/null << AUTOMOUNTUNIT
[Unit]
Description=Automount Mac ~/projects via SSHFS
After=network-online.target
Wants=network-online.target

[Automount]
Where=\$MOUNT_PATH
TimeoutIdleSec=0

[Install]
WantedBy=multi-user.target
AUTOMOUNTUNIT

sudo systemctl daemon-reload
sudo systemctl enable "\${UNIT_STEM}.automount"
sudo systemctl restart "\${UNIT_STEM}.automount"

# Trigger the mount by listing the directory
ls "\$MOUNT_PATH" >/dev/null 2>&1 && echo "[✓] SSHFS mount active: \$MOUNT_PATH" \
    || echo "[!] Mount trigger failed — run: systemctl status \${UNIT_STEM}.mount"
AUTOMOUNT

ok "Systemd automount configured"

# =============================================================================
# Phase 10: Install Node.js 22, Claude Code CLI, Claudia
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
    npm install -g @extropolis/claudia
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

# Get full paths inside remote
CLAUDE_BIN=\$(bash -lc 'which claudia 2>/dev/null' || true)
if [ -z "\$CLAUDE_BIN" ]; then
    CLAUDE_BIN="\$HOME/.npm-global/bin/claudia"
fi

sudo tee /etc/systemd/system/claudia.service > /dev/null << SVCUNIT
[Unit]
Description=Claudia AI task server
After=network.target ${UNIT_STEM}.automount
Wants=${UNIT_STEM}.automount

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
# Edit MAC_IP if your Mac's network IP changes, then run: mcp restart

MODE=remote
REMOTE_HOST=$REMOTE_HOST
CLAUDIA_PORT=$CLAUDIA_PORT
FS_MCP_PORT=$FS_PORT
SHELL_MCP_PORT=$SHELL_PORT
PROJECTS_DIR=$PROJECTS_DIR
MAC_IP=$HOST_IP
CONFEOF

ok "Config written: $CLAUDIA_CONFIG_DIR/config"

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
echo "  Mac IP      : $HOST_IP"
echo "  Projects    : $MOUNT_PATH (SSHFS automount)"
echo ""
echo "  NEXT STEP — run this to start MCP servers on Mac and configure"
echo "  Claude Code on the remote to use them:"
echo ""
echo "    bash setup-mcp-host.sh --remote $REMOTE_HOST"
echo ""
echo "  Daily workflow (after MCP setup):"
echo "    claudia start     # starts Claudia, prints URL"
echo "    claudia stop      # stop Claudia"
echo "    claudia logs      # tail Claudia logs"
echo "    claudia ssh       # shell into $REMOTE_HOST"
echo "    claudia trust /Users/$MAC_USER/projects/myapp"
echo ""
echo "  MCP servers (on this Mac):"
echo "    mcp status        # check ports"
echo "    mcp restart       # restart if needed"
echo "    mcp logs fs       # tail filesystem log"
echo ""
echo "  If Mac IP changes:"
echo "    1. Update MAC_IP in $CLAUDIA_CONFIG_DIR/config"
echo "    2. Re-run: bash setup-mcp-host.sh --remote $REMOTE_HOST"
echo ""
