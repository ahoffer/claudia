# Claudia - Project Architecture Documentation

**Claudia** is a headless server application that serves a web UI for managing multiple Claude Code CLI instances simultaneously. The backend runs as a standalone Node.js process and serves the frontend as a static web app — there is no Electron dependency for normal operation. It provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces. An optional Electron wrapper is available for a desktop app experience, but the primary deployment model is a server you access via browser, including from remote or mobile devices.

## Project Structure

```
claudia/
├── backend/              # Node.js backend server
│   ├── src/
│   │   ├── backends/             # Pluggable backend implementations
│   │   ├── plugin-system/        # Plugin manager and registry
│   │   ├── commands/             # Auto-installed Claude Code commands
│   │   └── __tests__/            # Unit tests (Vitest)
│   └── hooks/                    # Claude Code lifecycle hooks
├── frontend/             # React frontend application
│   └── src/
│       ├── components/           # UI components
│       ├── config/               # API endpoint configuration
│       ├── constants/            # Shared constants
│       ├── hooks/                # Custom React hooks
│       ├── services/             # Browser service utilities
│       ├── stores/               # Zustand state management
│       ├── styles/               # CSS styles (dark theme)
│       ├── types/                # TypeScript ambient declarations
│       └── utils/                # Utility functions
├── shared/               # Shared TypeScript types
├── electron/             # Electron desktop wrapper
├── .claude/              # Claude Code project data
├── .github/workflows/    # CI/CD pipelines
├── start.sh              # Startup script (macOS/Linux)
├── start.ps1             # Startup script (Windows)
├── package.json          # Root monorepo config
├── CLAUDE.md             # Project instructions for Claude
└── ARCHITECTURE.md       # This file
```

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Backend Runtime | Node.js + TypeScript |
| Backend Framework | Express.js + WebSocket (ws) |
| Process Management | @homebridge/node-pty-prebuilt-multiarch (cross-platform PTY) |
| Frontend Framework | React 18 + TypeScript |
| Frontend Build | Vite (HMR) |
| State Management | Zustand |
| Terminal Emulator | xterm.js with addons |
| Voice Recognition | Deepgram API / Whisper (local) |
| Voice Synthesis | ElevenLabs TTS |
| Desktop App | Electron |

---

## Backend Files (`backend/src/`)

### Core Server

| File | Purpose |
|------|---------|
| `index.ts` | Entry point - creates server, handles graceful shutdown, auto-installs /learn command |
| `server.ts` | Main application factory - Express routes, WebSocket server, service wiring, 40+ WebSocket message types |

### Services

