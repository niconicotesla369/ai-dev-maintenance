# Contributing

This project accepts small, safety-focused changes.

## Scope

v1 focuses on local diagnosis and safe WAL reclaim only. It does not edit session history, delete logs, install triggers, replace SQLite databases, or run full database vacuum by default.

## Do Not Share Private Data

Do not paste session contents, log bodies, tokens, browser data, absolute local paths, or screenshots containing private machine details into issues or pull requests.

Use redacted command output. If a reproduction needs local files, create synthetic fixtures.

## Development

```bash
corepack pnpm install
corepack pnpm run verify
corepack pnpm run build
```

Add tests before changing behavior.
