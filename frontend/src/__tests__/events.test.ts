import { describe, it, expect } from 'vitest';
import {
    TERMINAL_SCROLL_TO_BOTTOM,
    TASK_INPUT_FOCUS,
    NOTIFICATION_TASK_CLICK,
} from '../constants/events';

describe('event constants', () => {
    it('exports the expected event names', () => {
        expect(TERMINAL_SCROLL_TO_BOTTOM).toBe('terminal:scrollToBottom');
        expect(TASK_INPUT_FOCUS).toBe('taskInput:focus');
        expect(NOTIFICATION_TASK_CLICK).toBe('notification:taskClick');
    });

    it('all values are unique', () => {
        const values = [TERMINAL_SCROLL_TO_BOTTOM, TASK_INPUT_FOCUS, NOTIFICATION_TASK_CLICK];
        expect(new Set(values).size).toBe(values.length);
    });
});