| File | Purpose |
|------|---------|
| `task-spawner.ts` | Spawns and manages CLI processes. Tracks task state lifecycle, handles hooks, manages output buffering, coordinates with backends |
| `supervisor-chat.ts` | Conversational AI interface with tool-calling (create_task, delete_task, send_task_input, list_tasks, etc.) and context awareness from running tasks |
| `voice-supervisor.ts` | Voice-optimized AI supervisor for mobile hands-free control. Ultra-short streaming responses, delegates tool calls to SupervisorChat |
| `cron-scheduler.ts` | Manages scheduled/recurring prompts for tasks using standard 5-field cron expressions. Supports one-shot and recurring schedules, 3-day expiry, max 50 per task, persisted to disk |
| `workspace-store.ts` | Manages workspace directories (project folders). Persists to `workspace-config.json` |
| `config-store.ts` | Manages application configuration (API mode, MCP servers, permissions, rules). Supports direct API mode. Persists to `config.json` |
| `learnings-store.ts` | Vector-based learning storage with semantic search (cosine similarity). Implements MemRL (Memory Reinforcement Learning) for utility scoring |
| `llm-service.ts` | Dynamic LLM response generation via local `/v1/messages` endpoint |
| `task-persistence.ts` | Handles task metadata and output history persistence. Supports archived tasks with lazy-loaded history, debounced saves for performance |
| `task-state-detection.ts` | Analyzes terminal output to detect waiting states (question, permission, confirmation, text_input), processing indicators, and session IDs |
| `conversation-parser.ts` | Parses Claude Code conversation history from JSONL files in `~/.claude/projects/` and OpenCode message files |
| `git-utils.ts` | Git utilities for capturing state (commit hashes, diffs), tracking modified files, and enabling task revert functionality |
| `tunnel-manager.ts` | Creates public HTTPS URLs via ngrok for mobile device access. Supports QR code generation and token-based authentication |
| `claudia-mcp-server.ts` | MCP server injected into each task - exposes `claudia_*` tools so Claude Code agents can spawn and coordinate sibling tasks |
| `mobile-page.ts` | Self-contained HTML page for mobile task monitoring. Accordion task view with xterm.js terminals, voice input via Deepgram, voice summaries via ElevenLabs. No React/build dependencies |
| `voice-agent-page.ts` | Self-contained HTML page for voice-based task interaction. Deepgram Nova-3 input + ElevenLabs TTS output, voice selection UI. No React/build dependencies |
| `validation.ts` | Input validation utilities for REST API endpoints. Includes path traversal checks and a blocklist of env vars that must not be overridden via MCP config |
| `ring-buffer.ts` | O(1) ring buffer for terminal output history. Stores Buffer chunks up to a maximum total byte size, dropping oldest entries when full |
| `logger.ts` | Structured logging utility. `createLogger(prefix)` returns a scoped logger with debug/info/warn/error levels |
| `usage-reporter.ts` | Fire-and-forget token usage analytics reporting |

### Backends (`backend/src/backends/`)

Claudia supports pluggable backend implementations through the `CodeBackend` interface:

| File | Purpose |
|------|---------|
| `types.ts` | Backend abstraction types - `CodeBackend` interface, `TaskConfig`, `BackendTask`, `BACKEND_INFO` registry |
| `claude-code-backend.ts` | Claude Code CLI backend - spawns `claude` processes via PTY, full terminal lifecycle management |
| `opencode-backend.ts` | OpenCode backend - communicates via HTTP API with `opencode serve`, alternative to Claude Code |
| `index.ts` | Re-exports backend types and implementations |

### Plugin System (`backend/src/plugin-system/`)

Extensibility layer for adding AI providers, proxies, and integrations without modifying core code:

| File | Purpose |
|------|---------|
| `plugin-types.ts` | Type definitions - `PluginManifest`, `BackendPlugin`, `PluginContext`, `PluginMetadata`. Plugins declare type (`ai-provider`, `utility`, `integration`), routes, config schema, and models |
| `plugin-manager.ts` | Discovers, loads, and manages plugins. Handles lifecycle, route registration on Express, and configuration |
| `plugin-registry.ts` | Registry of loaded plugins, lookup by name/type |
| `index.ts` | Re-exports plugin system public API |

### Hooks (`backend/hooks/`)

Shell scripts that integrate with Claude Code CLI lifecycle events:

| File | Purpose |
|------|---------|
| `stop-notify.sh` | Called when Claude stops/finishes → sets task to `idle` |

### Commands (`backend/src/commands/`)

| File | Purpose |
|------|---------|
| `learn.md` | Auto-installed `/learn` slash command for all Claude Code sessions. Provides self-evaluation, mistake identification, skill file management, and structured learning extraction |

### Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts (`dev` runs tsx watch) |
| `tasks.json` | Persisted task data (auto-generated) |
| `config.json` | Application configuration (auto-generated) |
| `workspace-config.json` | Workspace list (auto-generated) |

### Tests (`backend/__tests__/`)

Unit tests using Vitest:

| Test File | Coverage |
|-----------|----------|
| `config-store.test.ts` | Configuration persistence and API mode management |
| `conversation-parser.test.ts` | JSONL conversation parsing |
| `git-utils.test.ts` | Git state capture and revert |
| `ring-buffer.test.ts` | Output ring buffer |
| `task-state-detection.test.ts` | Terminal output state analysis |
| `validation.test.ts` | Input validation |
| `workspace-store.test.ts` | Workspace CRUD operations |

