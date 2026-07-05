# Changelog

## Unreleased

## 0.4.0-beta.1 - 2026-07-04

- Add JSON schema contracts and wire-compatibility fixtures for machine-readable output.
- Add JSON output for management commands, including `fix`, Cursor cleanup, pruning, restore validation, and report retrieval.
- Add read-only `history` summaries from saved redacted reports.
- Add local `plan` / `apply` two-step maintenance protocol with private plan files, TTL, replay protection, and identity drift checks.
- Add experimental stdio-only MCP server with read-only tools and no `aidm_apply` exposure.
- Add `trust` to inspect allowlist macOS command path trust without executing those commands.
- Add GitHub release workflow scaffolding for npm provenance publishing.
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
