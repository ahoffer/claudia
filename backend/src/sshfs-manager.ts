import { execSync, exec } from 'child_process';
import { mkdirSync, existsSync, rmdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

export interface SshfsMount {
    id: string;
    hostname: string;
    remotePath: string;
    mountPoint: string;
    createdAt: string;
}

const MOUNT_BASE = join(os.homedir(), '.claudia', 'mounts');

// Active mounts tracked in memory (ephemeral, cleaned up on shutdown)
const activeMounts = new Map<string, SshfsMount>();

function mountId(hostname: string, remotePath: string): string {
    // Deterministic ID from hostname + path
    const safePath = remotePath.replace(/^\//, '').replace(/\//g, '-');
    return `${hostname}--${safePath}`;
}

function mountPointFor(hostname: string, remotePath: string): string {
    const folderName = remotePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'root';
    const id = mountId(hostname, remotePath);
    return join(MOUNT_BASE, hostname, `${folderName}-${id.slice(-8)}`);
}

export function isSshfsAvailable(): boolean {
    try {
        execSync('which sshfs', { encoding: 'utf-8', stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

export async function createMount(hostname: string, remotePath: string): Promise<SshfsMount> {
    if (!isSshfsAvailable()) {
        throw new Error('sshfs is not installed. Install it with: sudo apt install sshfs');
    }

    const id = mountId(hostname, remotePath);

    // Already mounted?
    if (activeMounts.has(id)) {
        return activeMounts.get(id)!;
    }

    const mountPoint = mountPointFor(hostname, remotePath);

    // Create mount directory
    mkdirSync(mountPoint, { recursive: true });

    // Run sshfs
    const sshfsCmd = `sshfs ${hostname}:${remotePath} ${mountPoint} -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3`;

    return new Promise((resolve, reject) => {
        exec(sshfsCmd, { timeout: 30000 }, (err, _stdout, stderr) => {
            if (err) {
                // Clean up empty dir on failure
                try { rmdirSync(mountPoint); } catch { /* ignore */ }
                reject(new Error(`SSHFS mount failed: ${stderr || err.message}`));
                return;
            }

            const mount: SshfsMount = {
                id,
                hostname,
                remotePath,
                mountPoint,
                createdAt: new Date().toISOString(),
            };
            activeMounts.set(id, mount);
            resolve(mount);
        });
    });
}

export function removeMount(id: string): boolean {
    const mount = activeMounts.get(id);
    if (!mount) return false;

    try {
        execSync(`fusermount -u ${mount.mountPoint}`, { timeout: 10000, stdio: 'pipe' });
    } catch {
        // Force unmount if normal unmount fails
        try {
            execSync(`fusermount -uz ${mount.mountPoint}`, { timeout: 10000, stdio: 'pipe' });
        } catch { /* best effort */ }
    }

    // Remove mount directory
    try { rmdirSync(mount.mountPoint); } catch { /* ignore */ }

    activeMounts.delete(id);
    return true;
}

export function listMounts(): SshfsMount[] {
    return Array.from(activeMounts.values());
}

export function getMount(id: string): SshfsMount | undefined {
    return activeMounts.get(id);
}

export function getMountByPath(mountPoint: string): SshfsMount | undefined {
    for (const mount of activeMounts.values()) {
        if (mount.mountPoint === mountPoint) return mount;
    }
    return undefined;
}

export function unmountAll(): void {
    for (const id of Array.from(activeMounts.keys())) {
        removeMount(id);
    }

    // Clean up base directory if empty
    if (existsSync(MOUNT_BASE)) {
        try { rmdirSync(MOUNT_BASE, { recursive: true } as any); } catch { /* ignore */ }
    }
}
