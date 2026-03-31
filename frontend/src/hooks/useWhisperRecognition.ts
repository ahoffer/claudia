import { useState, useEffect, useRef, useCallback } from 'react';

interface WhisperRecognitionOptions {
    continuous?: boolean;
    interimResults?: boolean;
    language?: string;
    whisperUrl?: string;
    onResult?: (transcript: string, isFinal: boolean) => void;
    onError?: (error: string) => void;
    onListeningChange?: (isListening: boolean) => void;
}

// How often to flush a chunk to the whisper server in continuous mode (ms).
const CHUNK_INTERVAL_MS = 5000;

function getBestMimeType(): string {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
    ];
    for (const t of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
            return t;
        }
    }
    return '';
}

export function useWhisperRecognition(options: WhisperRecognitionOptions = {}) {
    const {
        continuous = false,
        language = 'en',
        whisperUrl = '',
        onResult,
        onError,
        onListeningChange,
    } = options;

    const [isListening, setIsListening] = useState(false);
    const [isSupported, setIsSupported] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const shouldBeListeningRef = useRef(false);
    const chunksRef = useRef<Blob[]>([]);
    const chunkTimerRef = useRef<NodeJS.Timeout | null>(null);
    const accumulatedRef = useRef('');
    const mimeTypeRef = useRef('');

    // Keep callback refs stable so hook deps don't change on every render
    const onResultRef = useRef(onResult);
    const onErrorRef = useRef(onError);
    const onListeningChangeRef = useRef(onListeningChange);
    useEffect(() => {
        onResultRef.current = onResult;
        onErrorRef.current = onError;
        onListeningChangeRef.current = onListeningChange;
    }, [onResult, onError, onListeningChange]);

    useEffect(() => {
        setIsSupported(!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    }, []);

    // POST accumulated chunks to the whisper server and emit the result.
    const transcribeChunk = useCallback(async () => {
        if (chunksRef.current.length === 0) return;

        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' });
        chunksRef.current = [];

        // Skip very small blobs — they are usually just silence.
        if (blob.size < 500) return;

        setIsTranscribing(true);
        console.log('[WhisperRecognition] Sending chunk to whisper server, size:', blob.size);

        try {
            const form = new FormData();
            form.append('file', blob, 'audio.webm');
            if (language) form.append('language', language);

            const res = await fetch(`${whisperUrl}/inference`, { method: 'POST', body: form });
            if (!res.ok) throw new Error(`Whisper server responded ${res.status}`);

            const data = await res.json();
            const text = (data.text || '').trim();
            console.log('[WhisperRecognition] Transcript:', text);

            if (text) {
                if (continuous) {
                    const spacer = accumulatedRef.current ? ' ' : '';
                    accumulatedRef.current += spacer + text;
                    setTranscript(accumulatedRef.current);
                } else {
                    setTranscript(text);
                }
                setInterimTranscript('');
                onResultRef.current?.(text, true);
            }
        } catch (err: any) {
            console.error('[WhisperRecognition] Transcription failed:', err);
            onErrorRef.current?.(`Whisper error: ${err.message}`);
        } finally {
            setIsTranscribing(false);
        }
    }, [whisperUrl, language, continuous]);

    // Start a fresh MediaRecorder on the existing stream.
    const startRecorder = useCallback((stream: MediaStream) => {
        const mimeType = getBestMimeType();
        mimeTypeRef.current = mimeType;
        const opts: MediaRecorderOptions = mimeType ? { mimeType } : {};
        const recorder = new MediaRecorder(stream, opts);
        mediaRecorderRef.current = recorder;
        chunksRef.current = [];

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onerror = (e) => {
            console.error('[WhisperRecognition] MediaRecorder error:', e);
            onErrorRef.current?.('Microphone recording error');
        };
        recorder.start(100);
        console.log('[WhisperRecognition] MediaRecorder started, mimeType:', mimeType || 'default');
        return recorder;
    }, []);

    // Schedule the next chunk flush in continuous mode.
    const scheduleNextChunk = useCallback(() => {
        if (!continuous) return;
        chunkTimerRef.current = setTimeout(async () => {
            if (!shouldBeListeningRef.current) return;

            // Stop recorder to force a final ondataavailable, then restart.
            const recorder = mediaRecorderRef.current;
            if (recorder && recorder.state !== 'inactive') {
                recorder.stop();
                // Give the browser ~200 ms to fire ondataavailable.
                await new Promise(r => setTimeout(r, 200));
            }

            await transcribeChunk();

            // Restart recording if still active.
            if (shouldBeListeningRef.current && streamRef.current?.active) {
                startRecorder(streamRef.current);
                scheduleNextChunk();
            }
        }, CHUNK_INTERVAL_MS);
    }, [continuous, transcribeChunk, startRecorder]);

    const startListening = useCallback(async () => {
        if (shouldBeListeningRef.current) return;
        if (!whisperUrl) {
            onErrorRef.current?.('Whisper server URL not configured. Set it in Voice Settings.');
            return;
        }

        setTranscript('');
        setInterimTranscript('');
        accumulatedRef.current = '';
        shouldBeListeningRef.current = true;
        console.log('[WhisperRecognition] startListening, url:', whisperUrl);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            if (!shouldBeListeningRef.current) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }

            startRecorder(stream);
            setIsListening(true);
            onListeningChangeRef.current?.(true);

            if (continuous) scheduleNextChunk();
        } catch (err: any) {
            shouldBeListeningRef.current = false;
            if (err.name === 'NotAllowedError') {
                onErrorRef.current?.('Microphone access denied. Please allow microphone access.');
            } else if (err.name === 'NotFoundError') {
                onErrorRef.current?.('No microphone found.');
            } else {
                onErrorRef.current?.(`Failed to start recording: ${err.message}`);
            }
        }
    }, [whisperUrl, continuous, startRecorder, scheduleNextChunk]);

    const stopListening = useCallback(async () => {
        console.log('[WhisperRecognition] stopListening called');
        shouldBeListeningRef.current = false;

        if (chunkTimerRef.current) {
            clearTimeout(chunkTimerRef.current);
            chunkTimerRef.current = null;
        }

        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
            await new Promise(r => setTimeout(r, 200));
        }
        mediaRecorderRef.current = null;

        // For push-to-talk (non-continuous), transcribe the full recording now.
        if (!continuous) {
            await transcribeChunk();
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }

        setIsListening(false);
        setInterimTranscript('');
        onListeningChangeRef.current?.(false);
    }, [continuous, transcribeChunk]);

    const resetTranscript = useCallback(() => {
        setTranscript('');
        setInterimTranscript('');
        accumulatedRef.current = '';
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            shouldBeListeningRef.current = false;
            if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
            try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
            streamRef.current?.getTracks().forEach(t => t.stop());
        };
    }, []);

    return {
        isSupported,
        // Show as "listening" while transcribing too, so the UI mic stays active.
        isListening: isListening || isTranscribing,
        isTranscribing,
        transcript,
        interimTranscript,
        startListening,
        stopListening,
        resetTranscript,
    };
}
