# Claudia - Project Architecture Documentation

**Claudia** is a headless server application that serves a web UI for managing multiple Claude Code CLI instances simultaneously. The backend runs as a standalone Node.js process and serves the frontend as a static web app. It provides a visual interface for spawning, monitoring, and interacting with Claude Code tasks across different workspaces. The primary deployment model is a Linux server you access via browser, including from remote or mobile devices.

## Project Structure

```
claudia/
├── backend/              # Node.js backend server
│   ├── src/
│   │   ├── backends/             # Pluggable backend implementations
│   │   ├── plugin-system/        # Plugin manager and registry
│   │   ├── commands/             # Auto-installed Claude Code commands
│   │   └── __tests__/            # Unit tests (Vitest)
│   ├── hooks/                    # Claude Code lifecycle hooks
│   └── plugins/                  # Loadable plugins (AI providers, integrations)
├── frontend/             # React frontend application
│   └── src/
│       ├── __tests__/            # Unit tests (Vitest)
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
│   └── src/
│       ├── index.ts              # Shared interfaces and types
│       └── config.ts             # Shared configuration constants
├── .claude/              # Claude Code project data
├── .github/workflows/    # CI/CD pipeline (Ubuntu only)
├── start.sh              # Production startup script
├── start-dev.sh          # Development startup script (tsx watch + Vite HMR)
├── package.json          # Root monorepo config (workspaces: backend, frontend, shared)
├── CLAUDE.md             # Project instructions for Claude
└── ARCHITECTURE.md       # This file
```

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Backend Runtime | Node.js + TypeScript |
| Backend Framework | Express.js + WebSocket (ws) |
| Process Management | node-pty (PTY spawn) |
| Frontend Framework | React 18 + TypeScript |
| Frontend Build | Vite (HMR) |
| State Management | Zustand |
| Terminal Emulator | xterm.js with addons |
| Voice Recognition | Deepgram API / Whisper (local) |
| Voice Synthesis | ElevenLabs TTS |

---

## Backend Files (`backend/src/`)

### Core Server

| File | Purpose |
|------|---------|
| `index.ts` | Entry point - creates server, handles graceful shutdown, auto-installs /learn command |
| `server.ts` | Main application factory - Express routes, WebSocket server, service wiring, ~50 WebSocket message types |

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

### Plugins (`backend/plugins/`)

Loadable plugins discovered by the plugin system at startup:

| Directory | Purpose |
|-----------|---------|
| `hai-proxy-plugin/` | Hyperspace AI proxy integration - provides `/v1/messages`, `/v1/models`, and `/v1/embeddings` routes when enabled |
| `sap-ai-core-plugin/` | SAP AI Core integration |
| `example-plugin/` | Reference implementation for plugin authors |

### Hooks (`backend/hooks/`)

Shell scripts that integrate with Claude Code CLI lifecycle events:

| File | Purpose |
|------|---------|
| `stop-notify.sh` | Called when Claude stops/finishes - sets task to `idle` |

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

### Tests (`backend/src/__tests__/`)

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
| `ActivityPanel.tsx` | Activity feed panel showing recent task events and state changes |
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
| `useTheme.ts` | Theme management hook (light/dark mode) |

### State (`frontend/src/stores/`)

| File | Purpose |
|------|---------|
| `taskStore.ts` | Zustand store for global state (tasks, workspaces, chat history, voice settings, notifications). Persists to localStorage |

### Services (`frontend/src/services/`)

| File | Purpose |
|------|---------|
| `filePickerService.ts` | Abstraction for filesystem path picking with web fallback |

### Configuration

| File | Purpose |
|------|---------|
| `config/api-config.ts` | API endpoint configuration. Detects dev and reverse-proxy environments to build correct backend URLs |

### Types (`frontend/src/types/`)

| File | Purpose |
|------|---------|
| `globals.d.ts` | Ambient global declarations |
| `theme.ts` | Theme type definitions |

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

### Tests (`frontend/src/__tests__/`)

| Test File | Coverage |
|-----------|----------|
| `ErrorBoundary.test.tsx` | Error boundary rendering |
| `events.test.ts` | Event utilities |
| `taskStore.test.ts` | Zustand store state management |

---

