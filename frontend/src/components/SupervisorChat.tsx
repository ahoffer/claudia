import { useState, useEffect, useRef, useMemo } from 'react';
import { Send, User, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { ChatMessage, Task } from '@claudia/shared';
import { VoiceInput } from './VoiceInput';
import { useTaskStore } from '../stores/taskStore';
import './SupervisorChat.css';

interface SupervisorChatProps {
    messages: ChatMessage[];
    isTyping: boolean;
    selectedTaskId: string | null;
    onSendMessage: (content: string, taskId?: string) => void;
    onClearHistory: () => void;
}

interface TaskThread {
    taskId: string;
    task: Task | undefined;
    messages: ChatMessage[];
    lastMessageTime: Date;
}

interface ThreadInputState {
    [taskId: string]: string;
}

interface ReadState {
    [taskId: string]: number; // Number of messages that have been "read" (seen while expanded)
}

export function SupervisorChat({
    messages,
    isTyping,
    selectedTaskId,
    onSendMessage,
}: SupervisorChatProps) {
    const [threadInputs, setThreadInputs] = useState<ThreadInputState>({});
    const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
    const [readCounts, setReadCounts] = useState<ReadState>({});
    const threadEndRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
    const { tasks } = useTaskStore();

    // Group messages by taskId into threads
    const threads = useMemo(() => {
        const threadMap = new Map<string, ChatMessage[]>();

        for (const msg of messages) {
            const taskId = msg.taskId || '__general__';
            const existing = threadMap.get(taskId) || [];
            existing.push(msg);
            threadMap.set(taskId, existing);
        }

        // Convert to array and sort by most recent message
        const threadArray: TaskThread[] = [];
        for (const [taskId, threadMessages] of threadMap) {
            if (taskId === '__general__') continue; // Skip general for now

            const lastMsg = threadMessages[threadMessages.length - 1];
            threadArray.push({
                taskId,
                task: tasks.get(taskId),
                messages: threadMessages,
                lastMessageTime: new Date(lastMsg.timestamp)
            });
        }

        // Sort by most recent first
        threadArray.sort((a, b) => b.lastMessageTime.getTime() - a.lastMessageTime.getTime());
        return threadArray;
    }, [messages, tasks]);

    // Mark messages as read when thread is expanded
    useEffect(() => {
        for (const thread of threads) {
            if (expandedThreads.has(thread.taskId)) {
                // Mark all messages in this thread as read
                setReadCounts(prev => ({
                    ...prev,
                    [thread.taskId]: thread.messages.length
                }));
            }
        }
    }, [expandedThreads, threads]);

    // When new messages arrive in an expanded thread, scroll to bottom
    useEffect(() => {
        if (messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            if (lastMessage.taskId && expandedThreads.has(lastMessage.taskId)) {
                // Scroll to bottom of that thread
                setTimeout(() => {
                    const endRef = threadEndRefs.current.get(lastMessage.taskId!);
                    endRef?.scrollIntoView({ behavior: 'smooth' });
                }, 100);
            }
        }
    }, [messages, expandedThreads]);

    const handleSubmit = (taskId: string, e: React.FormEvent) => {
        e.preventDefault();
        const input = threadInputs[taskId] || '';
        if (!input.trim() || isTyping) return;

        onSendMessage(input.trim(), taskId);
        setThreadInputs(prev => ({ ...prev, [taskId]: '' }));
    };

    const handleInputChange = (taskId: string, value: string) => {
        setThreadInputs(prev => ({ ...prev, [taskId]: value }));
    };

    const handleVoiceTranscript = (taskId: string, transcript: string, isFinal: boolean) => {
        if (isFinal && transcript.trim()) {
            onSendMessage(transcript.trim(), taskId);
        }
    };

    const toggleThread = (taskId: string) => {
        setExpandedThreads(prev => {
            const newSet = new Set(prev);
            if (newSet.has(taskId)) {
                newSet.delete(taskId);
            } else {
                newSet.add(taskId);
            }
            return newSet;
        });
    };

    const formatTime = (timestamp: string) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const formatRelativeTime = (date: Date) => {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);

        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        return date.toLocaleDateString();
    };

    const getTaskStateColor = (state?: string) => {
        switch (state) {
            case 'idle': return 'var(--accent-green)';
            case 'busy': return 'var(--accent-yellow)';
            case 'waiting_input': return 'var(--accent-secondary)';
            case 'exited': return 'var(--text-muted)';
            default: return 'var(--text-muted)';
        }
    };

    const truncatePrompt = (prompt: string, maxLength: number = 80) => {
        if (prompt.length <= maxLength) return prompt;
        return prompt.substring(0, maxLength) + '...';
    };

    const setThreadEndRef = (taskId: string, el: HTMLDivElement | null) => {
        threadEndRefs.current.set(taskId, el);
    };

    return (
        <div className="supervisor-chat">
            <div className="supervisor-chat-threads">
                {threads.length === 0 && !isTyping ? (
                    <div className="supervisor-chat-empty">
                        <Sparkles size={48} />
                        <p>Task Threads</p>
                        <span className="hint">
                            Conversations will appear here when tasks are created
                        </span>
                    </div>
                ) : (
                    threads.map((thread) => {
                        const isExpanded = expandedThreads.has(thread.taskId);
                        const isSelected = selectedTaskId === thread.taskId;
                        const inputValue = threadInputs[thread.taskId] || '';
                        const readCount = readCounts[thread.taskId] || 0;
                        const unreadCount = thread.messages.length - readCount;

                        return (
                            <div
                                key={thread.taskId}
                                className={`task-thread ${isExpanded ? 'expanded' : ''} ${isSelected ? 'selected' : ''} ${unreadCount > 0 ? 'has-unread' : ''}`}
                            >
                                <button
                                    className="thread-header"
                                    onClick={() => toggleThread(thread.taskId)}
                                >
                                    <span className="thread-expand-icon">
                                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    </span>
                                    <span
                                        className="thread-status-dot"
                                        style={{ backgroundColor: getTaskStateColor(thread.task?.state) }}
                                    />
                                    <span className="thread-title">
                                        {thread.task
                                            ? truncatePrompt(thread.task.prompt)
                                            : `Task ${thread.taskId.substring(0, 8)}...`}
                                    </span>
                                    <span className="thread-time">
                                        {formatRelativeTime(thread.lastMessageTime)}
                                    </span>
                                    {unreadCount > 0 ? (
                                        <span className="thread-unread-count">
                                            {unreadCount}
                                        </span>
                                    ) : (
                                        <span className="thread-message-count">
                                            {thread.messages.length}
                                        </span>
                                    )}
                                </button>

                                {isExpanded && (
                                    <div className="thread-body">
                                        <div className="thread-messages">
                                            {thread.messages.map((message) => (
                                                <div
                                                    key={message.id}
                                                    className={`supervisor-chat-message ${message.role}`}
                                                >
                                                    <div className="message-avatar">
                                                        {message.role === 'user' ? (
                                                            <User size={14} />
                                                        ) : (
                                                            <Sparkles size={14} />
                                                        )}
                                                    </div>
                                                    <div className="message-bubble">
                                                        <div className="message-content">
                                                            {message.content}
                                                        </div>
                                                        <div className="message-time">
                                                            {formatTime(message.timestamp)}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}

                                            {isTyping && isSelected && (
                                                <div className="supervisor-chat-typing">
                                                    <div className="message-avatar">
                                                        <Sparkles size={14} />
                                                    </div>
                                                    <div className="typing-indicator">
                                                        <span></span>
                                                        <span></span>
                                                        <span></span>
                                                    </div>
                                                </div>
                                            )}

                                            <div ref={(el) => setThreadEndRef(thread.taskId, el)} />
                                        </div>

                                        <form
                                            className="thread-input"
                                            onSubmit={(e) => handleSubmit(thread.taskId, e)}
                                        >
                                            <input
                                                type="text"
                                                value={inputValue}
                                                onChange={(e) => handleInputChange(thread.taskId, e.target.value)}
                                                placeholder="Ask about this task..."
                                                disabled={isTyping}
                                            />
                                            <VoiceInput
                                                onTranscript={(transcript, isFinal) =>
                                                    handleVoiceTranscript(thread.taskId, transcript, isFinal)
                                                }
                                                disabled={isTyping}
                                            />
                                            <button
                                                type="submit"
                                                className="thread-send-button"
                                                disabled={!inputValue.trim() || isTyping}
                                                title="Send message"
                                            >
                                                <Send size={16} />
                                            </button>
                                        </form>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
