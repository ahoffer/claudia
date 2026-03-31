import { useMemo, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { DeepgramApiKeyModal } from './DeepgramApiKeyModal';
import { WhisperSetupModal } from './WhisperSetupModal';
import './GlobalVoiceToggle.css';

/**
 * GlobalVoiceToggle - Header button for enabling/disabling always-listening voice mode.
 * Shows:
 * - Gray mic when OFF
 * - Red pulsing mic when ON
 * - Tooltip showing which input is focused
 */
export function GlobalVoiceToggle() {
    const {
        globalVoiceEnabled,
        focusedInputId,
        deepgramApiKey,
        sttProvider,
        whisperUrl,
        setGlobalVoiceEnabled,
        clearVoiceTranscript
    } = useTaskStore();

    const [showSetupModal, setShowSetupModal] = useState(false);

    // Check if microphone API is available
    const isMicAvailable = useMemo(() => {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }, []);

    // Whether the selected provider has everything it needs to run.
    const isReady = useMemo(() => {
        if (!isMicAvailable) return false;
        if (sttProvider === 'deepgram') return !!deepgramApiKey;
        if (sttProvider === 'whisper') return !!whisperUrl;
        return true; // browser native — always ready if mic is available
    }, [sttProvider, deepgramApiKey, whisperUrl, isMicAvailable]);

    const setupTitle = useMemo(() => {
        if (sttProvider === 'deepgram') return 'Click to set up Deepgram API key';
        if (sttProvider === 'whisper') return 'Click to set up Whisper server URL';
        return 'Voice input not available';
    }, [sttProvider]);

    // Determine the target description for the tooltip
    const targetDescription = useMemo(() => {
        if (!focusedInputId) return 'None';
        if (focusedInputId.startsWith('task-')) return 'Task Input';
        if (focusedInputId.startsWith('new-task-')) return 'New Task';
        if (focusedInputId.startsWith('chat-')) return 'Chat';
        return 'Input';
    }, [focusedInputId]);

    const handleToggle = () => {
        if (!isReady) {
            setShowSetupModal(true);
            return;
        }
        if (globalVoiceEnabled) {
            clearVoiceTranscript();
        }
        setGlobalVoiceEnabled(!globalVoiceEnabled);
    };

    const handleModalClose = () => {
        setShowSetupModal(false);
        // Auto-enable after successful setup if mic is available.
        const state = useTaskStore.getState();
        const nowReady = state.sttProvider === 'browser' ||
            (state.sttProvider === 'deepgram' && !!state.deepgramApiKey) ||
            (state.sttProvider === 'whisper' && !!state.whisperUrl);
        if (isMicAvailable && nowReady) {
            setGlobalVoiceEnabled(true);
        }
    };

    // If mic is not available, show disabled button
    if (!isMicAvailable) {
        return (
            <button
                className="global-voice-toggle unsupported"
                disabled
                title="Voice input not supported in this browser"
            >
                <MicOff size={18} />
                <span>Voice</span>
            </button>
        );
    }

    // Provider needs configuration — show setup prompt
    if (!isReady) {
        return (
            <>
                <button
                    className="global-voice-toggle needs-setup"
                    onClick={handleToggle}
                    title={setupTitle}
                >
                    <MicOff size={18} />
                    <span>Voice</span>
                </button>
                {sttProvider === 'deepgram' && (
                    <DeepgramApiKeyModal
                        isOpen={showSetupModal}
                        onClose={handleModalClose}
                    />
                )}
                {sttProvider === 'whisper' && (
                    <WhisperSetupModal
                        isOpen={showSetupModal}
                        onClose={handleModalClose}
                    />
                )}
            </>
        );
    }

    return (
        <button
            className={`global-voice-toggle ${globalVoiceEnabled ? 'active' : ''}`}
            onClick={handleToggle}
            title={globalVoiceEnabled ? `Voice Mode ON - Speaking to: ${targetDescription}` : 'Enable Voice Mode'}
        >
            {globalVoiceEnabled ? (
                <Mic size={18} className="mic-active" />
            ) : (
                <Mic size={18} />
            )}
            <span>Voice</span>
            {globalVoiceEnabled && (
                <span className="voice-target-indicator">
                    {targetDescription}
                </span>
            )}
        </button>
    );
}
