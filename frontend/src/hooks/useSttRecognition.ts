import { useEffect } from 'react';
import { useDeepgramRecognition } from './useDeepgramRecognition';
import { useVoiceRecognition } from './useVoiceRecognition';
import { useWhisperRecognition } from './useWhisperRecognition';
import { useTaskStore } from '../stores/taskStore';

interface SttOptions {
    continuous?: boolean;
    interimResults?: boolean;
    language?: string;
    onResult?: (transcript: string, isFinal: boolean) => void;
    onError?: (error: string) => void;
    onListeningChange?: (isListening: boolean) => void;
}

/**
 * Unified speech-to-text hook. Dispatches to the provider selected in the
 * task store (deepgram | browser | whisper). All three underlying hooks are
 * always instantiated (React rules prohibit conditional hooks), but only the
 * active provider's callbacks are wired through, and inactive providers are
 * stopped whenever the selection changes.
 */
export function useSttRecognition(options: SttOptions = {}) {
    const sttProvider = useTaskStore(s => s.sttProvider);
    const deepgramApiKey = useTaskStore(s => s.deepgramApiKey);
    const whisperUrl = useTaskStore(s => s.whisperUrl);

    const isDeepgram = sttProvider === 'deepgram';
    const isBrowser = sttProvider === 'browser';
    const isWhisper = sttProvider === 'whisper';

    const deepgram = useDeepgramRecognition({
        ...options,
        deepgramApiKey: isDeepgram ? deepgramApiKey : '',
        onResult: isDeepgram ? options.onResult : undefined,
        onError: isDeepgram ? options.onError : undefined,
        onListeningChange: isDeepgram ? options.onListeningChange : undefined,
    });

    const browser = useVoiceRecognition({
        ...options,
        onResult: isBrowser ? options.onResult : undefined,
        onError: isBrowser ? options.onError : undefined,
        onListeningChange: isBrowser ? options.onListeningChange : undefined,
    });

    const whisper = useWhisperRecognition({
        ...options,
        whisperUrl: isWhisper ? whisperUrl : '',
        onResult: isWhisper ? options.onResult : undefined,
        onError: isWhisper ? options.onError : undefined,
        onListeningChange: isWhisper ? options.onListeningChange : undefined,
    });

    // When the provider changes, stop any in-progress recognition on the
    // providers that are no longer active.
    const deepgramStop = deepgram.stopListening;
    const browserStop = browser.stopListening;
    const whisperStop = whisper.stopListening;

    useEffect(() => {
        if (!isDeepgram) deepgramStop();
        if (!isBrowser) browserStop();
        if (!isWhisper) whisperStop();
        // Only run when the provider changes; stopping is idempotent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sttProvider]);

    if (isDeepgram) return deepgram;
    if (isBrowser) return browser;
    return whisper;
}
