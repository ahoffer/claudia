import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NotificationProvider } from './components/NotificationContainer';
import { setupAudioUnlock } from './utils/browserCapabilities';
import './styles/index.css';

// Set up AudioContext unlock on first user interaction (required for iOS/Android)
setupAudioUnlock();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
        <NotificationProvider>
            <App />
        </NotificationProvider>
    </ErrorBoundary>
);
