import { useState } from 'react';
import { X, Server, ExternalLink } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
// Reuse the Deepgram modal CSS — it defines all the shared modal primitives.
import './DeepgramApiKeyModal.css';

interface WhisperSetupModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function WhisperSetupModal({ isOpen, onClose }: WhisperSetupModalProps) {
    const { whisperUrl, setWhisperUrl } = useTaskStore();
    const [localUrl, setLocalUrl] = useState(whisperUrl || 'http://localhost:8080');

    if (!isOpen) return null;

    const handleSave = () => {
        setWhisperUrl(localUrl.trim());
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleSave();
        else if (e.key === 'Escape') onClose();
    };

    return (
        <div className="modal-overlay" onClick={onClose} role="presentation">
            <div
                className="modal-content deepgram-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Whisper server setup"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h2 className="modal-title">
                        <Server size={20} />
                        Whisper Server URL Required
                    </h2>
                    <button className="modal-close" onClick={onClose}>
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body">
                    <p className="deepgram-info">
                        Voice input is set to use a local{' '}
                        <a
                            href="https://github.com/ggerganov/whisper.cpp"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="deepgram-link"
                        >
                            whisper.cpp
                            <ExternalLink size={14} />
                        </a>{' '}
                        server. Start it and enter its URL below.
                    </p>

                    <div className="deepgram-steps">
                        <ol>
                            <li>
                                Clone and build{' '}
                                <a
                                    href="https://github.com/ggerganov/whisper.cpp"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="deepgram-link"
                                >
                                    whisper.cpp
                                    <ExternalLink size={14} />
                                </a>
                            </li>
                            <li>Download a model: <code>bash models/download-ggml-model.sh base.en</code></li>
                            <li>Start the server: <code>./server -m models/ggml-base.en.bin</code></li>
                            <li>Enter the server URL below (default: <code>http://localhost:8080</code>)</li>
                        </ol>
                    </div>

                    <div className="deepgram-input-container">
                        <label htmlFor="whisper-url" className="deepgram-label">
                            Server URL
                        </label>
                        <input
                            id="whisper-url"
                            type="url"
                            value={localUrl}
                            onChange={(e) => setLocalUrl(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="http://localhost:8080"
                            className="deepgram-input"
                            autoFocus
                        />
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="modal-button secondary" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className="modal-button primary"
                        onClick={handleSave}
                        disabled={!localUrl.trim()}
                    >
                        Save & Enable Voice
                    </button>
                </div>
            </div>
        </div>
    );
}
