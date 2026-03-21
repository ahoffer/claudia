import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
    }

    handleReload = () => {
        window.location.reload();
    };

    handleDismiss = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div
                    role="alert"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100vh',
                        background: '#1a1a2e',
                        color: '#e0e0e0',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        padding: '2rem',
                        textAlign: 'center',
                    }}
                >
                    <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem', color: '#ff6b6b' }}>
                        Something went wrong
                    </h1>
                    <p style={{ color: '#999', marginBottom: '1.5rem', maxWidth: '500px' }}>
                        A rendering error occurred. You can try dismissing this to recover,
                        or reload the page.
                    </p>
                    <details
                        style={{
                            marginBottom: '1.5rem',
                            maxWidth: '600px',
                            width: '100%',
                            textAlign: 'left',
                            color: '#888',
                            fontSize: '0.85rem',
                        }}
                    >
                        <summary style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>
                            Error details
                        </summary>
                        <pre
                            style={{
                                background: '#111',
                                padding: '1rem',
                                borderRadius: '6px',
                                overflow: 'auto',
                                maxHeight: '200px',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                            }}
                        >
                            {this.state.error?.message}
                            {'\n\n'}
                            {this.state.error?.stack}
                        </pre>
                    </details>
                    <div style={{ display: 'flex', gap: '0.75rem' }}>
                        <button
                            onClick={this.handleDismiss}
                            style={{
                                padding: '0.6rem 1.2rem',
                                background: '#333',
                                color: '#e0e0e0',
                                border: '1px solid #555',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '0.9rem',
                            }}
                        >
                            Try to recover
                        </button>
                        <button
                            onClick={this.handleReload}
                            style={{
                                padding: '0.6rem 1.2rem',
                                background: '#4a6cf7',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '0.9rem',
                            }}
                        >
                            Reload page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
