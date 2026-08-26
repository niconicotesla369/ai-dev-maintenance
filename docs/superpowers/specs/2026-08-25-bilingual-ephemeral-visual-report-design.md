# AIDM Bilingual Ephemeral Visual Report Design

**Date:** 2026-08-25
**Status:** Approved visual direction; implementation plan ready for review
**Selected visual target:** Option 2, the calm safety console
**Reference images:**

- `docs/design/aidm-visual-report-en-reference.png`
- `docs/design/aidm-visual-report-ja-reference.png`

## Outcome

AIDM will add an optional, read-only visual report for the redacted aggregate `doctor` result. The report makes disk pressure, tracked AI-tool state, reclaimability buckets, provider composition, and the next human review step understandable at a glance without weakening AIDM's CLI, privacy, MCP, or confirmation boundaries.

The report is a single self-contained HTML document in memory. AIDM does not create an HTML file. It serves the document temporarily from a tokenized `127.0.0.1` URL, opens the user's default browser only after an explicit CLI flag, and destroys the in-memory document when the tab closes or the bounded session expires.

## Public CLI Contract

```text
aidm doctor --html
aidm report --latest --html
```

- `doctor --html` runs the existing metadata-only aggregate doctor, persists the existing redacted JSON report under the existing retention policy, and opens the same sanitized result as a visual report.
- `report --latest --html` reads the latest existing private report and opens it without writing a new report.
- `--html` is CLI-only and is never added to MCP, share cards, scheduled monitoring, or guided cleanup execution.
- `--html` is incompatible with `--json`, `--share`, `--show-paths`, `--plain`, and `--no-banner`. Invalid combinations fail before diagnosis or browser launch.
- The command remains in the foreground while the report is open. `Ctrl+C` closes the loopback server immediately.
- A browser-launch failure or a page that never connects returns a non-zero result and closes the server. AIDM does not leave a background daemon.

## Zero-File Lifecycle

The implementation must not create, copy, cache, or retain an HTML file in AIDM's report directory, the user's home, or an OS temporary directory.

1. Sanitize the structured maintenance report.
2. Convert it to a strict allowlisted `VisualReportModel`.
3. Render one HTML string in memory.
4. Bind an HTTP server to the literal address `127.0.0.1` and an OS-assigned port.
5. Generate a cryptographically random route token and CSP nonce.
6. Open only the tokenized loopback URL with trusted `/usr/bin/open`.
7. Receive same-origin heartbeats while the page is alive.
8. On `pagehide`, send a same-origin close beacon. A short grace period allows reloads to reconnect.
9. If the beacon is lost, close after a bounded heartbeat timeout. Always close at the hard session deadline.
10. When the client reaches the same deadline or confirms that the loopback session is gone, replace the report DOM with a fixed localized session-ended screen so diagnostic values are no longer visible in the open tab.
11. Drop the HTML string, report model, token, timers, listeners, and server references.

The browser may retain its own history entry. The URL contains only a random token, becomes unusable as soon as the server closes, and never contains report data. Responses use `Cache-Control: no-store`.

## Loopback Security Contract

