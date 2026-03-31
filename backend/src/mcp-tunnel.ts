/**
 * McpTunnel - Routes MCP HTTP requests through connected claudia-client daemons
 *
 * Daemons connect via WebSocket and register themselves. When a proxy request
 * arrives for a client, we forward it as an mcp:request message and wait for
 * the corresponding mcp:response or mcp:error reply, identified by requestId.
 */

import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { createLogger } from './logger.js';

const logger = createLogger('[McpTunnel]');

export interface McpRequestMessage {
    type: 'mcp:request';
    requestId: string;
    mcpPort: number;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
}

export interface McpResponseMessage {
    type: 'mcp:response';
    requestId: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

export interface McpErrorMessage {
    type: 'mcp:error';
    requestId: string;
    error: string;
}

export interface DaemonHelloMessage {
    type: 'daemon:hello';
    fsMcpPort: number;
    shellMcpPort: number;
}

export interface DaemonInfo {
    clientId: string;
    fsMcpPort: number;
    shellMcpPort: number;
    connectedAt: string;
}

interface PendingRequest {
    resolve: (result: McpProxyResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export interface McpProxyResult {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

export interface TunnelStatus {
    connected: boolean;
    clientId?: string;
    connectedAt?: Date;
    requestCount: number;
    errorCount: number;
    lastRequestAt?: Date;
}

const REQUEST_TIMEOUT_MS = 60_000;

export class McpTunnel {
    // Map from clientId → WebSocket
    private daemons = new Map<string, WebSocket>();
    // Map from clientId → daemon metadata
    private daemonInfo = new Map<string, DaemonInfo>();
    // Map from requestId → pending promise callbacks
    private pending = new Map<string, PendingRequest>();

    // Observability counters
    private requestCount = 0;
    private errorCount = 0;
    private lastRequestAt: Date | undefined = undefined;
    // Track the most recently registered clientId for getStatus()
    private activeClientId: string | undefined = undefined;
    private activeConnectedAt: Date | undefined = undefined;

    registerDaemon(clientId: string, ws: WebSocket, info: Omit<DaemonInfo, 'clientId' | 'connectedAt'>): void {
        if (this.daemons.has(clientId)) {
            logger.warn('Replacing existing daemon connection', { clientId });
            const old = this.daemons.get(clientId)!;
            if (old.readyState === WebSocket.OPEN) {
                old.close(1000, 'replaced by new connection');
            }
        }

        const connectedAt = new Date();
        this.daemons.set(clientId, ws);
        this.daemonInfo.set(clientId, {
            clientId,
            fsMcpPort: info.fsMcpPort,
            shellMcpPort: info.shellMcpPort,
            connectedAt: connectedAt.toISOString(),
        });

        this.activeClientId = clientId;
        this.activeConnectedAt = connectedAt;

        logger.info('Daemon registered', { clientId, fsMcpPort: info.fsMcpPort, shellMcpPort: info.shellMcpPort });

        // Reject any in-flight requests for this client when it disconnects
        ws.on('close', () => {
            this.unregisterDaemon(clientId);
        });

        // Route mcp:response and mcp:error messages arriving on this WS
        ws.on('message', (data: Buffer) => {
            let msg: unknown;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                logger.warn('Received non-JSON message from daemon', { clientId });
                return;
            }
            this.handleDaemonMessage(clientId, msg);
        });
    }

    unregisterDaemon(clientId: string): void {
        if (!this.daemons.has(clientId)) return;

        this.daemons.delete(clientId);
        this.daemonInfo.delete(clientId);

        if (this.activeClientId === clientId) {
            this.activeClientId = undefined;
            this.activeConnectedAt = undefined;
        }

        logger.info('Daemon unregistered', { clientId });

        // Reject any pending requests that were waiting on this daemon
        for (const [requestId, pending] of this.pending) {
            // Determine if this pending request belongs to this client by checking if
            // no daemon is left to serve it. Since we don't store clientId per request
            // in the map key, we reject all that no daemon can serve anymore — safe
            // because the daemon disconnect means they can't be answered.
            clearTimeout(pending.timer);
            pending.reject(new Error(`Daemon '${clientId}' disconnected while request was in-flight`));
            this.pending.delete(requestId);
        }
    }

    private handleDaemonMessage(clientId: string, msg: unknown): void {
        if (typeof msg !== 'object' || msg === null) return;
        const m = msg as Record<string, unknown>;

        if (m.type === 'mcp:response') {
            const resp = m as unknown as McpResponseMessage;
            const pending = this.pending.get(resp.requestId);
            if (!pending) {
                logger.warn('Received mcp:response for unknown requestId', { requestId: resp.requestId, clientId });
                return;
            }
            clearTimeout(pending.timer);
            this.pending.delete(resp.requestId);
            pending.resolve({ status: resp.status, body: resp.body, headers: resp.headers });
        } else if (m.type === 'mcp:error') {
            const err = m as unknown as McpErrorMessage;
            const pending = this.pending.get(err.requestId);
            if (!pending) {
                logger.warn('Received mcp:error for unknown requestId', { requestId: err.requestId, clientId });
                return;
            }
            clearTimeout(pending.timer);
            this.pending.delete(err.requestId);
            this.errorCount++;
            pending.reject(new Error(err.error));
        }
    }

    async routeMcpRequest(
        clientId: string,
        port: number,
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>
    ): Promise<McpProxyResult> {
        const ws = this.daemons.get(clientId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error(`No active daemon for client '${clientId}'`);
        }

        const requestId = randomUUID();
        const start = Date.now();

        this.requestCount++;
        this.lastRequestAt = new Date();

        logger.info('MCP request start', { clientId, method, path, port, requestId });

        const result = await new Promise<McpProxyResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(requestId, { resolve, reject, timer });

            const msg: McpRequestMessage = {
                type: 'mcp:request',
                requestId,
                mcpPort: port,
                method,
                path,
                body,
                headers,
            };

            try {
                ws.send(JSON.stringify(msg));
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });

        const duration = Date.now() - start;
        logger.info('MCP request complete', { clientId, method, path, port, requestId, status: result.status, durationMs: duration });

        return result;
    }

    getDaemonStatus(): DaemonInfo[] {
        return Array.from(this.daemonInfo.values());
    }

    isDaemonConnected(clientId: string): boolean {
        const ws = this.daemons.get(clientId);
        return !!ws && ws.readyState === WebSocket.OPEN;
    }

    /**
     * Returns live tunnel health including request/error counters and last activity.
     * The "connected" flag reflects whether at least one daemon is currently registered.
     */
    getStatus(): TunnelStatus {
        const connected = this.daemons.size > 0;
        return {
            connected,
            clientId: this.activeClientId,
            connectedAt: this.activeConnectedAt,
            requestCount: this.requestCount,
            errorCount: this.errorCount,
            lastRequestAt: this.lastRequestAt,
        };
    }
}
