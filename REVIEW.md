Repository Review and Prioritized Recommendations

Scope: VS Code custom editor for CSV/TSV (`csv.editor`). This document tracks active priorities and critical follow‑ups. Completed items have been removed for clarity.

Priorities

P0 (Critical)
- Virtual row/cell invariants: Maintain exactly one virtual empty row at the bottom; render virtual empty cells so every row shows up to the widest column. Do not promote virtuals to real rows/columns on empty blur.
- Batch operations correctness: Verify multi‑row/column Add/Delete perform the exact counts and preserve indices (delete bottom→top/right→left).
- Webview sandbox: never rely on `alert/confirm/prompt` (blocked in VS Code webviews). `npm run test:e2e` and the harness reproduce the sandbox.

P1 (High)
- Incremental rendering: structural edits still replace the whole webview HTML. UI state (filter, find, panel, selection, scroll) is restored from webview state, but an incremental DOM update would remove the flash and keep focus.
- Encoding UX: Current flow uses the built‑in “Change Encoding” picker and returns to the CSV editor. Consider persisting a per‑URI encoding (via workspaceState).
- Filter on unloaded rows: the quick filter and aggregates operate on rendered rows; Ctrl+End or scrolling loads the rest. Consider filtering in the extension for very large files.

P2 (Medium)
- CSP tightening: Replace `style-src 'unsafe-inline'` with nonce‑only styles.
- Performance: Review `computeColumnWidths` and chunk append for very wide/long files; consider incremental width measurement or sampling.
- Localization: extension-host messages (commands, prompts) are English except the delimiter picker; consider `vscode.l10n`.

Notes
- Papa Parse remains the ground‑truth for read/write to preserve CSV quoting/escaping.
- UI strings for the webview live in `src/webview-i18n.ts` (English/Japanese, same keys and placeholders — enforced by tests).

Local Verification
- `npm run verify` (lint + unit tests)
- `npm run test:e2e` (headless browser, real input)
