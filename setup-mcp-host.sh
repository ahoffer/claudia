#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# setup-mcp-host.sh  (v3 — local VM + remote host)
#
# Run on your Mac. Installs MCP servers that Claude Code connects to over HTTP.
# Claude can read/write files and run commands on your Mac from any host.
#
# MCP servers (on Mac):
#   Port 8100 — Filesystem MCP  (read/write ~/projects)
#   Port 8101 — Shell MCP       (execute commands, read/write files)
#
# IMPORTANT NETWORK NOTES:
#   - supergateway's --baseUrl MUST be set to the host IP (not localhost),
#     because it returns the message POST URL to SSE clients in the
#     "endpoint" event. Without this, the client would POST to its own
#     localhost and fail silently.
#   - macOS firewall must allow incoming connections on 8100/8101.
#   - Node.js http.listen(port) defaults to 0.0.0.0 (all interfaces).
#
# Usage:
#   bash setup-mcp-host.sh                    # local Colima VM mode
#   bash setup-mcp-host.sh --remote user@host # remote host mode
#
# Prerequisites (local):  node 18+, colima VM 'claudia' running
# Prerequisites (remote): node 18+, SSH access to remote host
# Idempotent: safe to re-run
# =============================================================================

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="$HOME/projects"
COLIMA_PROFILE="claudia"
REMOTE_HOST=""   # set via --remote user@host
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
# Argument parsing
# =============================================================================

while [[ $# -gt 0 ]]; do
    case "$1" in
        --remote)
            [ -n "${2:-}" ] || err "--remote requires user@host argument"
            REMOTE_HOST="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: bash setup-mcp-host.sh [--remote user@host]"
            exit 0
            ;;
        *)
            err "Unknown argument: $1"
            ;;
    esac
done

# Helper: run a command on the Claude host (VM or remote)
claude_host_cmd() {
    if [ -n "$REMOTE_HOST" ]; then
        ssh "$REMOTE_HOST" -- "$@"
    else
        colima ssh -p "$COLIMA_PROFILE" -- "$@"
    fi
}

# =============================================================================
# Preflight
# =============================================================================

command -v node >/dev/null 2>&1 || err "node not found on PATH. Install node or ensure nvm is loaded."
command -v npm >/dev/null 2>&1  || err "npm not found on PATH."

if [ -z "$REMOTE_HOST" ]; then
    command -v colima >/dev/null 2>&1 || err "colima not found. Install: brew install colima"
fi

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

HOST_IP=""

if [ -n "$REMOTE_HOST" ]; then
    # --- Remote mode: ping-test Mac's IPs from the remote host ---
    step "Discovering Mac IP reachable from remote host $REMOTE_HOST..."

    for iface in en0 en1 en2 en3; do
        candidate=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
        if [ -n "$candidate" ]; then
            if ssh "$REMOTE_HOST" -- ping -c1 -W3 "$candidate" >/dev/null 2>&1; then
                HOST_IP="$candidate"
                info "Mac IP: $HOST_IP (reachable from remote via $iface)"
                break
            fi
        fi
    done

    if [ -z "$HOST_IP" ]; then
        warn "Could not auto-detect Mac IP reachable from $REMOTE_HOST."
        read -rp "  Enter Mac IP manually: " HOST_IP
        [ -n "$HOST_IP" ] || err "Mac IP is required."
    fi
else
    # --- Local mode: discover Mac IP via Colima VM's routing table ---
    step "Discovering host IP reachable from Colima VM..."

    if ! colima list 2>/dev/null | grep -E "^${COLIMA_PROFILE}\b" | grep -q Running; then
        err "Colima VM '$COLIMA_PROFILE' is not running. Run setup-claudia-vm.sh first, then: colima start -p $COLIMA_PROFILE"
    fi

    # Match VM's subnet to find the correct gateway (handles VPN/Docker routes)
    VM_IP=$(colima list 2>/dev/null | grep -E "^${COLIMA_PROFILE}\b" | awk '{print $NF}')
    VM_SUBNET=${VM_IP%.*}  # e.g. 192.168.64.3 → 192.168.64

    if [ -n "$VM_SUBNET" ] && [ "$VM_SUBNET" != "$VM_IP" ]; then
        ALL_GW=$(colima ssh -p "$COLIMA_PROFILE" -- ip route 2>/dev/null | awk '/default/{print $3}' || true)
        for gw in $ALL_GW; do
            if [ "${gw%.*}" = "$VM_SUBNET" ]; then
                HOST_IP="$gw"
                info "Host IP from VM gateway: $HOST_IP (matches VM subnet $VM_SUBNET.*)"
                break
            fi
        done
    fi

    # Fallbacks
    if [ -z "$HOST_IP" ]; then
        for iface in en0 en1; do
            candidate=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
            if [ -n "$candidate" ]; then
                HOST_IP="$candidate"
                info "Host IP from $iface: $HOST_IP"
                break
            fi
        done
    fi

    if [ -z "$HOST_IP" ]; then
        err "Could not discover host IP. Ensure Mac has a network connection and VM is running."
    fi
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
    warn "The client host needs to reach ports $FS_PORT and $SHELL_PORT on this Mac."
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

