import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

const backendPort = process.env.CLAUDIA_BACKEND_PORT || '4001';
const frontendPort = parseInt(process.env.CLAUDIA_FRONTEND_PORT || '5173', 10);

// TLS: reuse the same self-signed cert the backend uses
const tlsCert = process.env.CLAUDIA_TLS_CERT;
const tlsKey = process.env.CLAUDIA_TLS_KEY;
const useTls = !!(tlsCert && tlsKey && existsSync(tlsCert) && existsSync(tlsKey));
const httpsConfig = useTls
    ? { cert: readFileSync(tlsCert!), key: readFileSync(tlsKey!) }
    : undefined;
const backendProto = useTls ? 'https' : 'http';
const wsProto = useTls ? 'wss' : 'ws';

export default defineConfig({
    plugins: [react()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    base: './', // Use relative paths for Electron
    server: {
        port: frontendPort,
        https: httpsConfig,
        proxy: {
            '/api': {
                target: `${backendProto}://localhost:${backendPort}`,
                secure: false, // accept self-signed cert from backend
            },
            '/ws': {
                target: `${wsProto}://localhost:${backendPort}`,
                ws: true,
                secure: false,
            },
        },
    },
});
