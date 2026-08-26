# Security Policy

## Supported Versions

Security fixes target the latest published minor version.

## Reporting a Vulnerability

Please open a private security advisory in the public repository once available. If private advisories are not enabled yet, do not open a public issue with sensitive material; use a minimal public issue asking for a private contact path.

Do not include private session content, logs, tokens, browser data, or machine-specific absolute paths in reports. Use redacted output whenever possible.

We aim to acknowledge actionable vulnerability reports within 7 days.

## Data Handling

The CLI is designed to operate locally. It does not upload diagnostic data. Reports are redacted by default. v0.1.x has no unredacted report output mode.

## Ephemeral Visual-Report Boundary

The CLI-only, read-only visual report is available through `aidm doctor --html` and `aidm report --latest --html`. AIDM serves it only on the literal loopback address `127.0.0.1` and makes no upload or external request. “Ephemeral HTML” means an in-memory document, not a temporary file that is later deleted: no HTML file is written. The Japanese / English switch stores a session-only language preference in `sessionStorage`. Closing the page or reaching session expiry destroys AIDM's in-memory view and makes its tokenized URL unusable.

The zero-file promise applies to HTML only. Keep source/tool state, normal redacted JSON retention, transient HTML, and browser-controlled history/cache separate. `doctor --html` still follows normal redacted JSON retention: it runs `doctor` and creates its normal redacted JSON report. `report --latest --html` reads the existing latest redacted JSON report; it performs neither a new diagnosis nor a new report write. The display itself creates no source copy and mutates no tool state.

Browser history may retain an unusable tokenized loopback URL after the view ends. AIDM sends `Cache-Control: no-store`, but browser-controlled history/cache remains outside its control; AIDM does not guarantee perfect browser erasure or APFS byte-for-byte reclaim.

The visual report can reveal and copy only fixed, allowlisted plan commands. It cannot execute `plan`, `apply`, or cleanup, and it is not exposed through MCP. HTML mode is incompatible with `--json`, `--share`, `--show-paths`, `--plain`, and `--no-banner`.

## v0.6 Safety Boundaries and Recovery

`doctor` remains metadata-only. Content access is restricted to the explicit CLI-only session-image scan/prune workflow; MCP cannot create or invoke any v0.6 reclaim, monitor, native-status, or image-loss action. Image pruning is irreversible, requires a matching private plan plus `--yes --accept-image-loss`, is never unattended or scheduled, and supports only default `$HOME/.codex` plain JSONL sessions that pass fail-closed validation. A custom `CODEX_HOME` (anything other than `$HOME/.codex`) and `.jsonl.zst` files are blocked.

Native-compression status is advisory and never reads Codex configuration or changes native configuration. Sparkle cleanup is limited to the exact Codex Sparkle `Installation/*` cache and proceeds only after identity, version, process, ownership, and path checks; generic updater paths are excluded.

Image-prune manifests are private `0600` recovery evidence under `<home>/.ai-dev-maintenance/manifests/`. Before mutation, global preflight failure changes nothing. A post-mutation fault yields `partial`, consumes the plan, and leaves stable manifest records for reconciliation; human `Free-space delta` and JSON `volumeFreeDeltaBytes` are reported separately from reclaimed logical bytes and are not guaranteed equal.

The optional monitor install writes and bootstraps its user LaunchAgent only after explicit plan/apply. Manual monitor runs never persist; scheduled runs persist local private state and latest reports. It measures session metadata only. Notification delivery is best-effort; a notification failure is a warning and never causes cleanup. Remove the monitor with its explicit remove plan, and reinstall it after the validated Node or AIDM path moves.