---

## Frontend Files (`frontend/src/`)

### Core

| File | Purpose |
|------|---------|
| `main.tsx` | React application entry point |
| `App.tsx` | Main application layout - resizable sidebar, view toggle (Terminal/Chat/Settings), panel management |

### Components (`frontend/src/components/`)

| File | Purpose |
|------|---------|
| `WorkspacePanel.tsx` | Left sidebar showing workspaces, tasks, task ordering, and voice input support |
| `TerminalView.tsx` | xterm.js terminal emulator for task output and input |
| `ShellTerminalView.tsx` | Terminal view variant for shell/command sessions |
| `SupervisorChat.tsx` | Chat interface for conversing with the AI supervisor (tool-calling enabled) |
| `TaskSummaryPanel.tsx` | Displays task summaries, status, and suggested actions |
| `TaskInputBar.tsx` | Input bar for sending messages to tasks |
| `TaskCreateModal.tsx` | Modal for creating new tasks with prompt and options |
| `ConversationHistory.tsx` | Shows parsed conversation history for a task with session selector |
| `SettingsMenu.tsx` | Full settings panel - API provider, MCP servers, voice, permissions, rules |
| `ScheduledTasksModal.tsx` | UI for viewing and managing cron-scheduled tasks |
| `LearnFromConversationModal.tsx` | Analyzes completed tasks and suggests learnings to save |
| `MobileAccessModal.tsx` | Displays QR code and tunnel URL for mobile remote access |
| `FileExplorer.tsx` | File browser for workspace directories |
| `FileContentModal.tsx` | Modal for viewing file contents |
| `ProjectPicker.tsx` | Modal for adding new workspace directories |
| `PathInputModal.tsx` | Generic modal for entering filesystem paths |
| `SystemPromptModal.tsx` | Modal for editing workspace system prompts |
| `ConfirmModal.tsx` | Generic confirmation dialog |
| `ErrorBoundary.tsx` | React error boundary for graceful error display |
| `GlobalVoiceManager.tsx` | Logic-only component for managing voice recognition app-wide |
| `GlobalVoiceToggle.tsx` | UI toggle for global voice recognition on/off with visual indicator |
| `VoiceInput.tsx` | Voice input widget with speech-to-text and interim results |
| `VoiceSettings.tsx` | Voice settings panel (provider, API key, auto-send, delay) |
| `VoiceSettingsContent.tsx` | Inner content for the voice configuration panel |
| `DeepgramApiKeyModal.tsx` | Modal for entering Deepgram API key |
| `WhisperSetupModal.tsx` | Modal for configuring local Whisper speech recognition |
| `SystemStats.tsx` | Real-time CPU and memory usage display with color-coded status |
| `NotificationContainer.tsx` | Centralized toast notification display with auto-dismiss |
| `Notification.tsx` | Individual toast notification component |

### Hooks (`frontend/src/hooks/`)

| File | Purpose |
|------|---------|
| `useWebSocket.ts` | Manages WebSocket connection, message routing, auto-reconnect, status polling |
| `useVoiceRecognition.ts` | Unified voice recognition hook - delegates to Deepgram or Whisper based on config |
| `useDeepgramRecognition.ts` | Deepgram API integration for cloud speech-to-text |
| `useWhisperRecognition.ts` | Local Whisper integration for offline speech-to-text |
| `useSttRecognition.ts` | Browser-native Web Speech API fallback |
| `useSpeechSynthesis.ts` | Browser speech synthesis for TTS output |

### State (`frontend/src/stores/`)

| File | Purpose |
|------|---------|
| `taskStore.ts` | Zustand store for global state (tasks, workspaces, chat history, voice settings, notifications). Persists to localStorage |

### Services (`frontend/src/services/`)

| File | Purpose |
|------|---------|
| `filePickerService.ts` | Abstraction for filesystem path picking, with Electron native dialog support and web fallback |

### Configuration

