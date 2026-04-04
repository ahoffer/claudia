import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateCronExpression, describeCronExpression, CronScheduler } from '../cron-scheduler.js';

// ==================== Pure functions ====================

describe('validateCronExpression', () => {
    it('should accept valid expressions', () => {
        expect(validateCronExpression('* * * * *')).toBeNull();
        expect(validateCronExpression('0 0 * * *')).toBeNull();
        expect(validateCronExpression('*/5 * * * *')).toBeNull();
        expect(validateCronExpression('0 9 * * 1-5')).toBeNull();
        expect(validateCronExpression('0,30 * * * *')).toBeNull();
        expect(validateCronExpression('0 0 1 1 *')).toBeNull();
        expect(validateCronExpression('0 */2 * * *')).toBeNull();
        expect(validateCronExpression('0 9-17 * * *')).toBeNull();
        expect(validateCronExpression('0 0 * * 7')).toBeNull(); // Sunday as 7
    });

    it('should reject invalid expressions', () => {
        expect(validateCronExpression('')).not.toBeNull();
        expect(validateCronExpression('* *')).not.toBeNull();
        expect(validateCronExpression('* * * * * *')).not.toBeNull(); // 6 fields
        expect(validateCronExpression('abc * * * *')).not.toBeNull();
        expect(validateCronExpression('*/0 * * * *')).not.toBeNull(); // step of 0
    });
});

describe('describeCronExpression', () => {
    it('should describe every-N-minutes', () => {
        expect(describeCronExpression('*/5 * * * *')).toBe('Every 5 minutes');
        expect(describeCronExpression('*/15 * * * *')).toBe('Every 15 minutes');
    });

    it('should describe hourly', () => {
        expect(describeCronExpression('0 * * * *')).toBe('Every hour on the hour');
    });

    it('should describe daily', () => {
        expect(describeCronExpression('0 9 * * *')).toBe('Daily at 9:00');
        expect(describeCronExpression('30 14 * * *')).toBe('Daily at 14:30');
    });

    it('should describe weekday schedules', () => {
        expect(describeCronExpression('0 9 * * 1-5')).toBe('weekdays at 9:00');
    });

    it('should return raw expression for complex patterns', () => {
        expect(describeCronExpression('0 0 1 1 *')).toBe('0 0 1 1 *');
    });

    it('should handle invalid input gracefully', () => {
        expect(describeCronExpression('not a cron')).toBe('not a cron');
    });
});

// ==================== CronScheduler class ====================

