#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# setup-mcp-host.sh  (v2 — post network audit)
#
# SCRIPT 2 OF 2 — Run this SECOND, after setup-claudia-vm.sh.
# The Colima VM must be running before you run this script.
#
# Run on your Mac. Installs MCP servers that Claude Code in the Colima VM
# connects to over HTTP. Claude can read/write files and run commands on
# your Mac without virtiofs mounts.
#
# MCP servers (on Mac, reachable from VM):
#   Port 8100 — Filesystem MCP  (read/write ~/projects)
#   Port 8101 — Shell MCP       (execute commands, read/write files)
#
# IMPORTANT NETWORK NOTES:
#   - supergateway's --baseUrl MUST be set to the host IP (not localhost),
#     because it returns the message POST URL to SSE clients in the
#     "endpoint" event. Without this, the VM client would POST to its
#     own localhost and fail silently.
#   - macOS firewall must allow incoming connections on 8100/8101 from
#     the VM's virtual network.
#   - Node.js http.listen(port) defaults to 0.0.0.0 (all interfaces).
#
# REMOTE HOSTING:
#   When Claude Code runs on a remote host (not a local VM), this Mac
#   must be reachable from that host. Current approach: use the LAN IP.
#   For SSHFS file mounts: see claudia-mount-remote.sh
#
# TODO: Tailscale — install on Mac + remote host for stable private IPs
#   (brew install tailscale). Replace HOST_IP discovery with Tailscale IP
#   (100.x.x.x) or MagicDNS hostname. This solves:
#     - Mac IP changes (WiFi/DHCP/VPN)
#     - NAT traversal (remote host can reach Mac from anywhere)
#     - Encryption (WireGuard under the hood)
#   After Tailscale: mcp-reconfig to update MCP server URLs.
#
# Prerequisites: node 18+, colima VM 'claudia' running
# Usage:         bash setup-mcp-host.sh
# Idempotent:    safe to re-run
# =============================================================================

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
PROJECTS_DIR="$HOME/projects"
COLIMA_PROFILE="claudia"
MCP_DIR="$HOME/.local/share/claudia-mcp"
LOG_DIR="$MCP_DIR/logs"
BINDIR="$HOME/.local/bin"
FS_PORT=8100
SHELL_PORT=8101
PLIST_DIR="$HOME/Library/LaunchAgents"
FS_LABEL="com.claudia.mcp.filesystem"
SHELL_LABEL="com.claudia.mcp.shell"

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

command -v node >/dev/null 2>&1 || err "node not found on PATH. Install node or ensure nvm is loaded."
command -v npm >/dev/null 2>&1  || err "npm not found on PATH."
command -v colima >/dev/null 2>&1 || err "colima not found. Install: brew install colima"

NODE_BIN_PATH=$(which node)
NODE_DIR=$(dirname "$NODE_BIN_PATH")
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || err "Node.js 18+ required (found $(node -v))"

info "Using node at $NODE_BIN_PATH (v$(node -v | sed 's/v//'))"

mkdir -p "$MCP_DIR" "$LOG_DIR" "$BINDIR" "$PLIST_DIR" "$PROJECTS_DIR"

# Save script location so mcp-reconfig can find it later
echo "$SCRIPT_PATH" > "$MCP_DIR/setup-script-path.txt"

# =============================================================================
# Phase 1: Discover host IP reachable from VM
#
# This must happen FIRST because supergateway's --baseUrl needs it.
# Without --baseUrl, supergateway tells SSE clients to POST to localhost,
# which from the VM means the VM's own localhost — total failure.
# =============================================================================

step "Discovering host IP reachable from Colima VM..."

HOST_IP=""

if ! colima list 2>/dev/null | grep -E "^${COLIMA_PROFILE}\b" | grep -q Running; then
    err "Colima VM '$COLIMA_PROFILE' is not running. Run setup-claudia-vm.sh first, then: colima start -p $COLIMA_PROFILE"
fi

# Method 1: Match VM's subnet to find the correct gateway
# The VM may have multiple default routes (VPN, Docker, etc).
# We need the gateway on the same subnet as the VM's colima IP.
VM_IP=$(colima list 2>/dev/null | grep -E "^${COLIMA_PROFILE}\b" | awk '{print $NF}')
VM_SUBNET=${VM_IP%.*}  # e.g. 192.168.64.3 → 192.168.64

