import { useState, useEffect } from 'react';
import { getApiBaseUrl } from '../config/api-config';

export interface TunnelStatusData {
    connected: boolean;
    clientId?: string;
    connectedAt?: string;
    requestCount: number;
    errorCount: number;
    lastRequestAt?: string;
}

type LoadState = 'unknown' | 'loaded' | 'error';

export interface TunnelStatus {
    loadState: LoadState;
    data: TunnelStatusData | null;
}

export function useTunnelStatus(intervalMs = 10000): TunnelStatus {
    const [loadState, setLoadState] = useState<LoadState>('unknown');
    const [data, setData] = useState<TunnelStatusData | null>(null);

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/mcp-tunnel/status`);
                if (response.ok) {
                    const json: TunnelStatusData = await response.json();
                    setData(json);
                    setLoadState('loaded');
                } else {
                    setLoadState('error');
                }
            } catch {
                setLoadState('error');
            }
        };

        fetchStatus();

        const interval = setInterval(fetchStatus, intervalMs);
        return () => clearInterval(interval);
    }, [intervalMs]);

    return { loadState, data };
}