| File | Purpose |
|------|---------|
| `config/api-config.ts` | API endpoint configuration. Detects Electron, dev, and reverse-proxy environments to build correct backend URLs |

### Types (`frontend/src/types/`)

| File | Purpose |
|------|---------|
| `electron.d.ts` | Ambient declarations for `window.electronAPI` (IPC bridge) |
| `globals.d.ts` | Other ambient global declarations |

### Utils (`frontend/src/utils/`)

| File | Purpose |
|------|---------|
| `browserCapabilities.ts` | Detects browser capabilities (speech recognition support, etc.) |
| `events.ts` | Event utility helpers |

### Styles (`frontend/src/styles/`)

| File | Purpose |
|------|---------|
| `index.css` | Global styles with CSS custom properties for dark theme |
| `*.css` | Component-specific styles co-located with components |

---

## Shared Types (`shared/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | TypeScript interfaces shared between backend/frontend |

### Key Types

```typescript
TaskState: 'idle' | 'busy' | 'starting' | 'waiting_input' | 'exited'
         | 'disconnected' | 'interrupted' | 'archived'

WaitingInputType: 'question' | 'permission' | 'text_input' | 'confirmation'

BackendType: 'claude-code' | 'opencode'

Task: {
  id, prompt, state, workspaceId, createdAt, lastActivity,
  gitState?, waitingInputType?, systemPrompt?, order?,
  sessionId?, backendType?
}

ScheduledTask: { id, taskId, cronExpression, prompt, nextRun, lastRun?, recurring }

Workspace: { id (full path), name (folder name), createdAt, systemPrompt? }

TaskGitState: { commitBefore, commitAfter?, filesModified[], canRevert, revertedAt? }

FileDiff: { path, type, additions, deletions, hunks }

TaskSummary: { taskId, status, summary, lastAction, suggestedActions }

ChatMessage: { id, role, content, timestamp, taskId?, workspaceId? }

WSMessageType: 40+ types for task lifecycle, workspaces, chat, supervisor,
               archived tasks, learnings, tunnel, system stats, cron, etc.
```

---

## Electron Desktop App (`electron/`)

| File | Purpose |
|------|---------|
| `main.ts` | Main process - window creation, lifecycle management, dev tools support |
| `server-manager.ts` | Starts/stops Express backend server, returns `ServerInfo` |
| `preload.ts` | IPC bridge - exposes `window.electronAPI` with `getBackendUrl()` |

---

## Root Files

| File | Purpose |
|------|---------|
| `start.sh` | Startup script (macOS/Linux) - checks ports, sets CORS_ORIGINS for proxy setups, runs `npm run dev` |
| `start.ps1` | Startup script (Windows/PowerShell) - port cleanup, environment setup, process management |
| `package.json` | Monorepo root config with workspaces: backend, frontend, shared, electron |
| `CLAUDE.md` | Project instructions for Claude Code instances |
| `ARCHITECTURE.md` | This architecture documentation |

---

## Architecture Diagram

The server and client are **separate machines**. The server always runs on AMD64 Ubuntu (bare metal or VM). The client is any machine running a web browser — the browser is purely UI and hosts no server-side logic.

MCP tool calls travel through a **client daemon** (`claudia-client`) that runs on the client machine. The daemon opens a persistent outbound WSS tunnel to the server and forwards MCP requests to local MCP servers. This means there is no direct inbound connection from server to client and no dependency on the client's IP address.