if [ -n "$VM_SUBNET" ] && [ "$VM_SUBNET" != "$VM_IP" ]; then
    # Get all default gateways, pick the one matching VM's subnet
    ALL_GW=$(colima ssh -p "$COLIMA_PROFILE" -- ip route 2>/dev/null | awk '/default/{print $3}' || true)
    for gw in $ALL_GW; do
        if [ "${gw%.*}" = "$VM_SUBNET" ]; then
            HOST_IP="$gw"
            info "Host IP from VM gateway: $HOST_IP (matches VM subnet $VM_SUBNET.*)"
            break
        fi
    done
fi

# Method 2: Fallback to en0
if [ -z "$HOST_IP" ]; then
    EN0=$(ipconfig getifaddr en0 2>/dev/null || true)
    if [ -n "$EN0" ]; then
        HOST_IP="$EN0"
        info "Host IP from en0: $HOST_IP"
    fi
fi

# Method 3: Fallback to en1
if [ -z "$HOST_IP" ]; then
    EN1=$(ipconfig getifaddr en1 2>/dev/null || true)
    if [ -n "$EN1" ]; then
        HOST_IP="$EN1"
        info "Host IP from en1: $HOST_IP"
    fi
fi

if [ -z "$HOST_IP" ]; then
    err "Could not discover host IP. Ensure Mac has a network connection and VM is running."
fi

# Save IP for helper scripts
echo "$HOST_IP" > "$MCP_DIR/host-ip.txt"

# =============================================================================
# Phase 2: macOS Firewall check
# =============================================================================

step "Checking macOS firewall..."

# Check if firewall is enabled (returns 1 if enabled)
if /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -q "enabled"; then
    warn "macOS Firewall is ENABLED."
    warn "The VM needs to reach ports $FS_PORT and $SHELL_PORT on this Mac."
    warn "When the MCP servers start, macOS may show a popup asking to allow"
    warn "incoming connections for 'node'. Click ALLOW."
    warn ""
    warn "If connections still fail, you can add an exception:"
    warn "  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \$(which node)"
    warn "  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp \$(which node)"
    echo ""
else
    info "macOS Firewall is disabled (no issue)"
fi

# =============================================================================
# Phase 3: Install npm packages
# =============================================================================

step "Setting up MCP project directory..."

cat > "$MCP_DIR/package.json" << 'PKGJSON'
{
  "name": "claudia-mcp-host",
  "private": true,
  "type": "module",
  "dependencies": {
    "supergateway": "^1.0.0",
    "@modelcontextprotocol/server-filesystem": "^0.6.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0"
  }
}
PKGJSON

(cd "$MCP_DIR" && npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -1)
info "npm packages installed"

SG_BIN="$MCP_DIR/node_modules/.bin/supergateway"
[ -x "$SG_BIN" ] || err "supergateway binary not found at $SG_BIN"

FS_BIN=$(find "$MCP_DIR/node_modules/.bin" -name 'mcp-server-filesystem' 2>/dev/null | head -1)
if [ -z "$FS_BIN" ]; then
    err "mcp-server-filesystem not found in $MCP_DIR/node_modules/.bin/"
fi
info "Found binaries: supergateway, $(basename "$FS_BIN")"

# =============================================================================
# Phase 4: Create shell MCP server
# =============================================================================

step "Writing shell MCP server..."

cat > "$MCP_DIR/shell-server.mjs" << 'SHELLSRV'
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

const execAsync = promisify(exec);
const PROJECTS = process.env.PROJECTS_DIR || `${process.env.HOME}/projects`;

const SERVER_NAME = "mac-shell";
const SERVER_VERSION = "1.0.0";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