## Shared Types (`shared/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | TypeScript interfaces shared between backend/frontend |
| `config.ts` | Shared configuration constants |

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

WSMessageType: ~50 types for task lifecycle, workspaces, chat, supervisor,
               archived tasks, learnings, tunnel, system stats, cron, etc.
```

---

## Root Files

| File | Purpose |
|------|---------|
| `start.sh` | Production startup - generates TLS cert on first run, runs compiled backend (`node backend/dist/index.js`) |
| `start-dev.sh` | Development startup - same setup, but runs tsx watch + Vite HMR for auto-reload |
| `package.json` | Monorepo root config with workspaces: backend, frontend, shared |
| `CLAUDE.md` | Project instructions for Claude Code instances |
| `ARCHITECTURE.md` | This architecture documentation |

---

## Architecture Diagram

The server and client are **separate machines**. The server runs on Linux (AMD64). The client is any machine running a web browser.

```
CLIENT MACHINE  (any OS with a browser)
  ┌──────────────────────────────────────────────────────────────────┐
  │  Web Browser (React SPA — UI only)                                │
  │  WorkspacePanel  TerminalView  SupervisorChat  Settings           │
  │                       │ useWebSocket (UI events)                  │
  └───────────────────────┼──────────────────────────────────────────┘
                          │ outbound WSS :4443
                          ▼
SERVER  —  Linux (VM or bare metal)
  ┌───────────────────────────────────────────────────────────────────┐
  │  nginx :4443  (TLS termination)                                    │
  │      ↓ proxy_pass                                                  │
  │  Express :4001                                                     │
  │  ┌─────────────────────────────────────────────────────────────┐  │
  │  │  server.ts  (REST + WebSocket, ~50 message types)            │  │
  │  └──────────────┬──────────────────────────────────────────────┘  │
  │                 │                                                  │
  │  ┌──────────────┴──┐  ┌──────────────────────────────────────┐    │
  │  │ TaskSpawner     │  │ SupervisorChat / VoiceSupervisor      │    │
  │  │ (orchestrator)  │  └──────────────────────────────────────┘    │
  │  └──────┬──────────┘                                              │
  │         │                                                          │
  │  ┌──────┴──────────────────────────────────────────────────────┐  │
  │  │  Claude Code / OpenCode CLI instances (PTY)                  │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  │                                                                    │
  │  ┌──────────────────────────────────────────────────────────────┐ │
  │  │  Plugins (AI providers, proxies) — dynamically registered     │ │
  │  └──────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────┘
```

### Client-Server Notes

- The browser is UI-only.
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
| GET | `/api/tasks/:taskId/output` | Get task terminal output |
| GET | `/api/tasks/:taskId/debug` | Debug information |

### Workspaces
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/workspaces` | List all workspaces |
| GET | `/api/workspaces/files` | List files in a workspace |
| GET | `/api/workspaces/read-file` | Read a file from a workspace |
| POST | `/api/workspaces/save-file` | Save a file in a workspace |
| GET | `/api/workspaces/git-status` | Git status for a workspace |
| GET | `/api/workspaces/git-log` | Git log for a workspace |
| GET | `/api/workspaces/git-diff` | Git diff for a workspace |
| GET | `/api/workspaces/ci-status` | CI pipeline status |
| GET | `/api/workspaces/github-issues` | List GitHub issues |
| POST | `/api/workspaces/github-issues` | Create GitHub issue |
| PATCH | `/api/workspaces/github-issues/:issueNumber` | Update GitHub issue |
| PATCH | `/api/workspaces/pr-description` | Update PR description |
| POST | `/api/browse-folder` | Browse filesystem directories |

### Scheduled Tasks (Cron)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/cron` | List all cron schedules |
| GET | `/api/tasks/:taskId/cron` | List schedules for a task |
| POST | `/api/tasks/:taskId/cron` | Create schedule for a task |
| PUT | `/api/cron/:cronId` | Update a cron schedule |
| DELETE | `/api/cron/:cronId` | Delete a cron schedule |

