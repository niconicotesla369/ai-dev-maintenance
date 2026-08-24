# ai-dev-maintenance

Safely diagnose complete, disjoint Codex tracked state and current volume context without confusing tracked bytes with reclaimable disk space.

v0.5.0 diagnoses every regular file under `CODEX_HOME` through known disjoint buckets plus private `other-state`, adds metadata-only volume context and lower-bound warnings, and keeps the distinction between tracked state and reclaimable bytes explicit. It also diagnoses Claude Code and Cursor local state, includes guarded Cursor cache/log cleanup, adds terminal-native pretty output for the guided check and live pressure check with a defensible overall pressure level, and adds path-free `doctor --share` and `pressure --share` cards for public posting. Machine-readable JSON contracts, local `plan` / `apply`, read-only history, an experimental stdio-only MCP server, and `aidm trust` remain available.

`doctor` only reads file-size and volume metadata with `lstat`/`readdir`/`statfs` and writes a local redacted report. It does not read chat contents, open application databases, upload data, delete files, rewrite session history, install database triggers, or change tool configuration.

## Tracked State Scope and Compatibility

`Tracked state` is the sum of entries AIDM explicitly diagnoses, not all macOS System Data. This tracked state for Codex uses known disjoint buckets plus private `other-state` to cover all regular files under `CODEX_HOME` without double counting: sessions, archives, generated images, backups, log-database sidecars, and unknown root state are diagnosed, not cleanup targets.

When a custom `CODEX_HOME` overlaps the exact Sparkle root, boundary-safe path ownership emits their union once: the wider root owns it, with custom ownership winning an equal-root tie. A custom owner keeps its private buckets and remainder; a wider Sparkle owner is conservatively `never`, not review-first.

When disjoint, the exact `org.sparkle-project.Sparkle` cache at `<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle` is visible as review-first and is never auto-deleted. Generic updater globs are not scanned or cleaned. AIDM does not clean Codex sessions or Sparkle.

In addition to the metadata-only file-size scan, `doctor` uses `statfs` for metadata-only volume context; it does not read file contents. A truncated scan reports a lower bound, so its bytes are a minimum rather than a complete measurement. Provider logical bytes and volume allocated usage are different measurements, which makes tracked-share percentages diagnostic, not causal evidence of disk pressure.

Aggregate JSON remains schema v2 for compatibility, including `totals.totalBytes`. This wording change does not alter cleanup scope, cleanup engines, or action gates: human aggregate output calls the value `Tracked state` rather than total local AI-tool state.

The Cursor cleanup path is opt-in. `cursor clean --safe` is a dry run, and `cursor clean --safe --yes` removes only Cursor `Cache`, `CachedData`, `CachedExtensionVSIXs`, and `logs` contents. It does not touch `state.vscdb`, `state.vscdb.backup`, `workspaceStorage`, settings, auth, or conversation history.

The existing Codex-only `fix --safe --yes` path remains available for SQLite WAL checkpoint/truncate. It creates a private local backup that may contain Codex log data before touching the Codex log database.

`pressure` is separate from disk cleanup. It reads bounded local process metadata to show which AI-development-related processes are currently using CPU and memory, with labels such as `Codex Renderer`, `node/vitest`, `Chrome Helper`, or `syspolicyd` instead of opaque `other` rows. JSON and MCP command summaries are limited to executable basenames, so launch arguments, workspace names, and UUID-like window identifiers are not forwarded. It does not kill, quit, restart, suspend, renice, or modify any process.

Memory pressure uses macOS `memory_pressure -Q` as the primary source. `vm_stat` page data is supplemental and is not used to guess high memory pressure when `memory_pressure -Q` is unavailable. CPU percentages follow macOS `ps`: `100% = one logical CPU core`, so multi-core Macs can show totals above 100%. When the logical CPU count is available, pressure severity uses capacity-normalized CPU percentages while preserving the raw `ps` totals.

`pressure --json` uses `schemaVersion 2`. In this schema, aiCpuPercent no longer includes non-AI processes; non-AI CPU/RAM is reported separately as `otherCpuPercent` and `otherRssBytes`.

`doctor --share` and `pressure --share` emit compact public cards built from explicit allowlists. They do not include local paths, process names, PIDs, hostnames, usernames, warnings, blocked reasons, or timestamps more precise than the day.

