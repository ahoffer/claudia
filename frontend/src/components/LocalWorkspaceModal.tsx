import { useState } from 'react';
import { getApiBaseUrl } from '../config/api-config';
import './PathInputModal.css';

interface LocalWorkspaceModalProps {
    onSelect: (mountPoint: string) => void;
    onCancel: () => void;
}

export function LocalWorkspaceModal({ onSelect, onCancel }: LocalWorkspaceModalProps) {
    const [hostname, setHostname] = useState(() => {
        // Default to the browser's hostname if it's not the server
        const h = window.location.hostname;
        return (h === 'localhost' || h === '127.0.0.1') ? '' : '';
    });
    const [remotePath, setRemotePath] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [mounting, setMounting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const h = hostname.trim();
        const p = remotePath.trim();

        if (!h) { setError('Hostname is required'); return; }
        if (!p || !p.startsWith('/')) { setError('Path must be absolute (start with /)'); return; }

        setError(null);
        setMounting(true);

        try {
            const res = await fetch(`${getApiBaseUrl()}/api/sshfs/mount`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hostname: h, remotePath: p }),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Mount failed');
            }
            onSelect(data.mountPoint);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setMounting(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onCancel} role="presentation">
            <div className="modal-content path-input-modal" role="dialog" aria-modal="true" aria-label="Add Local Workspace" onClick={(e) => e.stopPropagation()}>
                <h2>Add Local Workspace</h2>
                <p className="help-text" style={{ marginBottom: 16 }}>
                    Mount a folder from your local machine onto the server via SSHFS.
                    SSH key auth must be configured between the server and your machine.
                </p>

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="sshfs-hostname">Your machine's hostname</label>
                        <input
                            id="sshfs-hostname"
                            type="text"
                            value={hostname}
                            onChange={(e) => setHostname(e.target.value)}
                            placeholder="clown"
                            autoFocus
                            className="path-input"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="sshfs-path">Folder path on your machine</label>
                        <input
                            id="sshfs-path"
                            type="text"
                            value={remotePath}
                            onChange={(e) => setRemotePath(e.target.value)}
                            placeholder="/Users/you/projects/my-project"
                            className="path-input"
                        />
                    </div>

                    {error && (
                        <div className="dir-status dir-error" style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(248,81,73,0.1)' }}>
                            {error}
                        </div>
                    )}

                    <div className="modal-actions">
                        <button type="button" onClick={onCancel} className="btn-secondary" disabled={mounting}>
                            Cancel
                        </button>
                        <button type="submit" disabled={mounting || !hostname.trim() || !remotePath.trim()} className="btn-primary">
                            {mounting ? 'Mounting...' : 'Mount & Add Workspace'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
