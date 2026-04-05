# Releasing Claudia

## Installing from npm

```bash
npm install -g @ahoffer/claudia
claudia
```

## Versioning

Versioning is controlled by `version.txt` in the project root. All package versions are synced from it.

## Publishing a Release

```bash
npm run release
```

This syncs versions into all `package.json` files, commits, tags (`vX.Y.Z`), and pushes. The CI pipeline builds, tests, waits for your approval in GitHub Actions, then publishes to npm.
