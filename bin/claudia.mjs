#!/usr/bin/env node

// Claudia CLI
// Usage:
//   claudia                Start the server
//   claudia --help         Show help

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'start';

function printHelp() {
    console.log(`
Claudia - Multi-instance Claude Code orchestrator

Usage: claudia [command]

Commands:
  start         Start the server (default)
  help          Show this help

Options:
  --help, -h    Show this help
  --version     Show version

Documentation: https://github.com/ahoffer/claudia
`);
}

function printVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8'));
        console.log(`claudia v${pkg.version}`);
    } catch {
        console.log('claudia (version unknown)');
    }
}

function runStart() {
    const script = join(ROOT_DIR, 'start.sh');

    if (!existsSync(script)) {
        console.error(`start.sh not found: ${script}`);
        process.exit(1);
    }

    const child = spawn('bash', [script], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: { ...process.env }
    });

    child.on('error', (err) => {
        console.error(`Failed to start: ${err.message}`);
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });

    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        process.on(signal, () => {
            child.kill(signal);
        });
    });
}

switch (command) {
    case 'start':
    case 'web':
        runStart();
        break;

    case 'help':
    case '--help':
    case '-h':
        printHelp();
        break;

    case '--version':
    case '-v':
        printVersion();
        break;

    default:
        console.error(`Unknown command: ${command}`);
        console.error(`Run 'claudia --help' for usage.`);
        process.exit(1);
}
