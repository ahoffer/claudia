import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    getWorkspaceSessions,
} from '../conversation-parser.js';

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

        const sessionContent = [
            JSON.stringify({ type: 'summary', summary: 'Test conversation' }),
            JSON.stringify({ type: 'user', uuid: '1', message: { content: 'hello' } }),
        ].join('\n');

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

        const sessionContent = [
            JSON.stringify({ type: 'user', uuid: '1', message: { content: 'hello' } }),
        ].join('\n');

        writeFileSync(join(projectsDir, 'no-summary-session.jsonl'), sessionContent);

        const result = await getWorkspaceSessions(testWorkspace);

        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('no-summary-session');
        expect(result[0].summary).toBeUndefined();
    });
});
