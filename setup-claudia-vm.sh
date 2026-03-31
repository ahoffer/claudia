#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# setup-claudia-vm.sh  (v3)
#
# Creates a Colima Ubuntu VM on macOS with Claude Code CLI + Claudia installed.
# ~/projects is mounted read-write so Claudia can edit your code in-place.
#
# Prerequisites:  brew install colima docker
# Usage:          bash setup-claudia-vm.sh
# Idempotent:     safe to re-run — skips completed steps, recreates helpers
#
# NOTES:
#   - When Claudia is installed globally via npm, the backend on port 4001
#     also serves the frontend. Port 5173 (Vite dev server) is only used
#     when running from source in dev mode.
#   - Claudia binds 0.0.0.0:4001, and Colima's --network-address gives the
#     VM a routable IP. No SSH tunnel needed — browser hits the VM directly.
#
# REMOTE HOSTING:
#   This script assumes a local Colima VM. To run on a remote host instead:
#   1. Skip Colima — install Claude Code + Claudia directly on the remote host
#   2. Mount Mac's ~/projects via SSHFS: see claudia-mount-remote.sh
#
# TODO: Tailscale — install on Mac + remote host for stable private IPs
#   that work from anywhere (brew install tailscale). Replace LAN IPs with
#   Tailscale IPs (100.x.x.x) or MagicDNS hostnames in MCP config and
#   SSHFS mounts. Eliminates IP changes, NAT, port forwarding headaches.
# =============================================================================

