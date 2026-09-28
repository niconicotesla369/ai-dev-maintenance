# Changelog

## Unreleased

## 0.6.0 - 2026-08-26

- Add the local-only, ephemeral visual report for `aidm doctor --html` and `aidm report --latest --html`: memory-only HTML, normal redacted JSON retention, session-only language preference, browser-history limits, incompatible flags, and CLI-only/MCP-excluded read-only boundaries.
- Add explicit, content-reading Codex session-image estimates and CLI-only, irreversible image-prune plans requiring `--yes --accept-image-loss`; pruning is never unattended and writes private audit manifests (hashes and counts only; removed images cannot be restored from them).
- Add advisory native-compression status without reading or changing Codex configuration, and conditional cleanup for only the exact Codex Sparkle `Installation/*` cache.
- Add an opt-in metadata-only Codex session monitor with private local state, explicit LaunchAgent install/remove plans, best-effort notifications, and path-move reinstall guidance.
- Preserve `doctor` as metadata-only, keep the new actions unavailable through MCP, and report logical reclaimed bytes separately from non-guaranteed volume-free deltas.
- Replace the guided `aidm` flow with an approval-per-item reclaim flow for the Codex log-database write-ahead log and Cursor caches/logs. Each item shows an estimate, reason, and impact; approved items are revalidated through `plan` / `apply` immediately before running; results separate target change, managed-state change, and unattributed volume change, and one private `reclaim-run.v1` record per run is shown by `aidm report --latest --html`.
- Fix session-image pruning so only JSON values that are exactly a base64 image data URL are replaced; data URLs embedded in tool output, pasted code, or text are no longer rewritten.
- `fix --safe` now checks free space before its backup, records backup failures as blocked reports, reports any failure after the checkpoint starts as `partial`, and scales SQLite timeouts with database size.
- `cursor clean --safe --yes` reports failed removals as `partial` and exits with code 3; `plan` / `apply` no longer restores a plan whose engine already changed files.
- Commands run with `--json` now print a `cli-error.v1` JSON object on stdout when they fail before producing their own JSON; human usage and not-found errors go to stderr.
- `backups prune --yes` and post-fix retention remove provably abandoned, never-validated backup temporaries and report them as `incompleteDeleted`.
- `fix --safe` human output labels folded WAL as `WAL folded` and shows the measured `DB+WAL change` and `Backup kept`; JSON keeps `reclaimedBytes` for compatibility and adds `targetNetDeltaBytes` and `backupBytes`.

## 0.5.0 - 2026-08-24

- Diagnose Codex sessions, archives, generated images, backups, sidecars, and unknown root state without double counting.
- Show the exact OpenAI Codex Sparkle cache as review-first; it remains untouched.
- Add metadata-only volume context and lower-bound warnings to close the pressure-to-doctor diagnostic gap.
- Keep aggregate JSON at schema v2 with `totals.totalBytes`; cleanup engines/action gates are unchanged.
- Change human-facing wording from `Total state` to `Tracked state`.

## 0.4.1 - 2026-07-06

- Minimize live pressure `commandSummary` for AI provider processes to executable basenames, preventing workspace names, UUIDs, and launch arguments from crossing JSON or MCP output.
- Add aggregate doctor context reminding agents to compare AI tool state with whole-disk usage before treating AI tools as the cause of disk pressure.
- Keep cleanup engines, SQLite/WAL handling, redaction, MCP tool exposure, and safe action gates unchanged.

## 0.4.0 - 2026-07-06

- Add JSON schema contracts and wire-compatibility fixtures for machine-readable output.
- Add JSON output for management commands, including `fix`, Cursor cleanup, pruning, restore validation, and report retrieval.
- Add read-only `history` summaries from saved redacted reports.
- Add local `plan` / `apply` two-step maintenance protocol with private plan files, TTL, replay protection, and identity drift checks.
- Add experimental stdio-only MCP server with read-only tools and no `aidm_apply` exposure.
- Add `trust` to inspect allowlist macOS command path trust without executing those commands.
- Add GitHub release workflow scaffolding for npm provenance publishing.
- Harden the release workflow with tag/package version matching and OIDC-friendly npm trusted publishing.
- Update aggregate doctor next-action wording for agent use: dry runs stay explicit, cleanup guidance points to `plan` and human-visible `apply`.
- Clarify MCP `aidm_doctor` description so agents route cleanup through `aidm_plan` and a human CLI step.
- Document that MCP doctor requests do not write reports and do not appear in local history.
- Keep cleanup engines, SQLite/WAL handling, redaction, and safe action gates unchanged.

## 0.3.2 - 2026-07-03

- Add `pressure --share` for a public, allowlisted, process-free pressure card.
- Keep the pressure JSON schema, live pressure diagnosis, cleanup logic, SQLite/WAL handling, and redaction unchanged.

## 0.3.1 - 2026-07-03

- Normalize pressure CPU severity by logical CPU capacity while preserving per-core `ps` CPU totals.
- Add `aiCpuCapacityPercent`, `otherCpuCapacityPercent`, and `logicalCpuCount` to pressure totals when available.
- Exclude AIDM's own process and direct child processes from live pressure totals.
- Add `doctor --share` for a public, allowlisted, path-free share card.
- Keep cleanup logic, SQLite/WAL handling, redaction, and `fix --safe --yes` unchanged.

## 0.3.0 - 2026-07-02

- Add root help support with `--help` and `-h`.
- Document CLI exit codes.
- Add sanitized pressure parser fixtures for macOS command output.
- Change pressure schemaVersion 2, which separates AI totals from non-AI process pressure.
- In pressure schemaVersion 2, aiCpuPercent no longer includes non-AI processes.
- Use macOS `memory_pressure -Q` as the primary memory pressure source.
- Keep non-AI process command summaries to executable basenames only.
- Report Cursor cleanup `deletedBytes` from successfully deleted file sizes instead of the pre-cleanup estimate.

## 0.2.6 - 2026-07-02

- Refined terminal-native pretty output for `pressure`.
- Grouped pressure reasons under `Signals` and `Next actions`.
- Added Top CPU and Top RAM table headers.
- Kept JSON shape, cleanup logic, SQLite/WAL handling, redaction, and safety checks unchanged.

## 0.2.5 - 2026-06-30

- Added root `--version`, `-v`, and `version` commands.
- Kept version output side-effect free.

## 0.2.4 - 2026-06-30

- Added terminal-native pretty output for guided mode and pressure reports.
- Kept script-safe fallback for JSON, plain, CI, NO_COLOR, non-TTY, and narrow terminals.

## 0.2.3 - 2026-06-30

- Stabilized the disposable SQLite fix e2e timeout.

## 0.2.2 - 2026-06-30

- Added the live pressure doctor for read-only CPU/RAM/process pressure visibility.

## 0.2.0 - 2026-06-29

- Added the read-only multi-provider doctor for Codex, Claude Code, and Cursor local state.
- Added safe size scanning and schema v2 aggregate reporting.

## 0.1.5 - 2026-06-28

- Hardened reliability and retention for Codex WAL cleanup.
- Downgraded Codex process-name detection to advisory and kept DB open-handle checks as the safety gate.

## 0.1.4 - 2026-06-28

- Added visual polish and `aidm logo`.

## 0.1.3 - 2026-06-28

- Added guided CLI mode with safety-first prompts.

## 0.1.2 - 2026-06-28

- Added the short `aidm` command alias.

## 0.1.1 - 2026-06-28

- Improved human-readable CLI output for diagnosis and fix readiness.

## 0.1.0 - 2026-06-28

- Initial public release of the Codex SQLite WAL maintenance CLI.
