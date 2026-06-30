# ai-dev-maintenance

Safely diagnose local disk usage created by AI coding tool state.

v0.2.3 diagnoses Codex, Claude Code, and Cursor local state, includes guarded Cursor cache/log cleanup, and improves the read-only live pressure check for current CPU/RAM load. It shows readable process names, an overall pressure level, total AI tool state, safe-looking cache/log buckets, review-first buckets, and private/danger buckets that are never auto-touched.

`doctor` only scans file sizes with `lstat`/`readdir` and writes a local redacted report. It does not read chat contents, open application databases, upload data, delete files, rewrite session history, install database triggers, or change tool configuration.

The Cursor cleanup path is opt-in. `cursor clean --safe` is a dry run, and `cursor clean --safe --yes` removes only Cursor `Cache`, `CachedData`, `CachedExtensionVSIXs`, and `logs` contents. It does not touch `state.vscdb`, `state.vscdb.backup`, `workspaceStorage`, settings, auth, or conversation history.

The existing Codex-only `fix --safe --yes` path remains available for SQLite WAL checkpoint/truncate. It creates a private local backup that may contain Codex log data before touching the Codex log database.

`pressure` is separate from disk cleanup. It reads bounded local process metadata to show which AI-development-related processes are currently using CPU and memory, with labels such as `Codex Renderer`, `node/vitest`, `Chrome Helper`, or `syspolicyd` instead of opaque `other` rows. It does not kill, quit, restart, suspend, renice, or modify any process.

## Quick Start

Run the guided local check:

```bash
npx --yes ai-dev-maintenance@0.2.3
```

In a normal terminal this starts the guided Codex cleanup flow. It diagnoses first, explains whether cleanup is safe, and asks before running `fix --safe`.
`doctor` is a read-only multi-tool report for Codex, Claude Code, and Cursor.

Pinned safety-first diagnosis:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- doctor --show-paths
```

Live CPU/RAM pressure check:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- pressure
```

Use `pressure` when the machine feels slow right now. Use `doctor` when you want to inspect disk growth from local AI-tool state.

Short command after global install:

```bash
npm install -g ai-dev-maintenance@0.2.3
aidm
```

If the target log database is still open, the guided flow pauses for safety. You can close the tool yourself and choose the wait option; `ai-dev-maintenance` will not force close, kill, restart, or modify Codex while it is open.

Manual commands are still available:

1. Diagnose only:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- doctor --show-paths
```

2. Review the latest report:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- report --latest
```

3. Only if the output says it is safe:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- fix --safe --yes
```

Use the pinned version above when you want repeatable behavior. The npm `latest` tag is convenient after you trust the release channel.

Cursor cache/log cleanup is separate from Codex WAL cleanup:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- cursor clean --safe
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- cursor clean --safe --yes
```

The first command is a dry run. The second command is the mutating cleanup.

`npm exec` may download the package from the npm registry before the CLI starts. After the CLI starts, this tool performs no network calls.

Start with the guided command or `doctor`. It writes a redacted local report under `<home>/.ai-dev-maintenance/reports`. Review that report before running `fix --safe --yes`.

If another process has the target database open, `doctor` can complete but `fix --safe --yes` will be marked blocked. Close that tool first, then run `doctor` again.

## Commands

```bash
ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive]
ai-dev-maintenance logo [--plain]
ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]
ai-dev-maintenance pressure [--json] [--no-banner]
ai-dev-maintenance cursor clean --safe [--yes]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive]
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--no-banner]
aidm pressure [--json] [--no-banner]
aidm cursor clean --safe [--yes]
aidm reports prune --yes
aidm backups prune --yes
```

Use `aidm logo` to print only the banner for screenshots or terminal checks. It does not run diagnostics, create reports, or touch the filesystem. Use `--no-interactive` when you want the old static `doctor` output from a TTY. Use `--no-banner` to keep guided mode but hide the banner. Use `--plain` or `NO_COLOR=1` to disable ANSI color. Use `doctor --json` for scripts. `--show-paths` prints local machine paths in human output only; do not paste that output into public issues or chat logs.

