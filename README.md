# ai-dev-maintenance

Safely diagnose complete, disjoint Codex tracked state and current volume context without confusing tracked bytes with reclaimable disk space.

v0.6.0 keeps the v0.5 tracked-state compatibility contract and adds guided, opt-in Codex reclaim workflows: explicit image estimates, conditional exact-Sparkle cleanup, native-compression status, and an optional local session monitor. The live CPU/RAM pressure check still reports an overall pressure level with terminal-native pretty output. Machine-readable JSON contracts, local `plan` / `apply`, read-only history, an experimental stdio-only MCP server, and `aidm trust` remain available.

`doctor` only reads file-size and volume metadata with `lstat`/`readdir`/`statfs` and writes a local redacted report. It does not read chat contents, open application databases, upload data, delete files, rewrite session history, install database triggers, or change tool configuration.

## Ephemeral Local Visual Reports

Open the CLI-only, read-only visual report locally with either command:

```bash
aidm doctor --html
aidm report --latest --html
```

AIDM serves the visual report only on the literal loopback address `127.0.0.1`; it makes no upload or external request. “Ephemeral HTML” means an in-memory document, not a temporary file that is later deleted: no HTML file is written. The Japanese / English switch stores a session-only language preference in `sessionStorage`. Closing the page or reaching session expiry destroys AIDM's in-memory view and makes its tokenized URL unusable.

The zero-file promise applies to HTML only. Keep source/tool state, the normally retained redacted JSON report, the transient HTML view, and browser-controlled history/cache separate. `doctor --html` still follows normal redacted JSON retention: it runs `doctor` and creates its normal redacted JSON report. `report --latest --html` reads the existing latest redacted JSON report; it performs neither a new diagnosis nor a new report write. The display itself creates no source copy and mutates no tool state.

Browser history may retain an unusable tokenized loopback URL after the view ends. AIDM sends `Cache-Control: no-store`, but browser-controlled history/cache remains outside its control; AIDM does not guarantee perfect browser erasure or APFS byte-for-byte reclaim.

The visual report can reveal and copy only fixed, allowlisted plan commands. It cannot execute `plan`, `apply`, or cleanup, and it is not exposed through MCP. HTML mode is incompatible with `--json`, `--share`, `--show-paths`, `--plain`, and `--no-banner`.

## v0.6 Guided Codex Reclaim

