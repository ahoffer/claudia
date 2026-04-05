# Installing Claudia

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Node.js 18+
- Claude Code CLI

## Step 1: Install Claude Code CLI

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude login
```

## Step 2: Install Claudia

```bash
git clone https://github.com/ahoffer/claudia.git
cd claudia
npm install && npm run build -w shared  # install deps and compile shared types (required before first run)
```

## Step 3: Start the server

```bash
./start.sh  # generates TLS cert on first run, then starts backend (:4001) and frontend (:5173) over HTTPS
```

## Step 4: Connect from a browser

Open **https://your-server-ip:4001** (or **https://your-server-ip:5173** in dev mode) in a browser on any machine that can reach the server. Accept the self-signed certificate warning on first visit.

HTTPS is built in — no reverse proxy is needed for basic setups. To use a real certificate, replace the files in `~/.claudia/certs/`. For internet-facing deployments, you can still put the server behind a reverse proxy (Caddy, nginx) if preferred.

## Step 5: Add a workspace

Click **+** in the sidebar and choose **Add Remote Workspace** to browse the server's filesystem, or **Add Local Workspace** to mount a folder from your client machine via SSHFS. Then type a prompt to create your first task.

## Editing files

Claudia manages Claude Code sessions on the server. To edit files yourself alongside Claude, use **VS Code Remote SSH** or **JetBrains Gateway** to connect directly to the server — no extra setup needed.