- Bind only `127.0.0.1`; do not bind `0.0.0.0`, a LAN address, IPv6 wildcard, Unix socket, or externally reachable host.
- Use an unguessable token in every route and require the `Host` header to equal `127.0.0.1:<actual-port>` exactly.
- Expose only `GET /<token>/`, `POST /<token>/heartbeat`, and `POST /<token>/close`; all other requests return `404` or `405`.
- Require the two POST routes to carry the exact same-origin `Origin` value `http://127.0.0.1:<actual-port>`; reject a missing or different origin.
- Accept no request body. Reject `Transfer-Encoding` or a non-zero `Content-Length` with `413` and a closed connection before parsing or buffering body data. Use bounded HTTP header/request/keep-alive timeouts; do not parse query-controlled report data.
- Set `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, and a restrictive Permissions Policy and Content Security Policy on every response.
- CSP uses `default-src 'none'`, nonce-only `style-src` and `script-src`, same-origin-only `connect-src`, and explicit `base-uri 'none'`, `form-action 'none'`, and `frame-ancestors 'none'`. No external fonts, images, scripts, styles, analytics, telemetry, or CDNs are allowed.
- Use `shell: false` and a single URL argument when launching `/usr/bin/open`. Validate the executable as a trusted root-owned, non-symlink system command first.
- Do not log the route token, HTML, report model, absolute paths, or raw report JSON.

## Data Boundary

`VisualReportModel` is a human-view allowlist, not a serialized `MaintenanceReport`.

Allowed data:

- schema and report status enums;
- generated timestamp;
- aggregate tracked, safe, review, and protected byte counts;
- volume total, used, available, and capacity percentage when finite;
- known provider IDs mapped to fixed display labels and byte counts;
- entry counts grouped by fixed category and reclaimability enums;
- fixed eligible plan-action enums (`cursor-clean`, `codex-fix`, and `codex-sparkle-clean`) derived from known provider/category combinations;
- coverage state and stable warning codes mapped to fixed localized copy.

Forbidden data:

- absolute or redacted path strings;
- `pathCategory`, `note`, arbitrary advisory text, blocked-reason text, and next-action text from the report;
- process names, PIDs, command summaries, raw command output, session text, image payloads, hashes, tokens, cookies, plan IDs, and local account identifiers;
- raw report JSON or a general recursive serializer.

Unknown provider IDs and unknown warning codes collapse to fixed generic labels. Non-finite or negative byte values fail closed to an unavailable/partial state rather than being rendered.

## Information Architecture

The selected light console is the default production direction.

1. **Header** — AIDM identity, report time, `日本語 | English`, and a read-only badge.
2. **Storage health hero** — available capacity and a disk-pressure label derived from the existing 80%/90% pressure thresholds. If volume metadata is unavailable, show `Unknown`; never invent a value.
3. **Opportunity band** — separate proportional segments for safe, review-first, and never-auto-touch bytes. This is explicitly labeled as tracked AI-tool state, not disk capacity.
4. **Recommended next step** — three grouped rows explaining safe, review, and protected categories. The primary button opens an inline review panel; it never executes cleanup.
5. **Provider composition** — Codex, Cursor, Claude Code, and a fixed `Other` fallback, sorted by bytes.
6. **Privacy proof** — local-only, no upload, paths redacted, no source files changed, and no HTML saved.

The mock values are illustrative only. Production values always come from the current sanitized report. AIDM must not promise that logical reclaim estimates equal APFS free-space gain.

## Read-Only Interaction

The only primary action is `安全なプランを確認` / `Review safe plan`.

- It expands a same-page review panel with category totals and only the fixed CLI commands corresponding to allowlisted eligible plan-action enums in the view model.
- It does not call `plan`, `apply`, reclaim scan, filesystem APIs, or any mutation endpoint.
- A copy control may copy a fixed command string to the clipboard after a direct user gesture. Clipboard failure is shown inline and does not change the report.
- Irreversible image-prune guidance is shown only when an explicit reclaim-scan result is supported in a later design. The aggregate doctor dashboard does not infer image bytes from session totals.

## Localization

- Ship complete `ja` and `en` dictionaries with compile-time key parity.
- Default to Japanese when `navigator.languages` begins with `ja`; otherwise default to English.
- Store the user's switch only in `sessionStorage`. Do not use `localStorage`, cookies, files, or network persistence.
- Keep brand and compact status wayfinding in English where it improves scanability: `AIDM`, `SAFE`, `REVIEW`, `PROTECTED`, `LOCAL ONLY`, `NO UPLOAD`, `PATHS REDACTED`, `NO FILES CHANGED`, `GiB`, and `APFS`.
- Conclusions, explanations, warnings, controls, and accessibility labels are fully localized.
- Set `<html lang>` on every switch and format numbers/dates with `Intl` for the selected language.
- Use only the system font stack, including `-apple-system`, `BlinkMacSystemFont`, `Hiragino Sans`, `Noto Sans JP`, and `Segoe UI` fallbacks.

## Accessibility And Layout

- Meet WCAG AA contrast for body text, status labels, controls, and chart labels.
- Never communicate reclaimability by color alone; pair color with text and position.
- Language controls use native buttons, visible focus, and `aria-pressed`.
- The gauge and distribution bars have text equivalents; charts are supplementary.
- Respect `prefers-reduced-motion`; the report does not require animation.
- Support desktop widths down to 960 px without overlap and a single-column layout below that width. The primary target remains 1440 × 1024.
- Long Japanese and English strings wrap without clipping. A 200% text zoom must preserve access to all content.

## Error And Close Semantics

- Unsupported or schema-v1 reports render a limited, truthful state rather than fabricated aggregate data. A graceful `doctor --html` session still returns the existing doctor exit code (`2` for unsupported); `report --latest --html` keeps the existing report command exit code.
- Missing volume metadata renders `Unknown`; it does not classify disk pressure as safe.
- Coverage lower bounds are prominent and use fixed localized wording.
- Browser-open failure, first-view timeout, idle timeout, hard timeout, explicit close beacon, `SIGINT`, and internal server error each produce a stable close reason.
- Explicit close, idle timeout, and hard timeout are successful view teardown and preserve the command's underlying exit code. `SIGINT` returns `130`; browser-open failure, first-view timeout, and internal server error return `3`.
- Every close path clears timers, removes listeners, and closes the server exactly once.
- No close path deletes AIDM's retained redacted JSON report. UI copy distinguishes “no HTML saved” from normal JSON retention.

## Compatibility And Out Of Scope

- Existing doctor JSON schema v2 and all old fixtures remain byte-compatible.
- Existing human, JSON, share, history, guided, plan/apply, monitor, and MCP behavior remains unchanged without `--html`.
- No HTML renderer or browser launcher is exposed through MCP.
- No cleanup execution, plan approval, arbitrary local URL serving, remote access, persistent web server, service worker, PWA, browser extension, or cloud dashboard is added.
- No frontend framework, runtime dependency, build-time asset pipeline, external font, analytics package, or telemetry is added.
- A specialized visual report for session-image scan/apply results is a later extension, not part of this first dashboard.

## Acceptance Criteria

- Both public commands open the bilingual report and terminate after close.
- No HTML file exists before, during, or after a session.
- The report performs no external request and listens only on `127.0.0.1`.
- Deadline or confirmed loopback loss removes report values and commands from the open page and leaves only the localized session-ended state.
- HTML contains no absolute path, report path, raw report JSON, arbitrary report strings, or session content.
- Japanese and English expose the same values, states, controls, and safety meaning.
- The visual implementation matches the selected light-console references closely at 1440 × 1024.
- Existing CLI and MCP regression tests remain green.
- Typecheck, focused tests, full tests, hygiene, build, package hygiene, and prepublic release checks pass before completion is claimed.