Human-facing TTY output now uses ANSI color, Unicode borders, meters, and compact cards when the terminal is wide enough. `--plain`, `--json`, `NO_COLOR=1`, CI, non-TTY output, and narrow terminals stay script-safe and use the simple row format. If you capture a screenshot through `npx` or `npm exec`, npm/node may briefly appear in Top CPU; a global install gives cleaner screenshots.

## Quick Start

Run the guided local check:

```bash
npx --yes ai-dev-maintenance@0.5.0
```

In a normal terminal this starts the guided Codex cleanup flow. It diagnoses first, explains whether cleanup is safe, and asks before running `fix --safe`.
`doctor` is a read-only multi-tool report for Codex, Claude Code, and Cursor.

Pinned safety-first diagnosis:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- doctor --show-paths
```

Live CPU/RAM pressure check:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- pressure
```

Use `pressure` when the machine feels slow right now. Use `doctor` when you want to inspect disk growth from local AI-tool state.

Short command after global install:

```bash
npm install -g ai-dev-maintenance@0.5.0
aidm
```

If the target log database is still open, the guided flow pauses for safety. You can close the tool yourself and choose the wait option; `ai-dev-maintenance` will not force close, kill, restart, or modify Codex while it is open.

Manual commands are still available:

1. Diagnose only:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- doctor --show-paths
```

2. Review the latest report:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- report --latest
```

3. Only if the output says it is safe:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- fix --safe --yes
```

Use the pinned version above when you want repeatable behavior. The npm `latest` tag is convenient after you trust the release channel.

Cursor cache/log cleanup is separate from Codex WAL cleanup:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- cursor clean --safe
npm exec --yes --ignore-scripts ai-dev-maintenance@0.5.0 -- cursor clean --safe --yes
```

The first command is a dry run. The second command is the mutating cleanup.

`npm exec` may download the package from the npm registry before the CLI starts. After the CLI starts, this tool performs no network calls.

Start with the guided command or `doctor`. It writes a redacted local report under `<home>/.ai-dev-maintenance/reports`. Review that report before running `fix --safe --yes`.

If another process has the target database open, `doctor` can complete but `fix --safe --yes` will be marked blocked. Close that tool first, then run `doctor` again.

## Commands

```bash
ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive] [--plain]
ai-dev-maintenance --help | -h
ai-dev-maintenance --version | -v | version
ai-dev-maintenance logo [--plain]
ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--no-banner]
ai-dev-maintenance pressure [--json] [--share] [--no-banner] [--plain]
ai-dev-maintenance history [--json] [--plain]
ai-dev-maintenance trust [--json]
ai-dev-maintenance cursor clean --safe [--yes]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
ai-dev-maintenance restore validate --backup <path>
ai-dev-maintenance plan codex-fix|cursor-clean [--json]
ai-dev-maintenance apply --plan <planId> --yes [--json]
ai-dev-maintenance mcp serve
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive] [--plain]
aidm --help | -h
aidm --version | -v | version
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--share] [--no-banner]
aidm pressure [--json] [--share] [--no-banner] [--plain]
aidm history [--json] [--plain]
aidm trust [--json]
aidm cursor clean --safe [--yes]
aidm fix --safe --yes
aidm report --latest [--show-paths]
aidm reports prune --yes
aidm backups prune --yes
aidm restore validate --backup <path>
aidm plan codex-fix|cursor-clean [--json]
aidm apply --plan <planId> --yes [--json]
aidm mcp serve
```

Use `aidm logo` to print only the banner for screenshots or terminal checks. It does not run diagnostics, create reports, or touch the filesystem. Use `--no-interactive` when you want the old static `doctor` output from a TTY. Use `--no-banner` to keep guided mode but hide the banner. Use `--plain` or `NO_COLOR=1` for simple row output without ANSI color. Use `doctor --json` or `pressure --json` for scripts. Use `doctor --share` or `pressure --share` when you need a public, path-free summary card. `--show-paths` prints local machine paths in human output only; do not paste that output into public issues or chat logs.

`plan` and `apply` implement a local two-step maintenance protocol for harnesses that need an explicit review point. `plan codex-fix` and `plan cursor-clean` create a private local plan file under the tool data directory. `apply --plan <planId> --yes` re-checks identity and then calls the existing safe engine; it does not bypass `fix --safe` or Cursor cleanup safety gates.

Experimental MCP server:

