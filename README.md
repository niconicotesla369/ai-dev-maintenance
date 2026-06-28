# ai-dev-maintenance

Safely diagnose and reclaim local disk usage created by AI coding tool state.

The first release is intentionally small. It focuses on macOS, redacted reports, and safe reclaim of a Codex SQLite log database WAL file.

`doctor` only writes a local redacted report. `fix --safe --yes` creates a private local backup that may contain Codex log data, then truncates SQLite WAL storage. It does not upload data, print log contents, delete logs, rewrite session history, install database triggers, or change tool configuration.

## Quick Start

Run the guided local check:

```bash
npx --yes ai-dev-maintenance@0.1.4
```

In a normal terminal this starts a guided flow. It diagnoses first, explains whether cleanup is safe, and asks before running `fix --safe`.
v0.1.4 adds a small terminal banner for screenshot-friendly guided usage while keeping JSON and CI output plain.

Pinned safety-first diagnosis:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.4 -- doctor --show-paths
```

Short command after global install:

```bash
npm install -g ai-dev-maintenance@0.1.4
aidm
```

If Codex or another AI coding tool is still open, the guided flow pauses for safety. You can close the tool yourself and choose the wait option; `ai-dev-maintenance` will not force close, kill, restart, or modify Codex while it is open.

Manual commands are still available:

1. Diagnose only:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.4 -- doctor --show-paths
```

2. Review the latest report:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.4 -- report --latest
```

3. Only if the output says it is safe:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.4 -- fix --safe --yes
```

Use the pinned version above when you want repeatable behavior. The npm `latest` tag is convenient after you trust the release channel.

`npm exec` may download the package from the npm registry before the CLI starts. After the CLI starts, this tool performs no network calls.

Start with the guided command or `doctor`. It writes a redacted local report under `<home>/.ai-dev-maintenance/reports`. Review that report before running `fix --safe --yes`.

If AI coding tools are still open, `doctor` can complete but `fix --safe --yes` will be marked blocked. Close those tools first, then run `doctor` again.

## Commands

```bash
ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive]
ai-dev-maintenance logo [--plain]
ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive]
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--no-banner]
```

Use `aidm logo` to print only the banner for screenshots or terminal checks. It does not run diagnostics, create reports, or touch the filesystem. Use `--no-interactive` when you want the old static `doctor` output from a TTY. Use `--no-banner` to keep guided mode but hide the banner. Use `--plain` or `NO_COLOR=1` to disable ANSI color. Use `doctor --json` for scripts.

## Safety Guarantees

- `doctor` does not open the source database as a SQLite connection.
- `doctor` writes a redacted local report under the tool data directory.
- `doctor` skips SQLite content inspection in v0.1.x to avoid copying private log database bytes.
- `fix --safe --yes` targets only the default Codex `logs_2.sqlite` database and its SQLite sidecar files.
- `fix --safe` blocks when a known Codex process is running, any process has the target database open, or open-handle checks are unavailable.
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

## Expected Output

The saved report includes:

- `status`
- `blockedReasons`
- `beforeWalBytes`
- `afterWalBytes`
- `reclaimedBytes`
- `nextSafeAction`

See `examples/sample-report.json` for a redacted example.
Human output examples are available in `examples/logo.txt`, `examples/doctor-blocked.txt`, `examples/guided-paused.txt`, `examples/guided-ready.txt`, and `examples/fix-success.txt`.

Redacted reports keep high-level target categories, existence flags, file sizes, command status, and reclaim metrics. They remove raw local-machine identifiers, raw command output, and absolute local paths. `--show-paths` prints only redacted report paths.

Human-readable output includes:

- whether `fix --safe` is ready or blocked;
- the reason it is blocked, if any;
- main database and WAL sizes in MiB;
- what changed in the current command;
- the next command to run.

## Emergency / Advanced Only

Backup validation is available for recovery planning:

```bash
ai-dev-maintenance restore validate --backup <path>
```

This only validates a backup. Do not move, copy, or replace database files unless you are following a recovery guide and all AI coding tools are closed.

## Platform Support

v0.1.x currently supports macOS only. Other platforms exit before touching macOS-specific paths.

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

v0.1.x does not publish a manual wildcard cleanup recipe. A future cleanup command should validate the app data directory before deleting any tool-owned report files.
