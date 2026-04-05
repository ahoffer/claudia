import { useState, useEffect, useCallback } from 'react';
import { getApiBaseUrl } from '../config/api-config';
import './DirectoryBrowser.css';

interface DirectoryBrowserProps {
    onSelect: (path: string) => void;
    onCancel: () => void;
    initialPath?: string;
}

interface DirListing {
    path: string;
    parent: string | null;
    directories: string[];
}

export function DirectoryBrowser({ onSelect, onCancel, initialPath }: DirectoryBrowserProps) {
    const [listing, setListing] = useState<DirListing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [pathInput, setPathInput] = useState(initialPath || '');
    const [showHidden, setShowHidden] = useState(false);

    const fetchDir = useCallback(async (dirPath?: string) => {
        setLoading(true);
        setError(null);
        try {
            const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
            const res = await fetch(`${getApiBaseUrl()}/api/list-directory${params}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({ error: res.statusText }));
                throw new Error(body.error || res.statusText);
            }
            const data: DirListing = await res.json();
            setListing(data);
            setPathInput(data.path);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchDir(initialPath);
    }, [fetchDir, initialPath]);

    const handleNavigate = (dirName: string) => {
        if (listing) {
            fetchDir(listing.path + '/' + dirName);
        }
    };

    const handleParent = () => {
        if (listing?.parent) {
            fetchDir(listing.parent);
        }
    };

    const handlePathSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (pathInput.trim()) {
            fetchDir(pathInput.trim());
        }
    };

    const handleSelect = () => {
        if (listing) {
            onSelect(listing.path);
        }
    };

    const visibleDirs = listing?.directories.filter(
        d => showHidden || !d.startsWith('.')
    ) || [];

    return (
        <div className="modal-overlay" onClick={onCancel} role="presentation">
            <div
                className="modal-content directory-browser"
                role="dialog"
                aria-modal="true"
                aria-label="Browse Folders"
                onClick={(e) => e.stopPropagation()}
            >
                <h2>Browse Folders</h2>

                <form onSubmit={handlePathSubmit} className="dir-path-bar">
                    <input
                        type="text"
                        value={pathInput}
                        onChange={(e) => setPathInput(e.target.value)}
                        className="dir-path-input"
                        spellCheck={false}
                    />
                    <button type="submit" className="btn-go" title="Go to path">Go</button>
                </form>

                <div className="dir-toolbar">
                    <button
                        type="button"
                        onClick={handleParent}
                        disabled={!listing?.parent}
                        className="btn-parent"
                        title="Go to parent directory"
                    >
                        ..
                    </button>
                    <label className="show-hidden-toggle">
                        <input
                            type="checkbox"
                            checked={showHidden}
                            onChange={(e) => setShowHidden(e.target.checked)}
                        />
                        Show hidden
                    </label>
                </div>

                <div className="dir-listing">
                    {loading && <div className="dir-status">Loading...</div>}
                    {error && <div className="dir-status dir-error">{error}</div>}
                    {!loading && !error && visibleDirs.length === 0 && (
                        <div className="dir-status">No subdirectories</div>
                    )}
                    {!loading && !error && visibleDirs.map((dir) => (
                        <button
                            key={dir}
                            className="dir-entry"
                            onClick={() => handleNavigate(dir)}
                            title={dir}
                        >
                            <span className="dir-icon">&#128193;</span>
                            <span className="dir-name">{dir}</span>
                        </button>
                    ))}
                </div>

                <div className="modal-actions">
                    <button type="button" onClick={onCancel} className="btn-secondary">
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSelect}
                        disabled={!listing}
                        className="btn-primary"
                    >
                        Select This Folder
                    </button>
                </div>
            </div>
        </div>
    );
}