describe('CronScheduler', () => {
    let scheduler: CronScheduler;
    let fireCallback: ReturnType<typeof vi.fn>;
    let stateChecker: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fireCallback = vi.fn();
        stateChecker = vi.fn().mockReturnValue('idle');
        // Mock filesystem so load() is a no-op
        vi.mock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: vi.fn((p: string) => {
                    if (typeof p === 'string' && p.includes('scheduled-tasks.json')) return false;
                    return actual.existsSync(p);
                }),
                writeFileSync: vi.fn(),
                readFileSync: actual.readFileSync,
                renameSync: vi.fn(),
            };
        });
        scheduler = new CronScheduler(fireCallback, stateChecker);
    });

    afterEach(() => {
        scheduler.stop();
        vi.restoreAllMocks();
    });

    describe('create', () => {
        it('should create a scheduled task with valid cron', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'check status', true);
            expect(task.id).toBeTruthy();
            expect(task.taskId).toBe('task-1');
            expect(task.workspaceId).toBe('/ws');
            expect(task.cronExpression).toBe('*/5 * * * *');
            expect(task.prompt).toBe('check status');
            expect(task.isRecurring).toBe(true);
            expect(task.isPaused).toBe(false);
            expect(task.fireCount).toBe(0);
            expect(task.nextFireAt).toBeTruthy();
        });

        it('should reject invalid cron expression', () => {
            expect(() => scheduler.create('task-1', '/ws', 'bad', 'prompt')).toThrow('Invalid cron expression');
        });

        it('should enforce max 50 schedules per task', () => {
            for (let i = 0; i < 50; i++) {
                scheduler.create('task-1', '/ws', '*/5 * * * *', `prompt ${i}`);
            }
            expect(() => scheduler.create('task-1', '/ws', '*/5 * * * *', 'one too many')).toThrow('Maximum 50');
        });

        it('should allow 50 per task across different tasks', () => {
            for (let i = 0; i < 50; i++) {
                scheduler.create('task-1', '/ws', '*/5 * * * *', `prompt ${i}`);
            }
            // Different task should work fine
            expect(() => scheduler.create('task-2', '/ws', '*/5 * * * *', 'ok')).not.toThrow();
        });

        it('should set expiry to 3 days for recurring tasks', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'prompt', true);
            const created = new Date(task.createdAt).getTime();
            const expires = new Date(task.expiresAt).getTime();
            const threeDays = 3 * 24 * 60 * 60 * 1000;
            expect(expires - created).toBe(threeDays);
        });

        it('should set expiry to 1 day for one-shot tasks', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'prompt', false);
            const created = new Date(task.createdAt).getTime();
            const expires = new Date(task.expiresAt).getTime();
            const oneDay = 24 * 60 * 60 * 1000;
            expect(expires - created).toBe(oneDay);
        });
    });

    describe('delete', () => {
        it('should delete an existing scheduled task', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'prompt');
            expect(scheduler.delete(task.id)).toBe(true);
            expect(scheduler.get(task.id)).toBeUndefined();
        });

        it('should return false for non-existent id', () => {
            expect(scheduler.delete('nonexistent')).toBe(false);
        });
    });

    describe('update', () => {
        it('should update cron expression and recalculate next fire', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'prompt');
            const original = task.nextFireAt;
            const updated = scheduler.update(task.id, { cronExpression: '0 * * * *' });
            expect(updated).not.toBeNull();
            expect(updated!.cronExpression).toBe('0 * * * *');
        });

        it('should update prompt', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'old prompt');
            scheduler.update(task.id, { prompt: 'new prompt' });
            expect(scheduler.get(task.id)!.prompt).toBe('new prompt');
        });

        it('should reject invalid cron on update', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'prompt');
            expect(() => scheduler.update(task.id, { cronExpression: 'bad' })).toThrow('Invalid cron');
        });

        it('should return null for non-existent id', () => {
            expect(scheduler.update('nonexistent', { prompt: 'x' })).toBeNull();
        });

        it('should pause and resume', () => {
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'prompt');
            scheduler.update(task.id, { isPaused: true });
            expect(scheduler.get(task.id)!.isPaused).toBe(true);

            scheduler.update(task.id, { isPaused: false });
            expect(scheduler.get(task.id)!.isPaused).toBe(false);
            expect(scheduler.get(task.id)!.nextFireAt).toBeTruthy();
        });
    });

    describe('list and getForTask', () => {
        it('should list all scheduled tasks', () => {
            scheduler.create('task-1', '/ws', '*/5 * * * *', 'a');
            scheduler.create('task-2', '/ws', '*/10 * * * *', 'b');
            expect(scheduler.list()).toHaveLength(2);
        });

        it('should filter by task id', () => {
            scheduler.create('task-1', '/ws', '*/5 * * * *', 'a');
            scheduler.create('task-2', '/ws', '*/10 * * * *', 'b');
            scheduler.create('task-1', '/ws', '0 * * * *', 'c');
            expect(scheduler.getForTask('task-1')).toHaveLength(2);
            expect(scheduler.getForTask('task-2')).toHaveLength(1);
        });
    });

    describe('removeAllForTask', () => {
        it('should remove all schedules for a task', () => {
            scheduler.create('task-1', '/ws', '*/5 * * * *', 'a');
            scheduler.create('task-1', '/ws', '0 * * * *', 'b');
            scheduler.create('task-2', '/ws', '*/10 * * * *', 'c');

            const removed = scheduler.removeAllForTask('task-1');
            expect(removed).toBe(2);
            expect(scheduler.list()).toHaveLength(1);
            expect(scheduler.list()[0].taskId).toBe('task-2');
        });

        it('should return 0 for task with no schedules', () => {
            expect(scheduler.removeAllForTask('nonexistent')).toBe(0);
        });
    });

    describe('fireNow', () => {
        it('should fire immediately when task is idle', () => {
            stateChecker.mockReturnValue('idle');
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'do it');
            expect(scheduler.fireNow(task.id)).toBe(true);
            expect(fireCallback).toHaveBeenCalledWith('task-1', 'do it', task.id);
            expect(scheduler.get(task.id)!.fireCount).toBe(1);
        });

        it('should queue when task is busy', () => {
            stateChecker.mockReturnValue('busy');
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'do it');
            expect(scheduler.fireNow(task.id)).toBe(true);
            expect(fireCallback).not.toHaveBeenCalled();
        });

        it('should delete one-shot tasks after firing', () => {
            stateChecker.mockReturnValue('idle');
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'once', false);
            scheduler.fireNow(task.id);
            expect(scheduler.get(task.id)).toBeUndefined();
        });

        it('should return false for non-existent id', () => {
            expect(scheduler.fireNow('nonexistent')).toBe(false);
        });
    });

    describe('onTaskIdle', () => {
        it('should fire pending prompts when task becomes idle', () => {
            stateChecker.mockReturnValue('busy');
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'queued prompt');
            scheduler.fireNow(task.id); // queues because busy
            expect(fireCallback).not.toHaveBeenCalled();

            // Task becomes idle
            scheduler.onTaskIdle('task-1');
            expect(fireCallback).toHaveBeenCalledWith('task-1', 'queued prompt', task.id);
        });

        it('should not fire pending prompts for paused tasks', () => {
            stateChecker.mockReturnValue('busy');
            const task = scheduler.create('task-1', '/ws', '*/5 * * * *', 'queued');
            scheduler.fireNow(task.id); // queues
            scheduler.update(task.id, { isPaused: true });

            scheduler.onTaskIdle('task-1');
            expect(fireCallback).not.toHaveBeenCalled();
        });
    });

    describe('size', () => {
        it('should track count', () => {
            expect(scheduler.size).toBe(0);
            const t = scheduler.create('task-1', '/ws', '*/5 * * * *', 'a');
            expect(scheduler.size).toBe(1);
            scheduler.delete(t.id);
            expect(scheduler.size).toBe(0);
        });
    });
});
