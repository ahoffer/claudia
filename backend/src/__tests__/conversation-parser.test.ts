import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    getWorkspaceSessions,
    getConversationHistory,
} from '../conversation-parser.js';

// Helper to build JSONL content from an array of objects
function jsonl(entries: object[]): string {
    return entries.map(e => JSON.stringify(e)).join('\n');
}

describe('getWorkspaceSessions', () => {
    const testHome = join(tmpdir(), 'claudia-sessions-test-' + Date.now());
    const testWorkspace = '/test/workspace';
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it('should return empty array for non-existent projects dir', async () => {
        const result = await getWorkspaceSessions(testWorkspace);
        expect(result).toEqual([]);
    });

    it('should return session info with summaries', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const sessionContent = jsonl([
            { type: 'summary', summary: 'Test conversation' },
            { type: 'user', uuid: '1', message: { content: 'hello' } },
        ]);

        writeFileSync(join(projectsDir, 'test-session.jsonl'), sessionContent);

        const result = await getWorkspaceSessions(testWorkspace);

        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('test-session');
        expect(result[0].summary).toBe('Test conversation');
        expect(result[0].lastModified).toBeInstanceOf(Date);
    });

    it('should handle sessions without summaries', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const sessionContent = jsonl([
            { type: 'user', uuid: '1', message: { content: 'hello' } },
        ]);

        writeFileSync(join(projectsDir, 'no-summary-session.jsonl'), sessionContent);

        const result = await getWorkspaceSessions(testWorkspace);

        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('no-summary-session');
        expect(result[0].summary).toBeUndefined();
    });

    it('should sort sessions by lastModified descending', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        writeFileSync(join(projectsDir, 'old.jsonl'), jsonl([{ type: 'user', uuid: '1', message: { content: 'old' } }]));
        // Small delay to ensure different mtime
        const now = new Date();
        const later = new Date(now.getTime() + 2000);
        writeFileSync(join(projectsDir, 'new.jsonl'), jsonl([{ type: 'user', uuid: '2', message: { content: 'new' } }]));
        // Force mtime difference
        const { utimesSync } = await import('fs');
        utimesSync(join(projectsDir, 'old.jsonl'), new Date(now.getTime() - 5000), new Date(now.getTime() - 5000));

        const result = await getWorkspaceSessions(testWorkspace);
        expect(result).toHaveLength(2);
        expect(result[0].sessionId).toBe('new');
        expect(result[1].sessionId).toBe('old');
    });

    it('should ignore non-jsonl files', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        writeFileSync(join(projectsDir, 'session.jsonl'), jsonl([{ type: 'user', uuid: '1', message: { content: 'hi' } }]));
        writeFileSync(join(projectsDir, 'notes.txt'), 'not a session');
        writeFileSync(join(projectsDir, 'config.json'), '{}');

        const result = await getWorkspaceSessions(testWorkspace);
        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('session');
    });
});

describe('getConversationHistory', () => {
    const testHome = join(tmpdir(), 'claudia-conv-test-' + Date.now());
    const testWorkspace = '/test/workspace';
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it('should return null for non-existent session', async () => {
        const result = await getConversationHistory(testWorkspace, 'nonexistent', 'claude-code');
        expect(result).toBeNull();
    });

    it('should parse user and assistant messages', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = jsonl([
            { type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'hi there' } },
        ]);
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        expect(result).not.toBeNull();
        expect(result!.sessionId).toBe('sess-1');
        expect(result!.messages).toHaveLength(2);
        expect(result!.messages[0]).toMatchObject({ role: 'user', content: 'hello', uuid: 'u1' });
        expect(result!.messages[1]).toMatchObject({ role: 'assistant', content: 'hi there', uuid: 'a1' });
    });

    it('should extract text from array content blocks', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = jsonl([
            {
                type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'First part. ' },
                        { type: 'text', text: 'Second part.' },
                    ]
                }
            },
        ]);
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        expect(result!.messages[0].content).toBe('First part. Second part.');
    });

    it('should extract thinking blocks', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = jsonl([
            {
                type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Let me consider...' },
                        { type: 'text', text: 'Here is my answer.' },
                    ]
                }
            },
        ]);
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        expect(result!.messages[0].content).toBe('Here is my answer.');
        expect(result!.messages[0].thinking).toBe('Let me consider...');
    });

    it('should skip pure thinking blocks with no text', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = jsonl([
            {
                type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'Just thinking, no output...' },
                    ]
                }
            },
            {
                type: 'assistant', uuid: 'a2', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:01Z',
                message: {
                    role: 'assistant',
                    content: 'Real response'
                }
            },
        ]);
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        // Only the second message (with text) should appear
        expect(result!.messages).toHaveLength(1);
        expect(result!.messages[0].content).toBe('Real response');
    });

    it('should deduplicate messages by uuid', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = jsonl([
            { type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
            { type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'hi' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'hi' } },
        ]);
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        expect(result!.messages).toHaveLength(2); // deduplicated
    });

    it('should capture summary from summary entries', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = jsonl([
            { type: 'summary', summary: 'Discussed project architecture' },
            { type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
        ]);
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        expect(result!.summary).toBe('Discussed project architecture');
    });

    it('should handle malformed JSONL lines gracefully', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        const content = [
            JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'before' } }),
            'this is not valid json',
            '{broken json',
            '',
            JSON.stringify({ type: 'user', uuid: 'u2', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'after' } }),
        ].join('\n');
        writeFileSync(join(projectsDir, 'sess-1.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'sess-1', 'claude-code');
        // Should skip bad lines and still parse the good ones
        expect(result!.messages).toHaveLength(2);
        expect(result!.messages[0].content).toBe('before');
        expect(result!.messages[1].content).toBe('after');
    });

    it('should use filename as session id when none in content', async () => {
        const projectsDir = join(testHome, '.claude', 'projects', '-test-workspace');
        mkdirSync(projectsDir, { recursive: true });

        // No sessionId in any entry
        const content = jsonl([
            { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
        ]);
        writeFileSync(join(projectsDir, 'my-session.jsonl'), content);

        const result = await getConversationHistory(testWorkspace, 'my-session', 'claude-code');
        expect(result!.sessionId).toBe('my-session');
    });

    it('should auto-detect opencode sessions by ses_ prefix', async () => {
        // OpenCode sessions start with ses_ — since we don't have the OpenCode storage set up,
        // this should return null but not crash
        const result = await getConversationHistory(testWorkspace, 'ses_abc123', undefined);
        expect(result).toBeNull();
    });
});
