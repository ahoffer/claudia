import { useEffect, useCallback, useState, MutableRefObject } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { PathInputModal } from './PathInputModal';
import { DirectoryBrowser } from './DirectoryBrowser';
import { RecentWorkspace } from '@claudia/shared';

interface ProjectPickerProps {
    onSelect: (path: string) => void;
    wsRef: MutableRefObject<WebSocket | null>;
    requestRecentWorkspaces: () => void;
    clearRecentWorkspace: (workspaceId?: string) => void;
}

export function ProjectPicker({ onSelect, wsRef, requestRecentWorkspaces, clearRecentWorkspace }: ProjectPickerProps) {
    const { showProjectPicker, setShowProjectPicker } = useTaskStore();
    const [showPathInput, setShowPathInput] = useState(false);
    const [showBrowser, setShowBrowser] = useState(false);
    const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);

    // Listen for recent workspaces on the shared WebSocket
    useEffect(() => {
        if (!showPathInput) return;

        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('[ProjectPicker] WebSocket not ready, cannot fetch recent workspaces');
            return;
        }

        const handler = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'workspace:recent:list') {
                    setRecentWorkspaces(message.payload.recentWorkspaces || []);
                }
            } catch (err) {
                console.error('[ProjectPicker] Error parsing message:', err);
            }
        };

        ws.addEventListener('message', handler);
        requestRecentWorkspaces();

        return () => {
            ws.removeEventListener('message', handler);
        };
    }, [showPathInput, wsRef, requestRecentWorkspaces]);

    const handleFolderSelect = useCallback(async () => {
        setShowPathInput(true);
        setShowProjectPicker(false);
    }, [setShowProjectPicker]);

    useEffect(() => {
        if (showProjectPicker) {
            handleFolderSelect();
        }
    }, [showProjectPicker, handleFolderSelect]);

    const handlePathSubmit = (path: string) => {
        onSelect(path);
        setShowPathInput(false);
    };

    const handlePathCancel = () => {
        setShowPathInput(false);
    };

    const handleBrowse = useCallback(() => {
        setShowPathInput(false);
        setShowBrowser(true);
    }, []);

    const handleBrowserSelect = (path: string) => {
        setShowBrowser(false);
        onSelect(path);
    };

    const handleBrowserCancel = () => {
        setShowBrowser(false);
        setShowPathInput(true);
    };

    const handleRemoveRecent = (workspaceId: string) => {
        setRecentWorkspaces(prev => prev.filter(w => w.id !== workspaceId));
        clearRecentWorkspace(workspaceId);
    };

    return (
        <>
            {showPathInput && (
                <PathInputModal
                    onSubmit={handlePathSubmit}
                    onCancel={handlePathCancel}
                    recentWorkspaces={recentWorkspaces}
                    onRemoveRecent={handleRemoveRecent}
                    onBrowse={handleBrowse}
                    isBrowsing={false}
                />
            )}
            {showBrowser && (
                <DirectoryBrowser
                    onSelect={handleBrowserSelect}
                    onCancel={handleBrowserCancel}
                />
            )}
        </>
    );
}
