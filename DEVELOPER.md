# Developer Guide

## Auto-Reload

The backend uses `tsx watch` and auto-reloads when you change `.ts` files. The frontend uses Vite HMR. No need to restart the server during development.

## Testing

```bash
npm test
```

## Installing from npm

```bash
npm install -g @ahoffer/claudia
claudia
```

## Releasing

Versioning is controlled by `version.txt` in the project root. All package versions are synced from it.

```bash
npm run release
```

This syncs versions into all `package.json` files, commits, tags (`vX.Y.Z`), and pushes. The CI pipeline builds, tests, waits for your approval in GitHub Actions, then publishes to npm.
