import { describe, it, expect } from 'vitest';
import { ErrorBoundary } from '../components/ErrorBoundary';

describe('ErrorBoundary', () => {
    it('exports a class component with getDerivedStateFromError', () => {
        expect(ErrorBoundary).toBeDefined();
        expect(typeof ErrorBoundary.getDerivedStateFromError).toBe('function');
    });

    it('getDerivedStateFromError returns error state', () => {
        const error = new Error('Test error');
        const state = ErrorBoundary.getDerivedStateFromError(error);
        expect(state).toEqual({ hasError: true, error });
    });

    it('initial state has no error', () => {
        const instance = new ErrorBoundary({ children: null });
        expect(instance.state.hasError).toBe(false);
        expect(instance.state.error).toBeNull();
    });

    it('handleDismiss resets error state', () => {
        const instance = new ErrorBoundary({ children: null });
        instance.state = { hasError: true, error: new Error('test') };
        // handleDismiss calls setState, which on a detached instance
        // updates the state directly via the updater callback
        const setStateSpy = (update: Partial<{ hasError: boolean; error: Error | null }>) => {
            Object.assign(instance.state, update);
        };
        instance.setState = setStateSpy as typeof instance.setState;
        instance.handleDismiss();
        expect(instance.state.hasError).toBe(false);
        expect(instance.state.error).toBeNull();
    });
});
