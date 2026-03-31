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
./start.sh  # kills stale processes, then starts the backend (port 4001) and frontend dev server (port 5173)
```

## Step 4: Connect from a browser

Open **http://your-server-ip:5173** in a browser on any machine that can reach the server.

If you're connecting over the internet, put the server behind a reverse proxy (Caddy, nginx) with HTTPS. The included `setup-claudia-remote.sh` script automates this for a fresh Ubuntu host.

## Step 5: Add a workspace

Click **+** in the sidebar and enter the absolute path to a project directory on the server (for example `/home/you/myproject`). Then type a prompt to create your first task.

## Editing files

Claudia manages Claude Code sessions on the server. To edit files yourself alongside Claude, use **VS Code Remote SSH** or **JetBrains Gateway** to connect directly to the server — no extra setup needed.
