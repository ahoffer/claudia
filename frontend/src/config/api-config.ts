/**
 * API Configuration - Centralized URL management for backend API
 * Supports both web (development/production) and Electron environments.
 * When accessed via a localtunnel (e.g. mobile over the internet), the
 * backend reverse-proxies the frontend on the same origin, so we use
 * same-origin URLs instead of pointing at a separate port.
 * When accessed via an HTTPS reverse proxy (e.g. Caddy on a remote host),
 * the page protocol is https: — we use same-origin URLs so requests go
 * through the proxy rather than trying to reach the backend port directly
 * (which would be blocked as mixed content).
 */
import { PORTS } from '@claudia/shared';

/** True when the page was loaded through a tunnel proxy (ngrok, localtunnel, etc.) */
export function isTunnelAccess(): boolean {
    const host = window.location.hostname;
    return host.includes('.loca.lt') || host.includes('localtunnel') ||
           host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
}

/**
 * True when the page was loaded via HTTPS from a non-tunnel host, meaning
 * a reverse proxy (e.g. Caddy) is terminating TLS in front of the backend.
 * In this case all API and WebSocket traffic must go through the same origin
 * so the proxy can forward it — direct connections to the backend port would
 * be blocked as mixed content.
 */
export function isReverseProxyAccess(): boolean {
    return window.location.protocol === 'https:' && !isTunnelAccess();
}

/**
 * Get the mobile auth token from the URL query string (set by tunnel redirect)
 */
export function getMobileToken(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
}

/**
 * Get the base URL for HTTP API requests
 * @returns Base URL (e.g., "http://localhost:3001")
 */
export function getApiBaseUrl(): string {
    // Check if running in Electron
    if (window.electronAPI) {
        return window.electronAPI.getBackendUrl();
    }

    // Tunnel access — backend is on the same origin (it proxies the frontend)
    if (isTunnelAccess()) {
        return window.location.origin;
    }

    // HTTPS reverse proxy — use same origin so requests go through the proxy
    if (isReverseProxyAccess()) {
        return window.location.origin;
    }

    // Web environment - use hostname with configured port
    return `http://${window.location.hostname}:${PORTS.BACKEND}`;
}

/**
 * Get the WebSocket URL
 * @returns WebSocket URL (e.g., "ws://localhost:3001")
 */
export function getWebSocketUrl(): string {
    // Check if running in Electron
    if (window.electronAPI) {
        const httpUrl = window.electronAPI.getBackendUrl();
        return httpUrl.replace('http://', 'ws://');
    }

    // Tunnel access — use same host, upgrade protocol
    if (isTunnelAccess()) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = getMobileToken();
        const base = `${proto}//${window.location.host}`;
        // Append mobile token so the backend accepts the WebSocket connection
        return token ? `${base}?token=${token}&mobile=1` : base;
    }

    // HTTPS reverse proxy — use wss: on the same host so the proxy forwards it
    if (isReverseProxyAccess()) {
        return `wss://${window.location.host}`;
    }

    // Web environment - use hostname with configured port
    return `ws://${window.location.hostname}:${PORTS.BACKEND}`;
}

/**
 * Check if running in Electron
 * @returns true if in Electron, false otherwise
 */
export function isElectron(): boolean {
    return typeof window.electronAPI !== 'undefined';
}
