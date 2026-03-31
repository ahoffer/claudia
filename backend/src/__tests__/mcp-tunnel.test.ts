import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { McpTunnel } from '../mcp-tunnel.js';

// Minimal WebSocket stub
class MockWebSocket extends EventEmitter {
    readyState = 1; // OPEN
    sent: string[] = [];

    send(data: string): void {
        this.sent.push(data);
    }

    close(_code?: number, _reason?: string): void {
        this.readyState = 3; // CLOSED
        this.emit('close', _code ?? 1000);
    }

    simulateMessage(obj: unknown): void {
        this.emit('message', Buffer.from(JSON.stringify(obj)));
    }
}

// Vitest does not expose a standalone WebSocket.OPEN constant; import from ws
// instead, or just use the numeric value (1 = OPEN, 3 = CLOSED).
const WS_OPEN = 1;
const WS_CLOSED = 3;

describe('McpTunnel', () => {
    let tunnel: McpTunnel;
    let ws: MockWebSocket;
    const clientId = 'test-client';

    beforeEach(() => {
        tunnel = new McpTunnel();
        ws = new MockWebSocket();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    describe('registerDaemon / getDaemonStatus', () => {
        it('adds daemon to status list on register', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            const status = tunnel.getDaemonStatus();
            expect(status).toHaveLength(1);
            expect(status[0].clientId).toBe(clientId);
            expect(status[0].fsMcpPort).toBe(8100);
            expect(status[0].shellMcpPort).toBe(8101);
            expect(status[0].connectedAt).toBeDefined();
        });

        it('marks daemon as connected', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            expect(tunnel.isDaemonConnected(clientId)).toBe(true);
        });

        it('replaces existing connection with new one', () => {
            const ws2 = new MockWebSocket();
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            tunnel.registerDaemon(clientId, ws2 as any, { fsMcpPort: 8200, shellMcpPort: 8201 });
            const status = tunnel.getDaemonStatus();
            expect(status).toHaveLength(1);
            expect(status[0].fsMcpPort).toBe(8200);
        });
    });

    describe('unregisterDaemon', () => {
        it('removes daemon when explicitly unregistered', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            tunnel.unregisterDaemon(clientId);
            expect(tunnel.getDaemonStatus()).toHaveLength(0);
            expect(tunnel.isDaemonConnected(clientId)).toBe(false);
        });

        it('removes daemon when WebSocket closes', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            ws.close();
            expect(tunnel.getDaemonStatus()).toHaveLength(0);
        });
    });

    // -------------------------------------------------------------------------
    // Request/response correlation
    // -------------------------------------------------------------------------

    describe('routeMcpRequest', () => {
        beforeEach(() => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
        });

        it('sends mcp:request message to daemon WS', async () => {
            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools', undefined, undefined);

            expect(ws.sent).toHaveLength(1);
            const msg = JSON.parse(ws.sent[0]);
            expect(msg.type).toBe('mcp:request');
            expect(msg.mcpPort).toBe(8100);
            expect(msg.method).toBe('GET');
            expect(msg.path).toBe('/tools');
            expect(typeof msg.requestId).toBe('string');

            // Resolve the pending request
            ws.simulateMessage({ type: 'mcp:response', requestId: msg.requestId, status: 200, body: { ok: true } });

            const result = await promise;
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ ok: true });
        });

        it('resolves with response headers when provided', async () => {
            const promise = tunnel.routeMcpRequest(clientId, 8100, 'POST', '/execute', { cmd: 'ls' });

            const msg = JSON.parse(ws.sent[0]);
            ws.simulateMessage({
                type: 'mcp:response',
                requestId: msg.requestId,
                status: 200,
                body: {},
                headers: { 'x-custom': 'value' },
            });

            const result = await promise;
            expect(result.headers?.['x-custom']).toBe('value');
        });

        it('rejects on mcp:error from daemon', async () => {
            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');

            const msg = JSON.parse(ws.sent[0]);
            ws.simulateMessage({ type: 'mcp:error', requestId: msg.requestId, error: 'connection refused' });

            await expect(promise).rejects.toThrow('connection refused');
        });

        it('rejects immediately when no daemon is connected', async () => {
            tunnel.unregisterDaemon(clientId);
            await expect(
                tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools')
            ).rejects.toThrow(`No active daemon for client '${clientId}'`);
        });

        it('rejects when daemon WS is not OPEN', async () => {
            ws.readyState = WS_CLOSED;
            await expect(
                tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools')
            ).rejects.toThrow(`No active daemon for client '${clientId}'`);
        });
    });

    // -------------------------------------------------------------------------
    // Timeout handling
    // -------------------------------------------------------------------------

    describe('timeout', () => {
        it('rejects pending request after timeout', async () => {
            vi.useFakeTimers();
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });

            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');

            // Advance past 60-second timeout
            vi.advanceTimersByTime(61_000);

            await expect(promise).rejects.toThrow('timed out');
        });
    });

    // -------------------------------------------------------------------------
    // Disconnect while request in-flight
    // -------------------------------------------------------------------------

    describe('disconnect while in-flight', () => {
        it('rejects pending requests when daemon disconnects', async () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });

            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');

            // Simulate daemon disconnect
            ws.close();

            await expect(promise).rejects.toThrow('disconnected');
        });

        it('rejects with a clear message including the clientId', async () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });

            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');
            ws.close();

            await expect(promise).rejects.toThrow(clientId);
        });
    });

    // -------------------------------------------------------------------------
    // Unknown requestId
    // -------------------------------------------------------------------------

    describe('unknown requestId handling', () => {
        it('does not throw when receiving response for unknown requestId', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            // Should not throw
            expect(() => {
                ws.simulateMessage({ type: 'mcp:response', requestId: 'no-such-id', status: 200, body: {} });
            }).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // getStatus() counters
    // -------------------------------------------------------------------------

    describe('getStatus()', () => {
        it('returns connected=false and zero counts when no daemon is registered', () => {
            const status = tunnel.getStatus();
            expect(status.connected).toBe(false);
            expect(status.requestCount).toBe(0);
            expect(status.errorCount).toBe(0);
            expect(status.lastRequestAt).toBeUndefined();
            expect(status.clientId).toBeUndefined();
            expect(status.connectedAt).toBeUndefined();
        });

        it('returns connected=true and clientId after a daemon registers', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            const status = tunnel.getStatus();
            expect(status.connected).toBe(true);
            expect(status.clientId).toBe(clientId);
            expect(status.connectedAt).toBeInstanceOf(Date);
        });

        it('returns connected=false after daemon disconnects', () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });
            ws.close();
            const status = tunnel.getStatus();
            expect(status.connected).toBe(false);
            expect(status.clientId).toBeUndefined();
        });

        it('increments requestCount on each routeMcpRequest call', async () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });

            const p1 = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');
            const msg1 = JSON.parse(ws.sent[0]);
            ws.simulateMessage({ type: 'mcp:response', requestId: msg1.requestId, status: 200, body: {} });
            await p1;

            const p2 = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');
            const msg2 = JSON.parse(ws.sent[1]);
            ws.simulateMessage({ type: 'mcp:response', requestId: msg2.requestId, status: 200, body: {} });
            await p2;

            expect(tunnel.getStatus().requestCount).toBe(2);
        });

        it('increments errorCount on mcp:error response', async () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });

            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');
            const msg = JSON.parse(ws.sent[0]);
            ws.simulateMessage({ type: 'mcp:error', requestId: msg.requestId, error: 'something failed' });

            await expect(promise).rejects.toThrow('something failed');
            expect(tunnel.getStatus().errorCount).toBe(1);
        });

        it('records lastRequestAt after a request is issued', async () => {
            tunnel.registerDaemon(clientId, ws as any, { fsMcpPort: 8100, shellMcpPort: 8101 });

            const before = new Date();
            const promise = tunnel.routeMcpRequest(clientId, 8100, 'GET', '/tools');
            const msg = JSON.parse(ws.sent[0]);
            ws.simulateMessage({ type: 'mcp:response', requestId: msg.requestId, status: 200, body: {} });
            await promise;
            const after = new Date();

            const { lastRequestAt } = tunnel.getStatus();
            expect(lastRequestAt).toBeInstanceOf(Date);
            expect(lastRequestAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(lastRequestAt!.getTime()).toBeLessThanOrEqual(after.getTime());
        });
    });
});