### Learnings
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/learnings` | List all learnings |
| GET | `/api/learnings/:id` | Get learning by ID |
| POST | `/api/learnings` | Create learning |
| PUT | `/api/learnings/:id` | Update learning |
| DELETE | `/api/learnings/:id` | Delete learning |
| POST | `/api/learnings/search` | Semantic search learnings |
| GET | `/api/tasks/:taskId/learnings` | Get learnings for a task |
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
| POST | `/api/mcp/test` | Test MCP server connectivity |

### Plugins
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/plugins` | List loaded plugins |
| POST | `/api/plugins/:name/enable` | Enable a plugin |
| POST | `/api/plugins/:name/disable` | Disable a plugin |

### Remote Access
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tunnel/start` | Start ngrok tunnel |
| POST | `/api/tunnel/stop` | Stop ngrok tunnel |
| GET | `/api/tunnel/status` | Get tunnel status |
| GET | `/mobile` | Mobile web interface (mobile-page.ts) |
| GET | `/voice` | Voice agent interface (voice-agent-page.ts) |

### Voice and TTS
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tts` | Text-to-speech synthesis (ElevenLabs) |
| GET | `/api/elevenlabs/voices` | List available ElevenLabs voices |
| GET | `/api/elevenlabs/voices/:voiceId/preview` | Preview a voice |
| POST | `/api/voice/message` | Send voice message to supervisor |
| GET | `/api/voice/message/stream` | Stream voice message response |
| GET | `/api/voice-agent/system-prompt` | Get voice agent system prompt |
| GET | `/api/voice-agent/tools` | Get voice agent tool definitions |

### System
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/backend/status` | Backend status and info |
| GET | `/api/system/stats` | CPU/memory stats |
| POST | `/api/upload/image` | Upload image file |
| DELETE | `/api/upload/image/:filename` | Delete uploaded image |
| GET | `/api/cache/images/:filename` | Serve cached image |
| POST | `/api/user-id` | Get or create user ID |
| POST | `/api/server/restart` | Restart the backend server |

### Plugin-Provided Proxy Endpoints

These endpoints are dynamically registered by AI provider plugins (for example the HAI proxy plugin), not hardcoded in server.ts:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v1/models` | List available models |
| POST | `/v1/messages` | Anthropic Messages API (proxied) |
| POST | `/v1/embeddings` | Generate embeddings |
| POST | `/api/hyperspace-proxy/test` | Test Hyperspace proxy connection |
| POST | `/api/hyperspace-proxy/models` | List Hyperspace models |

### WebSocket Events (Task)
| Event | Direction | Purpose |
|-------|-----------|---------|
| `task:create` | Client -> Server | Create a new task |
| `task:input` | Client -> Server | Send input to task |
| `task:output` | Server -> Client | Terminal output stream |
| `task:stateChanged` | Server -> Client | Task state update |
| `task:resize` | Client -> Server | Resize terminal |
| `task:interrupt` | Client -> Server | Interrupt task (ESC) |
| `task:stop` | Client -> Server | Stop task |
| `task:destroy` | Client -> Server | Destroy task |
| `task:summary` | Server -> Client | AI-generated task summary |

---

## Key Features

| Feature | Implementation |
|---------|----------------|
| Multi-instance task management | TaskSpawner with pluggable backends (ClaudeCode PTY, OpenCode HTTP) |
| Real-time terminal emulation | xterm.js + WebSocket streaming |
| AI supervisor chat | SupervisorChat with tool-calling (create/delete/input tasks) |
| Voice supervisor | VoiceSupervisor - streaming, ultra-short responses for hands-free mobile use |
| Scheduled tasks | CronScheduler - 5-field cron expressions, persisted, fires into task PTY |
| Learning system | LearningsStore with embeddings, semantic search, MemRL utility scoring |
| Git integration | git-utils.ts (state capture, diff tracking, revert) |
| GitHub integration | CI status, issues, PR descriptions via REST API |
| Voice input | Deepgram cloud, local Whisper, or browser Web Speech API |
| Voice output | ElevenLabs TTS (mobile page + voice agent page) |
| Task persistence | JSON files with debounced saves, archived task lazy-loading |
| Task state detection | Terminal output analysis for waiting_input types |
| Mobile access | ngrok tunnel + self-contained mobile HTML page with xterm.js + voice |
| Voice agent page | Standalone voice UI (Deepgram in + ElevenLabs out) for fully hands-free use |
| System monitoring | Real-time CPU/memory stats polling |
| Conversation history | Claude Code JSONL + OpenCode message parsing |
| Hook system | stop-notify.sh - HTTP callback for task lifecycle events |
| Plugin system | PluginManager loads external ai-provider/utility/integration plugins |
| Claudia MCP | Claude Code agents can spawn and coordinate sibling tasks via MCP tools |
| Usage analytics | Token tracking via fire-and-forget reporter |