```
CLIENT MACHINE  (Mac, Linux, Windows)
  ┌──────────────────────────────────────────────────────────────────┐
  │  Web Browser (React SPA — UI only)                                │
  │  WorkspacePanel  TerminalView  SupervisorChat  Settings           │
  │                       │ useWebSocket (UI events)                  │
  └───────────────────────┼──────────────────────────────────────────┘
                          │ outbound WSS :4443
  ┌───────────────────────┼──────────────────────────────────────────┐
  │  claudia-client daemon (outbound WSS :4443 — MCP tunnel)          │
  │    forwards MCP calls to:                                         │
  │      localhost:8100  (filesystem-mcp)                             │
  │      localhost:8101  (shell-mcp)                                  │
  │    returns results back through the tunnel                        │
  │    managed by launchd (Mac) or systemd (Linux)                    │
  └───────────────────────┬──────────────────────────────────────────┘
                          │ outbound WSS :4443
                          ▼
SERVER  —  AMD64 Ubuntu (VM or bare metal)
  ┌───────────────────────────────────────────────────────────────────┐
  │  nginx :4443  (TLS termination)                                    │
  │      ↓ proxy_pass                                                  │
  │  Express :4001                                                     │
  │  ┌─────────────────────────────────────────────────────────────┐  │
  │  │  server.ts  (REST + WebSocket, 40+ types)                    │  │
  │  └──────────────┬──────────────────────────────────────────────┘  │
  │                 │                                                  │
  │  ┌──────────────┴──┐  ┌──────────────────────────────────────┐    │
  │  │ TaskSpawner     │  │ SupervisorChat / VoiceSupervisor      │    │
  │  │ (orchestrator)  │  └──────────────────────────────────────┘    │
  │  └──────┬──────────┘                                              │
  │         │                                                          │
  │  ┌──────┴──────────────────────────────────────────────────────┐  │
  │  │  Claude Code / OpenCode CLI instances (PTY)                  │  │
  │  │  MCP calls → local proxy endpoint → tunnel → claudia-client  │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────────────────┘
```

### Client–Server Notes

- The browser is UI-only. It does not relay MCP calls.
- `claudia-client` opens an outbound WSS connection (port 443/4443) to the server — no inbound ports required on the client. Works through any NAT or firewall.
- The server receives MCP tool call requests from Claude Code via a local proxy endpoint and pushes them through the persistent tunnel to the waiting `claudia-client` daemon.
- `claudia-client` forwards each request to the appropriate local MCP server (`localhost:8100` or `localhost:8101`) and returns the result through the tunnel.
- There is no `CLIENT_IP` or `MAC_IP` configuration. Direct IP connections from server to client are gone.
- `claudia-client` reconnects automatically on disconnect.
- The `bin/mcp` helper manages the `claudia-client` daemon and local MCP services on the client.
- The `bin/claudia` helper manages the Claudia server process on the server.

---

## Data Flow

### 1. Task Creation
```
User → WorkspacePanel → WebSocket (task:create) → server.ts → TaskSpawner
    → selects backend (ClaudeCode or OpenCode) → spawns CLI process
    → WebSocket (task:created) → taskStore → UI updates
```

### 2. Task State Changes
```
Claude CLI → stop-notify.sh hook → POST /api/claude-stop → server.ts
    → TaskSpawner updates state → WebSocket (task:stateChanged) → UI updates

Terminal output → TaskStateDetection → detects waiting_input type
    → WebSocket (task:stateChanged) → UI shows appropriate input prompt
```

### 3. Terminal I/O
```
Claude CLI output → node-pty → TaskSpawner → WebSocket (task:output) → TerminalView
User input → TerminalView → WebSocket (task:input) → TaskSpawner → node-pty → CLI
```

### 4. Supervisor Chat
```
User message → SupervisorChat → WebSocket (supervisor:message) → server.ts
    → SupervisorChat (AI with tools) → may call create_task, send_task_input, etc.
    → WebSocket (supervisor:response) → Chat UI updates
```

### 5. Learning Extraction
```
Task completes → User clicks "Learn" → POST /api/tasks/:id/learn
    → LLM analyzes conversation → suggests learnings
    → User selects learnings → POST /api/tasks/:id/learn/save
    → LearningsStore generates embeddings → persists with MemRL scoring
```

### 6. Mobile Access
```
User enables tunnel → POST /api/tunnel/start → TunnelManager → ngrok
    → Public HTTPS URL generated → QR code displayed
    → Mobile device scans QR → connects via tunnel → mobile-page.ts HTML served
    → Voice input (Deepgram) + voice output (ElevenLabs) available
```