```bash
ai-dev-maintenance mcp serve
```

The MCP server is a stdio-only JSON-RPC endpoint for local agent harnesses. No network, socket, or HTTP server is opened. It exposes `aidm_doctor`, `aidm_pressure`, `aidm_report_latest`, `aidm_history`, and `aidm_plan`. It does not expose `aidm_apply`; applying a plan remains an explicit CLI action through `aidm apply --plan <planId> --yes`. `aidm_plan` only creates a private local `0600` plan file and does not run cleanup.

`aidm trust` is a read-only allowlist binary trust check. It shows whether the macOS system commands AIDM relies on are present at the expected root-owned, non-symlink, non-group/other-writable paths. It does not run those commands.
If any allowlist command is missing or untrusted, `aidm trust` exits `3` so scripts can treat the result as needing review.

## Agent / MCP Usage

Registering AIDM with Claude Code can be done with a stdio command such as:

```bash
claude mcp add aidm -- aidm mcp serve
```

The MCP surface is experimental and read-only. It offers diagnosis, pressure, latest report, history, and plan creation. It deliberately does not offer apply or cleanup execution. MCP doctor requests do not write reports and do not appear in history; run the CLI `doctor` command when you want a saved local report. In this context, approval means a human runs `aidm apply --plan <planId> --yes` or explicitly approves an equivalent shell command in their harness. To execute a plan, a human-visible CLI step is still required:

```bash
aidm apply --plan <planId> --yes
```

MCP requests are handled serially. A long local diagnosis can delay later responses in the same session; this is expected for the beta server and avoids introducing background workers or network listeners.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed successfully. This includes read-only checks, `--help`, and `--version`. |
| `1` | Requested local data was not found, such as `report --latest` before any report exists, or an unexpected runtime error occurred. |
| `2` | Usage error, unsupported platform, invalid flag, or invalid argument. |
| `3` | The requested safe action was blocked, unsafe to run, `trust` found an untrusted allowlist command, or the command completed with warnings that need review. |

## Safety Guarantees

- `doctor` does not open the source database as a SQLite connection.
- `doctor` does not read Claude Code or Cursor session contents.
- `pressure` reads process metadata only and does not read session contents, log bodies, SQLite rows, shell history, environment variables, or browser profiles.
- `pressure` does not kill, quit, restart, suspend, renice, or modify processes.
- `doctor` writes a redacted local report under the tool data directory.
- `doctor --share` and `pressure --share` use smaller allowlists than saved reports and human dashboards. They do not include paths, process names, PIDs, warnings, blocked reasons, or precise timestamps.
- `mcp serve` is stdio-only, has no network listener, and does not expose `aidm_apply`.
- `trust` only lstat-checks the allowlist command paths and does not execute system commands.
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
Human output examples are available in `examples/logo.txt`, `examples/doctor-aggregate.txt`, `examples/share-card.txt`, `examples/pressure-share-card.txt`, `examples/cursor-clean-dry-run.txt`, `examples/guided-paused.txt`, `examples/guided-ready.txt`, and `examples/fix-success.txt`.
Live pressure examples are available in `examples/pressure.txt` and `examples/pressure.json`.

Redacted reports keep high-level target categories, existence flags, file sizes, command status, and reclaim metrics. They remove raw local-machine identifiers, raw command output, and absolute local paths. `--show-paths` affects human output only and never changes the saved redacted report.

Human-readable output includes:

- detected AI tools;
- tracked local AI-tool state;
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

v0.5.x currently supports macOS only. Other platforms exit before touching macOS-specific paths.

## Development

```bash
corepack pnpm install
corepack pnpm run verify
corepack pnpm run build
```

The package has no runtime dependencies and no install-time package lifecycle scripts.

Release workflow:

- tag pushes matching `v*` run the GitHub release workflow;
- pre-release versions publish with npm dist-tag `next`;
- stable versions publish with npm dist-tag `latest`;
- npm provenance publishing requires configuring npm Trusted Publishers for this repository before using the workflow.

## Local Data

Redacted maintenance reports are stored under `<home>/.ai-dev-maintenance/reports`.
They are intentionally small and do not contain Codex sessions, other AI tool sessions, or backups.

Private backups are stored under `<home>/.ai-dev-maintenance/backups` and may contain Codex log data. Use `aidm backups prune --yes` to remove old tool-owned backup generations after reviewing your recovery needs.