---

## Deployment Architecture

Claudia runs as a server process on Linux. The backend must co-locate with the Claude Code CLI because it spawns PTY processes directly; the frontend is served as static files from the same Express process.

### Target Environments

| Environment | Purpose | Access |
|-------------|---------|--------|
| Local VM | Development and testing | Direct HTTPS to `:4001` (built-in self-signed cert) |
| Remote host | Production | Direct HTTPS to `:4001`, or HTTPS via nginx on `:443` with bearer token auth |

### Production Topology

```
Browser (any device)
        │ HTTPS :4001
        ▼
┌─────────────────────────────────────┐
│  Remote host / Local VM             │
│                                     │
│  Express :4001  (built-in TLS)      │
│    TLS: self-signed cert            │
│    serves /dist  (React frontend)   │
│    /api/*        REST endpoints     │
│    wss://        WebSocket          │
│    spawns claude PTY processes      │
└─────────────────────────────────────┘
```

### Key Principles

- **Single port, single process** - Express serves the built frontend statically from `/dist`. Clients connect to one origin; no CORS complexity.
- **Built-in TLS** - `start.sh` auto-generates a self-signed cert at `~/.claudia/certs/` on first run with SANs for localhost and the LAN IP. No reverse proxy required. Swap in a CA-signed cert by replacing `server.key` and `server.crt`.
- **Bearer token auth** - a shared secret in `config.json`, checked by Express middleware. Simple and sufficient for single-user/team deployments.
- **Environment parity** - VM and remote host run identically. The only difference is the cert and the DNS/IP used to reach it.
- **Co-location requirement** - the Claude Code CLI (`claude`) must be installed on the same machine as the backend. Remote deployments are "bring your own host with claude installed."

### TLS Certificate

On first run, `start.sh` generates a self-signed certificate:

- **Location**: `~/.claudia/certs/server.key` and `server.crt`
- **Validity**: 365 days, RSA 2048-bit
- **SANs**: `localhost`, `127.0.0.1`, `::1`, and the machine's LAN IP
- **Env vars**: `CLAUDIA_TLS_CERT` and `CLAUDIA_TLS_KEY` point to the cert files

