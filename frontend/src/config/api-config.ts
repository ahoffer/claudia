/**
 * API Configuration - Centralized URL management for backend API
 *
 * Access modes (checked in order):
 * 1. Tunnel (ngrok, localtunnel) — same-origin, protocol from page
 * 2. Direct HTTPS — local/LAN with self-signed cert, explicit backend port
 * 3. Reverse proxy (Caddy/nginx) — same-origin through proxy
 * 4. Plain HTTP dev — explicit backend port
 */
import { PORTS } from '@claudia/shared';

/** True when the page was loaded through a tunnel proxy (ngrok, localtunnel, etc.) */
export function isTunnelAccess(): boolean {
    const host = window.location.hostname;
    return host.includes('.loca.lt') || host.includes('localtunnel') ||
           host.includes('.ngrok-free.app') || host.includes('.ngrok.io') || host.includes('ngrok');
}

/**
 * True when running locally (or on LAN) with HTTPS but without a reverse proxy.
 * The page is served by Vite on its own port, so API requests must target the
 * backend port explicitly (cross-origin).
 */
function isDirectHttps(): boolean {
    if (window.location.protocol !== 'https:') return false;
    if (isTunnelAccess()) return false;
    const host = window.location.hostname;
    // localhost, 127.0.0.1, or bare IP addresses are direct access
    return host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * True when the page was loaded via HTTPS from a non-tunnel, non-direct host,
 * meaning a reverse proxy (e.g. Caddy) is terminating TLS in front of the backend.
 * In this case all traffic must go through the same origin.
 */
export function isReverseProxyAccess(): boolean {
    return window.location.protocol === 'https:' && !isTunnelAccess() && !isDirectHttps();
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
 */
export function getApiBaseUrl(): string {
    if (isTunnelAccess()) return window.location.origin;
    if (isDirectHttps()) return `https://${window.location.hostname}:${PORTS.BACKEND}`;
    if (isReverseProxyAccess()) return window.location.origin;
    return `http://${window.location.hostname}:${PORTS.BACKEND}`;
}

/**
 * Get the WebSocket URL
 */
export function getWebSocketUrl(): string {
    if (isTunnelAccess()) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = getMobileToken();
        const base = `${proto}//${window.location.host}`;
        return token ? `${base}?token=${token}&mobile=1` : base;
    }
    if (isDirectHttps()) return `wss://${window.location.hostname}:${PORTS.BACKEND}`;
    if (isReverseProxyAccess()) return `wss://${window.location.host}`;
    return `ws://${window.location.hostname}:${PORTS.BACKEND}`;
}
