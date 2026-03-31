import { useTunnelStatus } from '../hooks/useTunnelStatus';
import './TunnelStatus.css';

function formatDuration(isoDate: string): string {
    const start = new Date(isoDate).getTime();
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed < 60) return `${elapsed}s`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    return `${h}h ${m}m`;
}

function formatTime(isoDate: string): string {
    return new Date(isoDate).toLocaleTimeString();
}

export function TunnelStatus() {
    const { loadState, data } = useTunnelStatus();

    const stateClass =
        loadState === 'unknown' ? 'tunnel-unknown' :
        data?.connected ? 'tunnel-connected' : 'tunnel-disconnected';

    const stateLabel =
        loadState === 'unknown' ? 'unknown' :
        data?.connected ? 'connected' : 'disconnected';

    return (
        <div className={`tunnel-status ${stateClass}`}>
            <span className="tunnel-dot" />
            <span className="tunnel-state">{stateLabel}</span>
            <span className="tunnel-label">MCP tunnel</span>

            {loadState === 'loaded' && data && (
                <div className="tunnel-tooltip">
                    {data.clientId && (
                        <div className="tunnel-tooltip-row">
                            <span className="tunnel-tooltip-key">Client</span>
                            <span className="tunnel-tooltip-value">{data.clientId}</span>
                        </div>
                    )}
                    {data.connected && data.connectedAt && (
                        <div className="tunnel-tooltip-row">
                            <span className="tunnel-tooltip-key">Duration</span>
                            <span className="tunnel-tooltip-value">{formatDuration(data.connectedAt)}</span>
                        </div>
                    )}
                    <div className="tunnel-tooltip-row">
                        <span className="tunnel-tooltip-key">Requests</span>
                        <span className="tunnel-tooltip-value">{data.requestCount}</span>
                    </div>
                    <div className="tunnel-tooltip-row">
                        <span className="tunnel-tooltip-key">Errors</span>
                        <span className="tunnel-tooltip-value">{data.errorCount}</span>
                    </div>
                    {data.lastRequestAt && (
                        <div className="tunnel-tooltip-row">
                            <span className="tunnel-tooltip-key">Last request</span>
                            <span className="tunnel-tooltip-value">{formatTime(data.lastRequestAt)}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