### 7. Scheduled Tasks
```
User creates schedule → POST /api/cron → CronScheduler persists to disk
    → CronScheduler ticks every minute → fires prompt to task PTY when idle
    → Task processes prompt → output streams back as normal
```

---

## REST API Endpoints

### Task Management
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks` | List all active tasks |
| GET | `/api/tasks/:taskId/status` | Get task status |
| GET | `/api/tasks/:taskId/debug` | Debug information |

### WebSocket Events (Task)
| Event | Direction | Purpose |
|-------|-----------|---------|
| `task:create` | Client → Server | Create a new task |
| `task:input` | Client → Server | Send input to task |
| `task:output` | Server → Client | Terminal output stream |
| `task:stateChanged` | Server → Client | Task state update |
| `task:resize` | Client → Server | Resize terminal |
| `task:interrupt` | Client → Server | Interrupt task (ESC) |
| `task:stop` | Client → Server | Stop task |
| `task:destroy` | Client → Server | Destroy task |
| `task:summary` | Server → Client | AI-generated task summary |

### Learnings
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/learnings` | List all learnings |
| GET | `/api/learnings/:id` | Get learning by ID |
| POST | `/api/learnings` | Create learning |
| PUT | `/api/learnings/:id` | Update learning |
| DELETE | `/api/learnings/:id` | Delete learning |
| POST | `/api/learnings/search` | Semantic search learnings |
| POST | `/api/tasks/:taskId/learn` | Analyze task for learnings |
| POST | `/api/tasks/:taskId/learn/save` | Save learnings from analysis |

### Conversation History
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks/:taskId/conversation` | Get task conversation |
| GET | `/api/workspaces/:workspaceId/sessions` | List workspace sessions |
| GET | `/api/sessions/:sessionId/conversation` | Get session conversation |

### Configuration
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/config` | Get current configuration |
| PUT | `/api/config` | Update configuration |
| GET | `/api/claude-mcp-servers` | List Claude MCP servers |
| GET | `/api/claude-config/mcp-servers` | Get MCP configuration |
| PUT | `/api/claude-config/mcp-servers` | Update MCP servers |

### Remote Access
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tunnel/start` | Start ngrok tunnel |
| POST | `/api/tunnel/stop` | Stop ngrok tunnel |
| GET | `/api/tunnel/status` | Get tunnel status |
| GET | `/mobile` | Mobile web interface (mobile-page.ts) |
| GET | `/voice-agent` | Voice agent interface (voice-agent-page.ts) |

### System
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/backend/status` | Backend status and info |
| GET | `/api/system/stats` | CPU/memory stats |
| POST | `/api/upload/image` | Upload image file |
| DELETE | `/api/upload/image/:filename` | Delete uploaded image |
| POST | `/api/tts` | Text-to-speech synthesis (ElevenLabs) |

### Proxy Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v1/models` | List available Claude models |
| POST | `/v1/messages` | Anthropic Messages API (proxied) |
| POST | `/v1/embeddings` | Generate embeddings |

---

## Key Features

| Feature | Implementation |
|---------|----------------|
| Multi-instance task management | TaskSpawner with pluggable backends (ClaudeCode PTY, OpenCode HTTP) |
| Real-time terminal emulation | xterm.js + WebSocket streaming |
| AI supervisor chat | SupervisorChat with tool-calling (create/delete/input tasks) |
| Voice supervisor | VoiceSupervisor — streaming, ultra-short responses for hands-free mobile use |
| Scheduled tasks | CronScheduler — 5-field cron expressions, persisted, fires into task PTY |
| Learning system | LearningsStore with embeddings, semantic search, MemRL utility scoring |
| Git integration | git-utils.ts (state capture, diff tracking, revert) |
| Voice input | Deepgram cloud, local Whisper, or browser Web Speech API |
| Voice output | ElevenLabs TTS (mobile page + voice agent page) |
| Task persistence | JSON files with debounced saves, archived task lazy-loading |
| Task state detection | Terminal output analysis for waiting_input types |
| Mobile access | ngrok tunnel + self-contained mobile HTML page with xterm.js + voice |
| Voice agent page | Standalone voice UI (Deepgram in + ElevenLabs out) for fully hands-free use |
| System monitoring | Real-time CPU/memory stats polling |
| Conversation history | Claude Code JSONL + OpenCode message parsing |
| Hook system | stop-notify.sh → HTTP callback for task lifecycle events |
| Plugin system | PluginManager loads external ai-provider/utility/integration plugins |
| Claudia MCP | Claude Code agents can spawn and coordinate sibling tasks via MCP tools |
| Usage analytics | Token tracking via fire-and-forget reporter |
| Cross-platform | Windows (PowerShell), macOS, Linux support |
| Desktop app | Electron wrapper with embedded backend |