# --- Host → Mac TCP connectivity test ---
CLIENT_LABEL="VM"
[ -n "$REMOTE_HOST" ] && CLIENT_LABEL="remote host"
step "Testing TCP connectivity from $CLIENT_LABEL to Mac ($HOST_IP)..."

HOST_TCP_OK=true
for port in $FS_PORT $SHELL_PORT; do
    if claude_host_cmd -- bash -c "echo > /dev/tcp/$HOST_IP/$port" 2>/dev/null; then
        info "$CLIENT_LABEL → $HOST_IP:$port TCP OK"
    else
        warn "$CLIENT_LABEL → $HOST_IP:$port TCP FAILED"
        warn "macOS firewall may be blocking. Allow 'node' in System Settings > Network > Firewall."
        HOST_TCP_OK=false
    fi
done

# --- MCP SSE handshake test from host ---
if [ "$HOST_TCP_OK" = true ]; then
    step "Testing MCP SSE handshake from $CLIENT_LABEL..."
    for port_name in "$FS_PORT:filesystem" "$SHELL_PORT:shell"; do
        port=${port_name%%:*}
        name=${port_name##*:}
        SSE_RESPONSE=$(claude_host_cmd -- \
            curl -s --max-time 5 -H "Accept: text/event-stream" "http://$HOST_IP:$port/sse" 2>/dev/null | head -5 || true)
        if echo "$SSE_RESPONSE" | grep -q "event:"; then
            info "$name MCP SSE handshake OK from $CLIENT_LABEL"
        else
            warn "$name MCP SSE handshake failed from $CLIENT_LABEL"
            warn "Response: ${SSE_RESPONSE:-<empty>}"
        fi
    done
fi

# =============================================================================
# Phase 8: Configure Claude Code in VM
# =============================================================================

if [ -n "$REMOTE_HOST" ]; then
    step "Configuring Claude Code on remote host $REMOTE_HOST to use Mac MCP servers..."
else
    step "Configuring Claude Code in VM to use Mac MCP servers..."
fi

# Remove existing configs (idempotent)
claude_host_cmd -- bash -lc "claude mcp remove mac-filesystem 2>/dev/null || true"
claude_host_cmd -- bash -lc "claude mcp remove mac-shell 2>/dev/null || true"

# Add MCP servers using SSE transport with the Mac's IP
claude_host_cmd -- bash -lc \
    "claude mcp add --transport sse mac-filesystem http://$HOST_IP:$FS_PORT/sse --scope user"
claude_host_cmd -- bash -lc \
    "claude mcp add --transport sse mac-shell http://$HOST_IP:$SHELL_PORT/sse --scope user"

info "Claude Code configured with Mac MCP servers"

# Verify registration
if claude_host_cmd -- bash -lc "claude mcp list 2>/dev/null" | grep -q "mac-filesystem"; then
    info "mac-filesystem registered in Claude Code"
else
    warn "mac-filesystem not visible in 'claude mcp list'"
fi
if claude_host_cmd -- bash -lc "claude mcp list 2>/dev/null" | grep -q "mac-shell"; then
    info "mac-shell registered in Claude Code"
else
    warn "mac-shell not visible in 'claude mcp list'"
fi

# =============================================================================
# Phase 9: Install helpers from bin/
#
# bin/claudia and bin/mcp are the canonical helper scripts, kept under version
# control in the project. Install them here so both local-VM and remote users
# get the same commands from the same source — no generated-script divergence.
# =============================================================================

step "Installing claudia and mcp helpers..."

for helper in claudia mcp; do
    src="$SCRIPT_DIR/bin/$helper"
    dst="$BINDIR/$helper"
    if [ -f "$src" ]; then
        cp "$src" "$dst"
        chmod +x "$dst"
        info "Installed: $helper"
    else
        warn "bin/$helper not found in $SCRIPT_DIR/bin — skipping"
    fi
done

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
    warn "~/.local/bin is not in your PATH."
    warn "Add to your shell rc: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

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
echo "    Host IP:  $HOST_IP"
echo ""
echo "  Commands:"
echo "    mcp status       # health check"
echo "    mcp restart      # restart services"
echo "    mcp logs fs      # tail filesystem log"
echo "    mcp logs shell   # tail shell log"
echo "    mcp stop         # stop services"
echo ""
echo "  If Mac IP changes (WiFi switch, DHCP renewal):"
echo "    Re-run this script"
echo ""