PROJECTS_DIR="$HOME/projects"
COLIMA_PROFILE="claudia"
CLAUDIA_PORT=4001
CPU=${CLAUDIA_VM_CPU:-6}
MEM=${CLAUDIA_VM_MEM:-16}
DISK=${CLAUDIA_VM_DISK:-60}
BINDIR="$HOME/.local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
step()  { echo -e "${CYAN}[→]${NC} $*"; }
err()   { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# =============================================================================
# Preflight
# =============================================================================

command -v colima >/dev/null 2>&1 || err "colima not found. Install: brew install colima"
command -v docker >/dev/null 2>&1 || err "docker CLI not found. Install: brew install docker"

mkdir -p "$PROJECTS_DIR"
mkdir -p "$BINDIR"
info "Projects dir: $PROJECTS_DIR"

# =============================================================================
# Create / start Colima VM
# =============================================================================

vm_status() {
    colima list 2>/dev/null | grep -E "^${COLIMA_PROFILE}\b" || true
}

if vm_status | grep -q Running; then
    warn "Colima profile '$COLIMA_PROFILE' already running — skipping VM creation."
elif vm_status | grep -q Stopped; then
    step "Starting existing VM '$COLIMA_PROFILE'..."
    colima start -p "$COLIMA_PROFILE"
else
    step "Creating Colima VM: ${CPU} CPU / ${MEM}GB RAM / ${DISK}GB disk..."
    step "Using Apple Virtualization.framework (--vm-type vz) + virtiofs mounts"
    colima start \
        -p "$COLIMA_PROFILE" \
        --cpu "$CPU" \
        --memory "$MEM" \
        --disk "$DISK" \
        --vm-type vz \
        --mount "${PROJECTS_DIR}:w" \
        --mount-type virtiofs \
        --network-address
fi

info "VM is running."

# =============================================================================
# Helper: run a script inside the VM via stdin (avoids quoting hell)
# =============================================================================

vm_run() {
    local script_file
    script_file=$(mktemp /tmp/colima-setup-XXXXXX.sh)
    trap 'rm -f "$script_file"' RETURN
    cat > "$script_file"
    # -l (login shell) ensures .bashrc is sourced so PATH includes
    # .local/bin and .npm-global/bin where Claude Code and Claudia live.
    colima ssh -p "$COLIMA_PROFILE" -- bash -ls < "$script_file"
}

# =============================================================================
# Install Node.js, Claude Code CLI, Claudia
# =============================================================================

step "Installing packages inside VM (first run takes ~2 min)..."

vm_run << 'VMSCRIPT'
set -euo pipefail

# --- Node.js 22 ---
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    NODE_MAJOR=${NODE_VER#v}
    NODE_MAJOR=${NODE_MAJOR%%.*}
    if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
        echo "[✓] Node.js already installed: $NODE_VER"
    else
        echo "[!] Node.js $NODE_VER too old, upgrading..."
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

# Persist PATH (idempotent — grep guard prevents duplicates)
if ! grep -q '\.local/bin' ~/.bashrc 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

# --- npm global prefix (user-writable, no sudo needed) ---
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
    echo "[→] Installing Claudia globally (user-local, no sudo)..."
    npm install -g @extropolis/claudia
    echo "[✓] Claudia installed"
fi

# --- Playwright Chromium (for MCP browser tools) ---
echo "[→] Ensuring Playwright Chromium is installed..."
npx playwright install-deps chromium 2>/dev/null || true
npx playwright install chromium
echo "[✓] Playwright Chromium ready"
VMSCRIPT

info "All software installed."

# =============================================================================
# Claude Code authentication (idempotent — tests before prompting)
# =============================================================================

step "Checking Claude Code auth..."

# Best-effort auth check: asks Claude to say "hello" and greps for it.
# May false-negative on rate limits or unexpected output; that just means
# the user gets re-prompted to log in, which is harmless.
if colima ssh -p "$COLIMA_PROFILE" -- bash -lc \
    'claude -p "respond with only the word hello" --max-turns 1 2>/dev/null' \
    2>/dev/null | grep -qi hello; then
    info "Claude Code already authenticated — skipping login."
else
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  CLAUDE CODE AUTH (one-time)${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "  'claude login' will print a URL."
    echo "  Open that URL in your Mac browser and sign in with your Max account."
    echo ""
    read -rp "  Press ENTER when ready..."
    echo ""

    colima ssh -p "$COLIMA_PROFILE" -- bash -lc "claude login"

    echo ""
    step "Verifying auth..."
    if colima ssh -p "$COLIMA_PROFILE" -- bash -lc \
        'claude -p "respond with only the word hello" --max-turns 1 2>/dev/null' \
        2>/dev/null | grep -qi hello; then
        info "Claude Code is working!"
    else
        warn "Test didn't produce expected output — you can retry later:"
        warn "  claudia-ssh bash -lc 'claude login'"
    fi
fi

# =============================================================================
# Pull Claude Code configuration from GitHub
#
# Clones https://github.com/ahoffer/claudecode into ~/.claude inside the VM.
# The repo contains settings.json, CLAUDE.md, coding rules, custom agents,
# commands, and hooks. The repo's .gitignore excludes credentials, sessions,
# and other local-only runtime files so they're never touched.
# Idempotent: if already a git repo, just pulls latest.
# =============================================================================

step "Syncing Claude Code config from GitHub..."

vm_run << 'VMSCRIPT'
set -euo pipefail

# Ensure git is available (may not be installed if Node.js was pre-existing)
if ! command -v git &>/dev/null; then
    echo "[→] Installing git..."
    sudo apt-get update -qq && sudo apt-get install -y -qq git
fi

REPO="https://github.com/ahoffer/claudecode.git"
CLAUDE_DIR="$HOME/.claude"

if [ -d "$CLAUDE_DIR/.git" ]; then
    echo "[✓] ~/.claude is already a git repo — pulling latest..."
    cd "$CLAUDE_DIR"
    git pull --ff-only origin main || {
        # Intentional: the GitHub repo is the source of truth for ~/.claude config.
        # Local edits should be committed and pushed there, not kept only in the VM.
        echo "[!] Fast-forward pull failed — resetting to origin/main (local changes will be lost)."
        git fetch origin
        git reset --hard origin/main
    }
else
    echo "[→] Setting up ~/.claude from git repo..."
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
VMSCRIPT

info "Claude Code config synced."

# =============================================================================
# Ensure ~/.local/bin is in Mac PATH
# =============================================================================

if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
    SHELL_RC="$HOME/.zshrc"
else
    SHELL_RC="$HOME/.bashrc"
fi

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
    if ! grep -q '\.local/bin' "$SHELL_RC" 2>/dev/null; then
        {
            echo ""
            echo '# Added by setup-claudia-vm.sh'
            echo 'export PATH="$HOME/.local/bin:$PATH"'
        } >> "$SHELL_RC"
        info "Added ~/.local/bin to PATH in $SHELL_RC"
        warn "Run 'source $SHELL_RC' or open a new terminal for this to take effect."
    fi
    export PATH="$BINDIR:$PATH"
fi

# =============================================================================
# Helper script: claudia-start
#   Boots VM → checks MCP → starts Claudia → health check → prints URL
#
# No SSH tunnel needed — Claudia binds 0.0.0.0 and the VM has a routable
# IP via --network-address. We just hit it directly from the browser.
# =============================================================================

cat > "$BINDIR/claudia-start" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
PROFILE="claudia"
PORT=4001

# --- Ensure VM is running ---
if ! colima list 2>/dev/null | grep -E "^${PROFILE}\b" | grep -q Running; then
    echo "[→] Starting Colima VM '$PROFILE'..."
    colima start -p "$PROFILE"
fi

# --- Get VM's routable IP ---
VM_IP=$(colima list 2>/dev/null | grep -E "^${PROFILE}\b" | awk '{print $NF}')
if [ -z "$VM_IP" ] || [ "$VM_IP" = "-" ]; then
    echo "[✗] Could not get VM IP from 'colima list'. Is --network-address set?"
    exit 1
fi

# --- Check MCP servers on Mac are reachable ---
MCP_OK=true
for port in 8100 8101; do
    if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "[✓] MCP server on :$port is running"
    else
        echo "[✗] MCP server on :$port is NOT running"
        MCP_OK=false
    fi
done
if [ "$MCP_OK" = false ]; then
    echo ""
    echo "[!] MCP servers are not running on this Mac."
    echo "    Claude Code in the VM won't be able to access your files or run commands."
    echo "    Fix: run 'mcp-restart' to restart MCP servers"
    echo ""
    read -rp "    Continue anyway? [y/N] " REPLY
    case "$REPLY" in
        y|Y) echo "[→] Continuing without MCP..." ;;
        *) echo "Aborted."; exit 1 ;;
    esac
fi

# --- Start Claudia inside VM (idempotent) ---
echo "[→] Starting Claudia inside VM..."
colima ssh -p "$PROFILE" -- bash -ls << 'INNER'
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

if ss -tlnp 2>/dev/null | grep -q ':4001'; then
    echo "[✓] Claudia already running on port 4001"
else
    pkill -f 'node.*claudia' 2>/dev/null || true
    sleep 1

    nohup claudia > /tmp/claudia.log 2>&1 &
    disown

    echo -n "[→] Waiting for Claudia backend"
    for i in $(seq 1 30); do
        if ss -tlnp 2>/dev/null | grep -q ':4001'; then
            echo ""
            echo "[✓] Claudia is ready"
            break
        fi
        echo -n "."
        sleep 1
    done

    if ! ss -tlnp 2>/dev/null | grep -q ':4001'; then
        echo ""
        echo "[✗] Claudia failed to start. Last 20 lines of log:"
        tail -20 /tmp/claudia.log 2>/dev/null || true
        exit 1
    fi
fi
INNER

# --- Health check via routable IP ---
echo -n "[→] Verifying Claudia is reachable at $VM_IP:$PORT"
HEALTH_OK=false
for _ in $(seq 1 10); do
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://$VM_IP:$PORT/" 2>/dev/null || true)
    if [ "$HTTP_CODE" = "200" ]; then
        HEALTH_OK=true
        echo ""
        echo "[✓] Claudia is live — HTTP $HTTP_CODE"
        break
    fi
    echo -n "."
    sleep 1
done

if [ "$HEALTH_OK" = false ]; then
    echo ""
    echo "[✗] Health check failed (last HTTP code: ${HTTP_CODE:-none})"
    echo "    Try: claudia-logs"
    exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Claudia is running at http://$VM_IP:$PORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
EOF
chmod +x "$BINDIR/claudia-start"
info "Created: claudia-start"

# =============================================================================
# Helper script: claudia-stop
# =============================================================================

cat > "$BINDIR/claudia-stop" << 'EOF'
#!/usr/bin/env bash
PROFILE="claudia"
echo "[→] Stopping Claudia inside VM..."
colima ssh -p "$PROFILE" -- pkill -f 'node.*claudia' \
    && echo "[✓] Claudia stopped" \
    || echo "[!] Claudia was not running"
EOF
chmod +x "$BINDIR/claudia-stop"
info "Created: claudia-stop"

# =============================================================================
# Helper script: claudia-ssh
# =============================================================================

cat > "$BINDIR/claudia-ssh" << 'EOF'
#!/usr/bin/env bash
if [ $# -eq 0 ]; then
    colima ssh -p claudia
else
    colima ssh -p claudia -- "$@"
fi
EOF
chmod +x "$BINDIR/claudia-ssh"
info "Created: claudia-ssh"

# =============================================================================
# Helper script: claudia-logs
# =============================================================================

cat > "$BINDIR/claudia-logs" << 'EOF'
#!/usr/bin/env bash
colima ssh -p claudia -- tail -f /tmp/claudia.log
EOF
chmod +x "$BINDIR/claudia-logs"
info "Created: claudia-logs"

# =============================================================================
# Helper script: claudia-url
#   Prints the Claudia URL (handy for scripting or copy-paste)
# =============================================================================

cat > "$BINDIR/claudia-url" << 'EOF'
#!/usr/bin/env bash
PROFILE="claudia"
VM_IP=$(colima list 2>/dev/null | grep -E "^${PROFILE}\b" | awk '{print $NF}')
if [ -z "$VM_IP" ] || [ "$VM_IP" = "-" ]; then
    echo "VM not running or no IP assigned" >&2; exit 1
fi
echo "http://$VM_IP:4001"
EOF
chmod +x "$BINDIR/claudia-url"
info "Created: claudia-url"

# =============================================================================
# Done
# =============================================================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  SETUP COMPLETE${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Daily workflow:"
echo "    1. claudia-start          # boots VM, starts Claudia, prints URL"
echo "    2. Open the URL it prints (http://<vm-ip>:$CLAUDIA_PORT)"
echo "    3. Add workspace path:    $PROJECTS_DIR/<your-project>"
echo ""
echo "  Other commands:"
echo "    claudia-stop              # stop Claudia (VM stays up)"
echo "    claudia-ssh               # SSH into the VM"
echo "    claudia-logs              # tail Claudia logs"
echo "    claudia-url               # print Claudia URL"
echo "    colima stop -p $COLIMA_PROFILE       # shut down the VM"
echo ""