## Safety Guarantees

- `doctor` does not open the source database as a SQLite connection.
- `doctor` does not read Claude Code or Cursor session contents.
- `pressure` reads process metadata only and does not read session contents, log bodies, SQLite rows, shell history, environment variables, or browser profiles.
- `pressure` does not kill, quit, restart, suspend, renice, or modify processes.
- `doctor` writes a redacted local report under the tool data directory.
- `doctor` classifies Claude Code `projects` and Cursor `state.vscdb` as private/danger and never auto-touched.
- `cursor clean --safe` is dry-run by default.
- `cursor clean --safe --yes` removes only Cursor safe cache/log contents and preserves the safe root directories.
- Cursor `state.vscdb`, `state.vscdb.backup`, and `workspaceStorage` are never cleanup targets.
- `doctor` skips SQLite content inspection to avoid copying private log database bytes.
- `fix --safe --yes` targets only the default Codex `logs_2.sqlite` database and its SQLite sidecar files.
- Codex-like process names are advisory only; `fix --safe` blocks when any process has the target database open or open-handle checks are unavailable.
- SQLite commands use safe SQLite file URLs instead of passing plain database paths.
- The tool does not edit sessions, Claude data, Codex config, database rows, schema, or triggers.
- Reports are redacted by default.

## What `fix --safe` Can Change

It can:

- create a verified private local backup under the tool data directory;
- run WAL checkpoint/truncate on the Codex log database;
- report WAL bytes before and after cleanup.

It cannot:

- delete logs;
- shrink the main database with full `VACUUM`;
- replace the database file;
- install triggers;
- edit session history;
- restore a backup automatically.

Retention:

- reports are automatically pruned to the newest 50 files and 30 days;
- backups are automatically pruned after successful cleanup to the newest 3 generations and 14 days;
- manual pruning is available through `aidm reports prune --yes` and `aidm backups prune --yes`.

## Expected Output

The saved report includes:

- `status`
- `blockedReasons`
- `beforeWalBytes`
- `afterWalBytes`
- `reclaimedBytes`
- `nextSafeAction`

See `examples/sample-report.json` for a schema v2 redacted multi-tool example.
Human output examples are available in `examples/logo.txt`, `examples/doctor-aggregate.txt`, `examples/cursor-clean-dry-run.txt`, `examples/guided-paused.txt`, `examples/guided-ready.txt`, and `examples/fix-success.txt`.
Live pressure examples are available in `examples/pressure.txt` and `examples/pressure.json`.

Redacted reports keep high-level target categories, existence flags, file sizes, command status, and reclaim metrics. They remove raw local-machine identifiers, raw command output, and absolute local paths. `--show-paths` affects human output only and never changes the saved redacted report.

Human-readable output includes:

- detected AI tools;
- total local AI tool state;
- safe-looking cache/log buckets;
- review-first buckets;
- private/danger buckets that are never auto-touched;
- what changed in the current command;
- the next command to run.

## Emergency / Advanced Only

Backup validation is available for recovery planning:

```bash
ai-dev-maintenance restore validate --backup <path>
```

This only validates a backup. Do not move, copy, or replace database files unless you are following a recovery guide and all AI coding tools are closed.

## Platform Support

v0.2.x currently supports macOS only. Other platforms exit before touching macOS-specific paths.

## Development

```bash
corepack pnpm install
corepack pnpm run verify
corepack pnpm run build
```

The package has no runtime dependencies and no install-time package lifecycle scripts.

## Local Data

Redacted maintenance reports are stored under `<home>/.ai-dev-maintenance/reports`.
They are intentionally small and do not contain Codex sessions, other AI tool sessions, or backups.

Private backups are stored under `<home>/.ai-dev-maintenance/backups` and may contain Codex log data. Use `aidm backups prune --yes` to remove old tool-owned backup generations after reviewing your recovery needs.
