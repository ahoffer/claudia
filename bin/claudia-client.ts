#!/usr/bin/env npx tsx
/**
 * claudia-client — bridges local MCP servers to a remote claudia server
 *
 * Spawns filesystem-mcp and shell-mcp as child processes on startup if their
 * ports are not already in use. Kills them on exit.
 *
 * Config file (~/.config/claudia/config):
 *   CLAUDIA_SERVER_URL=wss://myserver:4443
 *   CLAUDIA_TOKEN=<auth-token>
 *   PROJECTS_DIR=~/projects
 *   FS_MCP_PORT=8100
 *   SHELL_MCP_PORT=8101
 *   FS_MCP_CMD=npx -y @modelcontextprotocol/server-filesystem <projects-dir>
 *   SHELL_MCP_CMD=npx -y @modelcontextprotocol/server-shell
 *
 * CLI flags:
 *   --config <path>   override config file path
 *   --server <url>    override CLAUDIA_SERVER_URL
 *   --token <token>   override CLAUDIA_TOKEN
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaemonConfig {
    serverUrl: string;
    token: string;
    fsMcpPort: number;
    shellMcpPort: number;
    projectsDir: string;
    fsMcpCmd: string;
    shellMcpCmd: string;
}

interface McpRequestMessage {
    type: 'mcp:request';
    requestId: string;
    mcpPort: number;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Structured logging — uses stderr so stdout stays clean
// Format: 2026-03-31T10:00:00Z INFO  [tag] message
// ---------------------------------------------------------------------------

function log(level: 'INFO' | 'WARN' | 'ERROR', tag: string, message: string): void {
    const ts = new Date().toISOString();
    const paddedLevel = level.padEnd(5);
    process.stderr.write(`${ts} ${paddedLevel} [${tag}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function parseConfigFile(filePath: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!existsSync(filePath)) return result;
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        result[key] = value;
    }
    return result;
}

function parseArgs(argv: string[]): { configPath?: string; serverUrl?: string; token?: string } {
    const result: { configPath?: string; serverUrl?: string; token?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--config' && argv[i + 1]) result.configPath = argv[++i];
        if (argv[i] === '--server' && argv[i + 1]) result.serverUrl = argv[++i];
        if (argv[i] === '--token' && argv[i + 1]) result.token = argv[++i];
    }
    return result;
}

function loadConfig(args: ReturnType<typeof parseArgs>): { config: DaemonConfig; configPath: string; configFound: boolean } {
    const defaultConfigPath = join(homedir(), '.config', 'claudia', 'config');
    const configPath = args.configPath ?? defaultConfigPath;
    const configFound = existsSync(configPath);
    const file = parseConfigFile(configPath);

    const serverUrl = args.serverUrl ?? file['CLAUDIA_SERVER_URL'] ?? '';
    const token = args.token ?? file['CLAUDIA_TOKEN'] ?? '';
    const fsMcpPort = parseInt(file['FS_MCP_PORT'] ?? '8100', 10);
    const shellMcpPort = parseInt(file['SHELL_MCP_PORT'] ?? '8101', 10);
    const projectsDir = (file['PROJECTS_DIR'] ?? join(homedir(), 'projects')).replace(/^~/, homedir());
    const fsMcpCmd = file['FS_MCP_CMD'] ?? `npx -y @modelcontextprotocol/server-filesystem ${projectsDir}`;
    const shellMcpCmd = file['SHELL_MCP_CMD'] ?? 'npx -y @modelcontextprotocol/server-shell';

    return {
        config: { serverUrl, token, fsMcpPort, shellMcpPort, projectsDir, fsMcpCmd, shellMcpCmd },
        configPath,
        configFound,
    };
}

// ---------------------------------------------------------------------------
// TCP reachability check
// ---------------------------------------------------------------------------

function checkTcpPort(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (reachable: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(timeoutMs);
        socket.on('connect', () => finish(true));
        socket.on('error', () => finish(false));
        socket.on('timeout', () => finish(false));
        socket.connect(port, '127.0.0.1');
    });
}

// ---------------------------------------------------------------------------
// MCP child process manager
// ---------------------------------------------------------------------------

interface ManagedProcess {
    label: string;
    port: number;
    cmd: string;
    proc: ChildProcess | null;
    restartAttempted: boolean;
}

function spawnMcpServer(mp: ManagedProcess, restartOnExit: (mp: ManagedProcess) => void): void {
    const [bin, ...cmdArgs] = mp.cmd.split(/\s+/);
    log('INFO', mp.label, `Spawning: ${mp.cmd}`);

    const proc = spawn(bin, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    mp.proc = proc;
    mp.restartAttempted = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
            if (line.trim()) log('INFO', mp.label, line.trim());
        }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
            if (line.trim()) log('INFO', mp.label, line.trim());
        }
    });

    proc.on('exit', (code, signal) => {
        mp.proc = null;
        if (code !== null || signal !== null) {
            log('WARN', mp.label, `Exited (code=${code}, signal=${signal})`);
        }
        restartOnExit(mp);
    });

    proc.on('error', (err) => {
        log('ERROR', mp.label, `Failed to start: ${err.message}`);
    });
}

class McpProcessManager {
    private servers: ManagedProcess[] = [];

    add(label: string, port: number, cmd: string): void {
        this.servers.push({ label, port, cmd, proc: null, restartAttempted: false });
    }

    async startAll(): Promise<void> {
        for (const mp of this.servers) {
            const alreadyUp = await checkTcpPort(mp.port);
            if (alreadyUp) {
                log('INFO', mp.label, `Port ${mp.port} already in use — skipping spawn`);
            } else {
                spawnMcpServer(mp, (dead) => this.handleExit(dead));
            }
        }
    }

    private handleExit(mp: ManagedProcess): void {
        if (mp.restartAttempted) {
            log('ERROR', mp.label, 'Died again after one restart attempt — not retrying');
            return;
        }
        log('WARN', mp.label, 'Died unexpectedly — restarting once...');
        mp.restartAttempted = true;
        setTimeout(() => spawnMcpServer(mp, (dead) => this.handleExit(dead)), 1000);
    }

    killAll(): void {
        for (const mp of this.servers) {
            if (mp.proc) {
                log('INFO', mp.label, 'Sending SIGTERM');
                mp.proc.kill('SIGTERM');
                mp.proc = null;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Startup self-diagnostic
// ---------------------------------------------------------------------------

async function runStartupDiagnostic(
    configPath: string,
    configFound: boolean,
    config: DaemonConfig,
    fsSpawned: boolean,
    shellSpawned: boolean,
): Promise<boolean> {
    const homePath = configPath.startsWith(homedir())
        ? configPath.replace(homedir(), '~')
        : configPath;

    // Give spawned processes a moment to bind their ports
    if (fsSpawned || shellSpawned) await new Promise(r => setTimeout(r, 1500));

    const fsReachable = await checkTcpPort(config.fsMcpPort);
    const shellReachable = await checkTcpPort(config.shellMcpPort);

    const fsSource = fsSpawned ? 'spawned' : 'pre-existing';
    const shellSource = shellSpawned ? 'spawned' : 'pre-existing';

    process.stderr.write('claudia-client startup check\n');
    process.stderr.write(`  config file:     ${homePath}  [${configFound ? 'found' : 'not found'}]\n`);
    process.stderr.write(`  server URL:      ${config.serverUrl || '(not set)'}  [${config.serverUrl ? 'set' : 'not set'}]\n`);
    process.stderr.write(`  auth token:      [${config.token ? 'set' : 'not set'}]\n`);
    process.stderr.write(`  projects dir:    ${config.projectsDir}\n`);
    process.stderr.write(`  filesystem-mcp:  localhost:${config.fsMcpPort}  [${fsReachable ? 'reachable' : 'starting'}]  (${fsSource})\n`);
    process.stderr.write(`  shell-mcp:       localhost:${config.shellMcpPort}  [${shellReachable ? 'reachable' : 'starting'}]  (${shellSource})\n`);

    if (!config.serverUrl) {
        log('ERROR', 'config', 'CLAUDIA_SERVER_URL is not set. Use --server <url> or set it in config.');
        return false;
    }
    if (!config.token) {
        log('ERROR', 'config', 'CLAUDIA_TOKEN is not set. Use --token <token> or set it in config.');
        return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// MCP HTTP forwarding
// ---------------------------------------------------------------------------

async function forwardMcpRequest(req: McpRequestMessage): Promise<{
    status: number;
    body: unknown;
    headers: Record<string, string>;
}> {
    const url = `http://localhost:${req.mcpPort}${req.path}`;

    const fetchHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...(req.headers ?? {}),
    };

    const options: RequestInit = {
        method: req.method,
        headers: fetchHeaders,
    };

    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        options.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, options);

    let body: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        body = await response.json();
    } else {
        body = await response.text();
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });

    return { status: response.status, body, headers: responseHeaders };
}

// ---------------------------------------------------------------------------
// Daemon connection loop with exponential backoff and request buffering
// ---------------------------------------------------------------------------

const RECONNECT_BUFFER_MS = 3000;

interface BufferedRequest {
    req: McpRequestMessage;
    resolve: (ws: WebSocket) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

class DaemonClient {
    private config: DaemonConfig;
    private mcpManager: McpProcessManager;
    private ws: WebSocket | null = null;
    private stopping = false;
    private retryDelay = 1000; // ms, doubles up to maxDelay
    private readonly maxDelay = 30_000;
    private pingInterval: ReturnType<typeof setInterval> | null = null;

    // Buffer for mcp:request messages received while disconnected
    private requestBuffer: BufferedRequest[] = [];
    private reconnecting = false;

    constructor(config: DaemonConfig, mcpManager: McpProcessManager) {
        this.config = config;
        this.mcpManager = mcpManager;
    }

    start(): void {
        this.connect();

        const shutdown = () => {
            this.stopping = true;
            log('INFO', 'tunnel', 'Shutting down...');
            if (this.pingInterval) clearInterval(this.pingInterval);
            if (this.ws) this.ws.close(1000, 'shutdown');
            this.mcpManager.killAll();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }

    private connect(): void {
        const { serverUrl, token, fsMcpPort, shellMcpPort } = this.config;

        log('INFO', 'tunnel', `Connecting to ${serverUrl}...`);
        log('WARN', 'tunnel', 'Certificate validation is disabled (rejectUnauthorized=false)');

        const ws = new WebSocket(serverUrl, {
            headers: { Authorization: `Bearer ${token}` },
            rejectUnauthorized: false,
        });
        this.ws = ws;

        ws.on('open', () => {
            log('INFO', 'tunnel', `Connected to ${serverUrl}`);
            this.retryDelay = 1000;
            this.reconnecting = false;

            ws.send(JSON.stringify({
                type: 'daemon:hello',
                fsMcpPort,
                shellMcpPort,
            }));

            this.drainBuffer(ws);

            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, 20_000);
        });

        ws.on('message', (data: Buffer) => {
            let msg: unknown;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                log('WARN', 'tunnel', 'Received non-JSON message from server');
                return;
            }

            if (
                typeof msg === 'object' &&
                msg !== null &&
                (msg as Record<string, unknown>)['type'] === 'mcp:request'
            ) {
                const req = msg as McpRequestMessage;

                if (ws.readyState !== WebSocket.OPEN) {
                    this.bufferRequest(req);
                } else {
                    this.handleMcpRequest(ws, req);
                }
            }
        });

        ws.on('close', (code, reason) => {
            const reasonStr = reason?.toString() || 'no reason';
            log('WARN', 'tunnel', `Disconnected — code: ${code}, reason: ${reasonStr}`);

            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }

            if (!this.stopping) {
                this.reconnecting = true;
                this.scheduleReconnect();
            }
        });

        ws.on('error', (err) => {
            log('ERROR', 'tunnel', `WebSocket error: ${err.message}`);
        });
    }

    /**
     * Buffer an incoming mcp:request during a reconnect window.
     * If the tunnel reconnects within RECONNECT_BUFFER_MS the request is forwarded.
     * Otherwise it is rejected with a retryable error.
     */
    private bufferRequest(req: McpRequestMessage): void {
        log('WARN', 'mcp', `Buffering request requestId=${req.requestId} — tunnel reconnecting`);

        const timer = setTimeout(() => {
            this.requestBuffer = this.requestBuffer.filter(b => b.req.requestId !== req.requestId);
            log('ERROR', 'mcp', `Rejecting buffered request requestId=${req.requestId} — reconnect timed out`);
            const currentWs = this.ws;
            if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                currentWs.send(JSON.stringify({
                    type: 'mcp:error',
                    requestId: req.requestId,
                    error: 'tunnel reconnecting',
                    retryable: true,
                }));
            }
        }, RECONNECT_BUFFER_MS);

        this.requestBuffer.push({
            req,
            resolve: (ws: WebSocket) => {
                clearTimeout(timer);
                this.handleMcpRequest(ws, req);
            },
            reject: (err: Error) => {
                clearTimeout(timer);
                log('ERROR', 'mcp', `Rejecting buffered request requestId=${req.requestId}: ${err.message}`);
            },
            timer,
        });
    }

    private drainBuffer(ws: WebSocket): void {
        if (this.requestBuffer.length === 0) return;
        log('INFO', 'mcp', `Draining ${this.requestBuffer.length} buffered request(s) after reconnect`);
        const toFlush = this.requestBuffer.splice(0);
        for (const entry of toFlush) {
            entry.resolve(ws);
        }
    }

    private handleMcpRequest(ws: WebSocket, req: McpRequestMessage): void {
        const start = Date.now();
        log('INFO', 'mcp', `Request ${req.method} ${req.path} port=${req.mcpPort} requestId=${req.requestId}`);

        forwardMcpRequest(req)
            .then(({ status, body, headers }) => {
                const duration = Date.now() - start;
                log('INFO', 'mcp', `Response requestId=${req.requestId} status=${status} duration=${duration}ms`);
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({
                    type: 'mcp:response',
                    requestId: req.requestId,
                    status,
                    body,
                    headers,
                }));
            })
            .catch((err: Error) => {
                const duration = Date.now() - start;
                log('ERROR', 'mcp', `Forward failed requestId=${req.requestId} duration=${duration}ms: ${err.message}`);
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({
                    type: 'mcp:error',
                    requestId: req.requestId,
                    error: err.message,
                }));
            });
    }

    private scheduleReconnect(): void {
        log('WARN', 'tunnel', `Disconnected, reconnecting in ${this.retryDelay / 1000}s`);
        setTimeout(() => {
            if (!this.stopping) this.connect();
        }, this.retryDelay);

        this.retryDelay = Math.min(this.retryDelay * 2, this.maxDelay);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const { config, configPath, configFound } = loadConfig(args);

const mcpManager = new McpProcessManager();
mcpManager.add('fs-mcp', config.fsMcpPort, config.fsMcpCmd);
mcpManager.add('shell-mcp', config.shellMcpPort, config.shellMcpCmd);

// Check which ports are free before starting, so we can report spawn vs pre-existing
Promise.all([checkTcpPort(config.fsMcpPort), checkTcpPort(config.shellMcpPort)])
    .then(async ([fsUp, shellUp]) => {
        const fsSpawned = !fsUp;
        const shellSpawned = !shellUp;

        await mcpManager.startAll();

        const ok = await runStartupDiagnostic(configPath, configFound, config, fsSpawned, shellSpawned);
        if (!ok) {
            mcpManager.killAll();
            process.exit(1);
        }

        const daemon = new DaemonClient(config, mcpManager);
        daemon.start();
    });