---

## Deployment Architecture

Claudia is designed to run as a server process — either on a local VM for testing or on a remote host for production. The backend must always co-locate with the Claude Code CLI because it spawns PTY processes directly; the frontend is served as static files from the same Express process.

### Target Environments

| Environment | Purpose | Access |
|-------------|---------|--------|
| Local VM | Development and testing | Direct HTTP to `:4001` or HTTPS via nginx on `:443` |
| Remote host | Production | HTTPS via nginx on `:443`, bearer token auth |

### Production Topology

```
Browser (any device)
        │ HTTPS :443
        ▼
┌─────────────────────────────────────┐
│  Remote host / Local VM             │
│                                     │
│  nginx :443                         │
│    TLS: self-signed cert (for now)  │
│    Auth: bearer token               │
│      ↓ proxy_pass                   │
│  Express :4001                      │
│    serves /dist  (React frontend)   │
│    /api/*        REST endpoints     │
│    ws://         WebSocket          │
│    spawns claude PTY processes      │
└─────────────────────────────────────┘
```

### Key Principles

- **Single port, single process** — Express serves the built frontend statically from `/dist`. Clients connect to one origin; no CORS complexity.
- **nginx handles TLS** — self-signed certs for now (swap in a CA-signed cert later without touching the app). nginx also terminates auth before traffic reaches Express.
- **Bearer token auth** — a shared secret in `config.json`, checked by Express middleware. Simple and sufficient for single-user/team deployments.
- **Environment parity** — VM and remote host run identically. The only difference is the nginx cert and the DNS/IP used to reach it.
- **Co-location requirement** — the Claude Code CLI (`claude`) must be installed on the same machine as the backend. Remote deployments are "bring your own host with claude installed."
- **Client daemon required for MCP** — when the server is remote, the `claudia-client` daemon must be installed and running on the client machine. It establishes the outbound WSS tunnel through which all MCP tool calls travel. Install it via the `bin/mcp` helper on the client.

### TLS (Self-Signed Certs)

Generate a cert for the host:

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=<hostname-or-ip>"
```

nginx config snippet:

```nginx
server {
    listen 443 ssl;
    ssl_certificate     /etc/claudia/cert.pem;
    ssl_certificate_key /etc/claudia/key.pem;

    location / {
        proxy_pass         http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
    }
}
```

Browsers will warn on self-signed certs; accept the exception once per device. Replace with a CA-signed cert (e.g. Let's Encrypt) when ready.

---

## Development

### Auto-Reload
- **Backend:** `tsx watch` monitors `src/`, reloads in 1-2 seconds
- **Frontend:** Vite HMR provides instant updates

### Ports
- Backend: `http://localhost:4001`
- Frontend: `http://localhost:5173`

### Starting the Project

**macOS / Linux:**
```bash
./start.sh
```

**Windows (PowerShell):**
```powershell
.\start.ps1
```

**Or use npm directly:**
```bash
npm run dev
```

### Testing
```bash
# Unit tests
npm run test

# Test CLI
cd backend
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts -m "your prompt" -w /path/to/workspace
```

### Multi-Instance
Multiple Claude Code instances can work on this project simultaneously without conflicts. The backend auto-reloads on changes.

---