`doctor remains metadata-only`: it never reads session bodies. `reclaim scan codex-session-images` is a separate explicit command and **reads session files** only to estimate embedded image payloads. Its defaults are `--older-than-days 30` and `--min-file-size-mb 50` (binary MiB); it creates no plan and rewrites nothing.

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- reclaim scan codex-session-images
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- reclaim status codex-native-compression
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- monitor codex-sessions
aidm plan codex-session-image-prune --older-than-days 30 --min-file-size-mb 50
aidm apply --plan <planId> --yes --accept-image-loss
aidm plan codex-sparkle-clean
aidm apply --plan <planId> --yes
aidm plan codex-session-monitor-install --threshold-gib 8 --growth-gib 5
aidm apply --plan <planId> --yes
aidm plan codex-session-monitor-remove
aidm apply --plan <planId> --yes
```

Image pruning is **irreversible and CLI-only**: it is never scheduled or exposed through MCP, requires the exact matching plan plus both confirmations, and has no unattended deletion. It supports only default `$HOME/.codex`, inactive plain `*.jsonl`, and files that pass every revalidation; custom `CODEX_HOME` (anything other than `$HOME/.codex`) and `.jsonl.zst` are unsupported and block the action. A recovery manifest with manifest mode `0600` is written to `<home>/.ai-dev-maintenance/manifests/session-image-<planId>.jsonl`. A legacy anonymous placeholder is **not auditable from files alone**, so it is not attributed to AIDM.

Successful apply reports logical `Reclaimed` bytes and, when measurable, the human `Free-space delta`; JSON uses `volumeFreeDeltaBytes`. They are distinct measurements: APFS accounting and concurrent writes mean free-space equality is not guaranteed. A global preflight failure changes nothing; a post-mutation failure returns `partial` and consumes the plan, leaving stable manifest evidence. No universal compression ratio, including `104x`, is promised.

Native status is advisory and **does not change Codex native-compression configuration**, read `config.toml`, recompress sessions, or expand `.zst`. Sparkle cleanup targets the **exact Codex Sparkle** root `<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle` and only `Installation/*`; it runs **only when every safety check passes**. `Launcher/`, `PersistentDownloads/`, generic updater paths, and native configuration remain untouched.

The monitor is **opt-in**. Manual `aidm monitor codex-sessions` is metadata-only and does not persist. The explicit plan/apply install writes the LaunchAgent plist and bootstraps it at `<home>/Library/LaunchAgents/com.niconicotesla369.ai-dev-maintenance.codex-session-monitor.plist`; the scheduled run persists the monitor state and latest report at `<home>/.ai-dev-maintenance/monitor/` (`codex-sessions-state.v1.json`, `codex-sessions-latest.v1.json`). Default scheduling is day 1 at 04:30 local time (`LowPriorityIO=true`, `Nice=10`), with 8 GiB total and 5 GiB growth thresholds. Notification delivery is best-effort; a failure is a warning and never starts cleanup. Reinstall after either validated Node or AIDM path moves. MCP cannot invoke these new actions.

## Tracked State Scope and Compatibility

`Tracked state` is the sum of entries AIDM explicitly diagnoses, not all macOS System Data. This tracked state for Codex uses known disjoint buckets plus private `other-state` to cover all regular files under `CODEX_HOME` without double counting: sessions, archives, generated images, backups, log-database sidecars, and unknown root state are diagnosed, not cleanup targets.

When a custom `CODEX_HOME` overlaps the exact Sparkle root, boundary-safe path ownership emits their union once: the wider root owns it, with custom ownership winning an equal-root tie. A custom owner keeps its private buckets and remainder; a wider Sparkle owner is conservatively `never`, not review-first.

When disjoint, the exact `org.sparkle-project.Sparkle` cache at `<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle` is visible as review-first and is never auto-deleted. Generic updater globs are not scanned or cleaned. `doctor` and automatic cleanup do not target Codex sessions or Sparkle; the v0.6 explicit, revalidated CLI `plan` / `apply` actions above are the limited exceptions.

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
npx --yes ai-dev-maintenance@0.6.0
```

In a normal terminal this starts the guided Codex cleanup flow. It diagnoses first, explains whether cleanup is safe, and asks before running `fix --safe`.
`doctor` is a read-only multi-tool report for Codex, Claude Code, and Cursor.

Pinned safety-first diagnosis:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- doctor --show-paths
```

Live CPU/RAM pressure check:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- pressure
```

Use `pressure` when the machine feels slow right now. Use `doctor` when you want to inspect disk growth from local AI-tool state.

Short command after global install:

```bash
npm install -g ai-dev-maintenance@0.6.0
aidm
```

If the target log database is still open, the guided flow pauses for safety. You can close the tool yourself and choose the wait option; `ai-dev-maintenance` will not force close, kill, restart, or modify Codex while it is open.

Manual commands are still available:

1. Diagnose only:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- doctor --show-paths
```

2. Review the latest report:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- report --latest
```

3. Only if the output says it is safe:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- fix --safe --yes
```

Use the pinned version above when you want repeatable behavior. The npm `latest` tag is convenient after you trust the release channel.

Cursor cache/log cleanup is separate from Codex WAL cleanup:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- cursor clean --safe
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- cursor clean --safe --yes
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
ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--html] [--no-banner]
ai-dev-maintenance pressure [--json] [--share] [--no-banner] [--plain]
ai-dev-maintenance history [--json] [--plain]
ai-dev-maintenance trust [--json]
ai-dev-maintenance reclaim scan codex-session-images [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
ai-dev-maintenance reclaim status codex-native-compression [--json]
ai-dev-maintenance monitor codex-sessions [--json]
ai-dev-maintenance cursor clean --safe [--yes]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths] [--json] [--html]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
ai-dev-maintenance restore validate --backup <path>
ai-dev-maintenance plan codex-fix|cursor-clean|codex-sparkle-clean [--json]
ai-dev-maintenance plan codex-session-image-prune [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
ai-dev-maintenance plan codex-session-monitor-install [--threshold-gib <GiB>] [--growth-gib <GiB>] [--json]
ai-dev-maintenance plan codex-session-monitor-remove [--json]
ai-dev-maintenance apply --plan <planId> --yes [--accept-image-loss] [--json]
ai-dev-maintenance mcp serve
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive] [--plain]
aidm --help | -h
aidm --version | -v | version
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--share] [--html] [--no-banner]
aidm pressure [--json] [--share] [--no-banner] [--plain]
aidm history [--json] [--plain]
aidm trust [--json]
aidm reclaim scan codex-session-images [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
aidm reclaim status codex-native-compression [--json]
aidm monitor codex-sessions [--json]
aidm cursor clean --safe [--yes]
aidm fix --safe --yes
aidm report --latest [--show-paths] [--json] [--html]
aidm reports prune --yes
aidm backups prune --yes
aidm restore validate --backup <path>
aidm plan codex-fix|cursor-clean|codex-sparkle-clean [--json]
aidm plan codex-session-image-prune [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
aidm plan codex-session-monitor-install [--threshold-gib <GiB>] [--growth-gib <GiB>] [--json]
aidm plan codex-session-monitor-remove [--json]
aidm apply --plan <planId> --yes [--accept-image-loss] [--json]
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

v0.6.x currently supports macOS only. Other platforms exit before touching macOS-specific paths. The v0.5.0 tracked-state wording and schema-v2 notes remain historical compatibility documentation.

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