Browsers will warn on self-signed certs; accept the exception once per device. To use a real certificate (for example Let's Encrypt), replace the two files in `~/.claudia/certs/` and restart.

An nginx reverse proxy is optional but still supported for internet-facing deployments where you want nginx to handle TLS termination and auth.

---

## Networking and Remote Access

### Access Patterns

The frontend auto-detects its access method and routes API/WebSocket traffic accordingly (see `frontend/src/config/api-config.ts`):

| Mode | Detection | API URL | WebSocket |
|------|-----------|---------|-----------|
| Direct HTTPS | HTTPS + localhost or bare IP | `https://hostname:4001` | `wss://hostname:4001` |
| Direct HTTP (fallback) | HTTP, no TLS configured | `http://hostname:4001` | `ws://hostname:4001` |
| Reverse proxy | HTTPS + non-IP hostname, not tunnel | Same origin | `wss://host` |
| Tunnel (ngrok) | `*.ngrok-free.app` hostname | Same origin | `wss://host?token=<uuid>&mobile=1` |

### ngrok Tunnel (`backend/src/tunnel-manager.ts`)

Creates public HTTPS URLs for mobile device access:

- Spawns ngrok process targeting port 4001, polls local API at `127.0.0.1:4040` for the public URL
- Generates a random UUID token per session for authentication
- Orphan recovery: if the backend restarts (tsx watch reload), the tunnel manager adopts any existing ngrok process so mobile clients keep their URL
- Optional custom domain via config
- Exponential backoff reconnection (up to 3 retries)

### CORS (`backend/src/server.ts`)

- Default allowed origins: `localhost:4001`, `localhost:5173`, `127.0.0.1:4001`, `127.0.0.1:5173` (both HTTP and HTTPS)
- Additional origins via `CORS_ORIGINS` environment variable (comma-separated)
- Tunnel origins (`*.ngrok-free.app`, `*.ngrok.io`, `*.loca.lt`) are automatically whitelisted
- `start.sh` auto-sets CORS for the LAN IP on ports 4001, 5173, and 4443

### WebSocket Upgrade Routing

The WebSocket server runs in `noServer` mode for selective upgrade handling:

- Tunnel requests without a token or `mobile=1` param are rejected (prevents Vite HMR leaking over the tunnel)
- Mobile connections are validated against the active tunnel token
- Ping/pong heartbeat every 30 seconds to keep connections alive through proxies

### Frontend Proxying Over Tunnel

When accessed via tunnel, the backend proxies non-API requests to the Vite dev server (port 5173). If Vite is not running (production mode), falls through to static files in `/dist`.

### SSH Infrastructure (`setup-claudia-remote.sh`)

The remote setup script provisions a Linux host for Claudia with SSH-based file access back to a Mac:

1. **SSH keypair**: generates Ed25519 key (`~/.ssh/claudia_ed25519`) on the remote host
2. **Public key auth**: installs the key in Mac's `~/.ssh/authorized_keys`
3. **SSH config**: writes a `Host mac` alias with `ServerAliveInterval=30`
4. **SSHFS mounts**: mounts Mac's `~/projects` at `/Users/<mac-user>/projects` on the remote host via `sshfs` with `reconnect` and `ServerAliveInterval=15`
5. **systemd automount**: creates `.mount` and `.automount` units so the SSHFS mount reconnects automatically on access
6. **Claudia service**: systemd unit depending on the automount, with `Restart=on-failure`
7. **Sudoers**: allows `systemctl start/stop/restart/status claudia` without password

The SSHFS mount preserves Mac workspace paths so Claudia directory paths are identical on both machines.

### Built-in SSHFS Workspace Mounting

Claudia can mount directories from a client machine on demand via the "Add Local Workspace" UI. This requires SSH key auth from the server to the client.

- **Backend**: `sshfs-manager.ts` creates ephemeral SSHFS mounts under `~/.claudia/mounts/<hostname>/`
- **API**: `POST /api/sshfs/mount` (create), `GET /api/sshfs/mounts` (list), `DELETE /api/sshfs/mount/:id` (remove)
- **Lifecycle**: mounts are tracked in memory and unmounted on server shutdown
- **Mount options**: `reconnect`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`

The "Add Remote Workspace" option browses the server's filesystem directly. "Add Local Workspace" creates an SSHFS mount first, then adds the mount point as a workspace.

### VM Setup (`setup-claudia-vm.sh`)

Alternative to SSH remote: runs Claudia in a Colima VM on macOS.

- Uses `virtiofs` for directory mounting (no SSHFS needed)
- VM gets a routable LAN IP via `--network-address`
- MCP servers (ports 8100, 8101) run on the Mac for file/shell access from the VM

### Port Assignments

| Service | Port | Notes |
|---------|------|-------|
| Backend (Express + WebSocket) | 4001 | Never change this |
| Frontend (Vite dev server) | 5173 | Dev mode only |
| OpenCode | 4097 | Alternative backend |
| Reverse proxy (nginx/Caddy) | 443 or 4443 | TLS termination |
| ngrok local API | 4040 | Tunnel status polling |
| Filesystem MCP (Mac) | 8100 | Remote setup only |
| Shell MCP (Mac) | 8101 | Remote setup only |

### CLI Helper (`bin/claudia`)

Unified CLI for managing Claudia across deployment modes:

| Command | Purpose |
|---------|---------|
| `claudia start` | Boot VM or connect to remote, start Claudia, health check |
| `claudia stop` | Stop Claudia (keep VM/remote running) |
| `claudia logs` | Tail logs (journalctl for remote, tail for local) |
| `claudia ssh [cmd]` | Open shell or run command on host |
| `claudia trust <path>` | Pre-trust workspace with Claude Code |
| `claudia status` | Show current status and URL |

Mode is read from `~/.config/claudia/config` (`MODE=local` or `MODE=remote`).

---

## Development

See [DEVELOPER.md](DEVELOPER.md) for dev server setup, testing, and releasing.