console.error(`[${SERVER_NAME}] v${SERVER_VERSION} starting at ${new Date().toISOString()}`);

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_command",
      description:
        "Execute a shell command on the host Mac. Runs in bash. " +
        "Default cwd is ~/projects. Use for: git, make, npm, cargo, etc.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          cwd: { type: "string", description: "Working directory (absolute path)" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the host Mac (absolute path)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file on the host Mac (creates dirs if needed)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_directory",
      description: "List files and directories at a path on the host Mac",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.error(`[${SERVER_NAME}] tool=${name} args=${JSON.stringify(args)}`);
  try {
    switch (name) {
      case "execute_command": {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: args.cwd || PROJECTS,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          shell: "/bin/bash",
          // Inherit the full parent environment intentionally
          env: { ...process.env },
        });
        const out = [stdout, stderr && `--- stderr ---\n${stderr}`]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text", text: out || "(no output)" }] };
      }
      case "read_file": {
        const info = await stat(args.path);
        if (info.size > MAX_FILE_SIZE) {
          return {
            content: [{ type: "text", text: `Error: file is ${(info.size / 1024 / 1024).toFixed(1)} MB, exceeds 50 MB limit` }],
            isError: true,
          };
        }
        const text = await readFile(args.path, "utf8");
        return { content: [{ type: "text", text }] };
      }
      case "write_file": {
        const dir = dirname(args.path);
        await mkdir(dir, { recursive: true });
        await writeFile(args.path, args.content, "utf8");
        return { content: [{ type: "text", text: `Wrote ${args.content.length} bytes to ${args.path}` }] };
      }
      case "list_directory": {
        const entries = await readdir(args.path);
        const detailed = await Promise.all(
          entries.map(async (e) => {
            const s = await stat(join(args.path, e)).catch(() => null);
            return s ? `${s.isDirectory() ? "d" : "-"} ${e}` : `? ${e}`;
          })
        );
        return { content: [{ type: "text", text: detailed.join("\n") }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    console.error(`[${SERVER_NAME}] error in ${name}: ${e.message}`);
    if (e.killed) {
      return {
        content: [{ type: "text", text: "Command timed out after 120s" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Error: ${e.message}\n${e.stderr || ""}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
SHELLSRV

info "Shell MCP server written"

# =============================================================================
# Phase 5: Create launcher scripts WITH --baseUrl
#
# CRITICAL: --baseUrl tells supergateway what URL to advertise to SSE
# clients in the "endpoint" event. Without it, supergateway defaults to
# http://localhost:<port>/message — which from the VM means the VM's
# own localhost, not the Mac. Total connectivity failure.
# =============================================================================

step "Creating launcher scripts (baseUrl = http://$HOST_IP)..."

cat > "$MCP_DIR/start-filesystem.sh" << FSEOF
#!/usr/bin/env bash
cd "$MCP_DIR"
exec "$SG_BIN" \\
  --stdio "$FS_BIN $PROJECTS_DIR" \\
  --port $FS_PORT \\
  --baseUrl "http://$HOST_IP:$FS_PORT"
FSEOF
chmod +x "$MCP_DIR/start-filesystem.sh"

cat > "$MCP_DIR/start-shell.sh" << SHEOF
#!/usr/bin/env bash
cd "$MCP_DIR"
export PROJECTS_DIR="$PROJECTS_DIR"
exec "$SG_BIN" \\
  --stdio "$NODE_BIN_PATH $MCP_DIR/shell-server.mjs" \\
  --port $SHELL_PORT \\
  --baseUrl "http://$HOST_IP:$SHELL_PORT"
SHEOF
chmod +x "$MCP_DIR/start-shell.sh"

info "Launcher scripts created with baseUrl http://$HOST_IP"

# =============================================================================
# Phase 6: Create and load launchd services
# =============================================================================

step "Creating launchd services..."

# Unload existing (idempotent)
launchctl bootout "gui/$(id -u)/$FS_LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$SHELL_LABEL" 2>/dev/null || true

cat > "$PLIST_DIR/$FS_LABEL.plist" << FSPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$FS_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$MCP_DIR/start-filesystem.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/filesystem-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/filesystem-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
FSPLIST

cat > "$PLIST_DIR/$SHELL_LABEL.plist" << SHPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SHELL_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$MCP_DIR/start-shell.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/shell-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/shell-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
SHPLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST_DIR/$FS_LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DIR/$SHELL_LABEL.plist"

info "launchd services loaded"

# =============================================================================
# Phase 7: Health checks — local ports, VM TCP, MCP SSE handshake
# =============================================================================

step "Waiting for MCP servers to start..."

check_port() {
    local port=$1 name=$2
    for _ in $(seq 1 15); do
        if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
            info "$name listening on port $port"
            return 0
        fi
        sleep 1
    done
    warn "$name NOT listening on port $port after 15s"
    warn "Check logs: cat $LOG_DIR/${name}-stderr.log"
    return 1
}

FS_OK=false; SHELL_OK=false
check_port $FS_PORT "filesystem" && FS_OK=true
check_port $SHELL_PORT "shell" && SHELL_OK=true

if [ "$FS_OK" = false ] || [ "$SHELL_OK" = false ]; then
    warn "Some services failed to start. Recent logs:"
    echo "--- filesystem stderr ---"
    tail -10 "$LOG_DIR/filesystem-stderr.log" 2>/dev/null || echo "(no log)"
    echo "--- shell stderr ---"
    tail -10 "$LOG_DIR/shell-stderr.log" 2>/dev/null || echo "(no log)"
fi

# --- VM → Mac TCP connectivity test ---
step "Testing TCP connectivity from VM to Mac ($HOST_IP)..."

VM_TCP_OK=true
for port in $FS_PORT $SHELL_PORT; do
    if colima ssh -p "$COLIMA_PROFILE" -- bash -c "echo > /dev/tcp/$HOST_IP/$port" 2>/dev/null; then
        info "VM → $HOST_IP:$port TCP OK"
    else
        warn "VM → $HOST_IP:$port TCP FAILED"
        warn "macOS firewall may be blocking. Allow 'node' in System Settings > Network > Firewall."
        VM_TCP_OK=false
    fi
done

# --- MCP SSE handshake test from VM ---
if [ "$VM_TCP_OK" = true ]; then
    step "Testing MCP SSE handshake from VM..."
    for port_name in "$FS_PORT:filesystem" "$SHELL_PORT:shell"; do
        port=${port_name%%:*}
        name=${port_name##*:}
        SSE_RESPONSE=$(colima ssh -p "$COLIMA_PROFILE" -- \
            curl -s --max-time 5 -H "Accept: text/event-stream" "http://$HOST_IP:$port/sse" 2>/dev/null | head -5 || true)
        if echo "$SSE_RESPONSE" | grep -q "event:"; then
            info "$name MCP SSE handshake OK from VM"
        else
            warn "$name MCP SSE handshake failed from VM"
            warn "Response: ${SSE_RESPONSE:-<empty>}"
        fi
    done
fi

# =============================================================================
# Phase 8: Configure Claude Code in VM
# =============================================================================

step "Configuring Claude Code in VM to use Mac MCP servers..."

# Remove existing configs (idempotent)
colima ssh -p "$COLIMA_PROFILE" -- bash -lc "claude mcp remove mac-filesystem 2>/dev/null || true"
colima ssh -p "$COLIMA_PROFILE" -- bash -lc "claude mcp remove mac-shell 2>/dev/null || true"

# Add MCP servers using SSE transport with the Mac's IP
colima ssh -p "$COLIMA_PROFILE" -- bash -lc \
    "claude mcp add --transport sse mac-filesystem http://$HOST_IP:$FS_PORT/sse --scope user"
colima ssh -p "$COLIMA_PROFILE" -- bash -lc \
    "claude mcp add --transport sse mac-shell http://$HOST_IP:$SHELL_PORT/sse --scope user"

info "Claude Code configured with remote MCP servers"

# Verify registration
if colima ssh -p "$COLIMA_PROFILE" -- bash -lc "claude mcp list 2>/dev/null" | grep -q "mac-filesystem"; then
    info "mac-filesystem registered in Claude Code"
else
    warn "mac-filesystem not visible in 'claude mcp list'"
fi
if colima ssh -p "$COLIMA_PROFILE" -- bash -lc "claude mcp list 2>/dev/null" | grep -q "mac-shell"; then
    info "mac-shell registered in Claude Code"
else
    warn "mac-shell not visible in 'claude mcp list'"
fi

# =============================================================================
# Phase 9: Create helper scripts (always recreated)
# =============================================================================

step "Creating helper scripts..."

cat > "$BINDIR/mcp-status" << 'STATUSEOF'
#!/usr/bin/env bash
echo "=== MCP Server Status ==="
echo ""
for label in com.claudia.mcp.filesystem com.claudia.mcp.shell; do
    name=${label##*.}
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        pid=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -m1 'pid' | awk '{print $NF}')
        echo "[✓] $name (pid: ${pid:-unknown})"
    else
        echo "[✗] $name (not loaded)"
    fi
done
echo ""
echo "Ports:"
for port in 8100 8101; do
    if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "  [✓] :$port listening"
    else
        echo "  [✗] :$port not listening"
    fi
done
echo ""
HOST_IP=$(cat "$HOME/.local/share/claudia-mcp/host-ip.txt" 2>/dev/null || echo "unknown")
echo "Host IP for VM: $HOST_IP"
echo "Logs: ~/.local/share/claudia-mcp/logs/"
STATUSEOF
chmod +x "$BINDIR/mcp-status"

cat > "$BINDIR/mcp-restart" << RESTARTEOF
#!/usr/bin/env bash
echo "[→] Restarting MCP services..."
launchctl kickstart -k "gui/\$(id -u)/$FS_LABEL" 2>/dev/null && echo "[✓] filesystem restarted" || echo "[✗] filesystem restart failed"
launchctl kickstart -k "gui/\$(id -u)/$SHELL_LABEL" 2>/dev/null && echo "[✓] shell restarted" || echo "[✗] shell restart failed"
sleep 2
mcp-status
RESTARTEOF
chmod +x "$BINDIR/mcp-restart"

cat > "$BINDIR/mcp-logs" << 'LOGSEOF'
#!/usr/bin/env bash
DIR="$HOME/.local/share/claudia-mcp/logs"
if [ "${1:-}" = "fs" ] || [ "${1:-}" = "filesystem" ]; then
    tail -f "$DIR/filesystem-stderr.log"
elif [ "${1:-}" = "shell" ]; then
    tail -f "$DIR/shell-stderr.log"
else
    echo "Usage: mcp-logs [fs|shell]"
    echo ""
    echo "Recent filesystem log:"
    tail -5 "$DIR/filesystem-stderr.log" 2>/dev/null || echo "(empty)"
    echo ""
    echo "Recent shell log:"
    tail -5 "$DIR/shell-stderr.log" 2>/dev/null || echo "(empty)"
fi
LOGSEOF
chmod +x "$BINDIR/mcp-logs"

cat > "$BINDIR/mcp-stop" << STOPEOF
#!/usr/bin/env bash
echo "[→] Stopping MCP services..."
launchctl bootout "gui/\$(id -u)/$FS_LABEL" 2>/dev/null && echo "[✓] filesystem stopped" || echo "[!] filesystem was not running"
launchctl bootout "gui/\$(id -u)/$SHELL_LABEL" 2>/dev/null && echo "[✓] shell stopped" || echo "[!] shell was not running"
STOPEOF
chmod +x "$BINDIR/mcp-stop"

cat > "$BINDIR/mcp-reconfig" << 'RECONFIGEOF'
#!/usr/bin/env bash
# Re-run when Mac IP changes (DHCP, WiFi switch, VPN toggle)
SETUP_SCRIPT="$(cat "$HOME/.local/share/claudia-mcp/setup-script-path.txt" 2>/dev/null)"
if [ -n "$SETUP_SCRIPT" ] && [ -f "$SETUP_SCRIPT" ]; then
    echo "[→] Re-running MCP host setup to pick up new IP..."
    bash "$SETUP_SCRIPT"
else
    echo "[!] Could not find setup-mcp-host.sh — re-download and run it"
    exit 1
fi
RECONFIGEOF
chmod +x "$BINDIR/mcp-reconfig"

info "Created: mcp-status, mcp-restart, mcp-logs, mcp-stop, mcp-reconfig"

# =============================================================================
# Done
# =============================================================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  MCP HOST SETUP COMPLETE${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  MCP servers running on Mac:"
echo "    :$FS_PORT — Filesystem (read/write $PROJECTS_DIR)"
echo "    :$SHELL_PORT — Shell     (execute commands on Mac)"
echo "    Host IP:  $HOST_IP (used by VM to reach Mac)"
echo ""
echo "  Claude Code in VM is configured. When you start a Claude session,"
echo "  it can use mac-filesystem and mac-shell tools to reach your Mac."
echo ""
echo "  Commands:"
echo "    mcp-status       # health check"
echo "    mcp-restart      # restart services"
echo "    mcp-logs fs      # tail filesystem log"
echo "    mcp-logs shell   # tail shell log"
echo "    mcp-stop         # stop services"
echo "    mcp-reconfig     # re-run setup (after IP change)"
echo ""
echo "  If Mac IP changes (WiFi switch, DHCP renewal):"
echo "    Re-run this script or: mcp-reconfig"
echo ""
