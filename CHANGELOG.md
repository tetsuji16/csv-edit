# Changelog

## 0.2.0 — 2026-10-17

A usability release based on an adversarial review of everyday editing.

Fixed
- The Filter, Clean and transform, and Validate panels were invisible (their
  layout rules had been lost), so these features could not be used.
- Clean and transform never applied anything: its confirmation and value
  prompts used browser dialogs, which VS Code webviews block. It is now an
  in-panel flow with a preview and an Apply button.
- Bulk tools no longer rewrite the header row or hidden preamble rows (for
  example UPPERCASE renaming your columns).
- Typing with an input method (IME), such as Japanese, now edits the selected
  cell directly instead of being lost.
- Pressing Escape while the find widget is open now cancels the cell edit first.
- Deleting a selection is now one undoable change instead of one per cell.
- Files whose columns are all text now get their header row detected, and the
  header toggle always switches what you see.
- The value bar no longer hides the second and later lines of multi-line cells.
- Validation compares rows with the typical row width (one row with an extra
  field is reported instead of every other row) and ignores hidden rows.
- The row count in the status bar excludes the header row.
- Removed non-functional "Find in selection" and "Match diacritics" items.
- Cell values are no longer written to the extension log on every edit.

Added
- English and Japanese interface following the VS Code display language.
- Sum, Average, and Count of numeric selections in the status bar.
- Cut (Ctrl+X), F2, Home/End, Ctrl+Home/End, PageUp/PageDown, and Alt+Enter
  line breaks; arrow keys skip rows hidden by the filter.
- A context menu with cut, copy, paste, clear, sort, and insert/delete commands
  that act on every selected row or column; keyboard navigable.
- Address box jump: type a row number (or `row,column`) and press Enter.
- Header row, row numbers, and delimiter controls in the **…** menu; click the
  delimiter in the status bar to change it.
- Clean and transform can target only the selected columns and shows
  before → after samples.
- Validation issues are clickable and jump to the cell.
- The filter, find, and open panel survive structural edits (insert, delete,
  sort, apply) instead of resetting.
- A browser harness and an end-to-end smoke test for development.

## 0.1.15 — 2026-10-17

- Always parse pasted clipboard text as TSV so values containing commas or semicolons are no longer split across cells.
- Keep newlines when cancelling a cell edit with Escape, and show exact multiline/whitespace header values in the formula bar.
- Exclude rows hidden by the quick filter when copying a selection.
- Copy after Select All now includes every row of large files, not just the chunks loaded so far.
- Quick filter matches cell values only (no longer the row number) and also filters rows loaded later.

## 0.1.14 — 2026-10-10

- Copy selected cells as escaped TSV, preserving multiline values, quotes, tabs, trailing empty cells, and whitespace.
- Preserve record line endings when quoted cells contain a different newline style.
- Keep cached document data intact when a bulk replacement cannot be applied.
- Point uneven-row diagnostics to the first missing column.

## 0.1.13

- Fixed Codicon rendering in the CSV webview.

## 0.1.12

- Automated verified Marketplace publishing when the extension version changes on main.

## 0.1.11 — 2026-08-02

- Kept the GitHub and Marketplace introduction consistently in English.

## 0.1.10 — 2026-08-02

- Refreshed the GitHub and Marketplace introduction with clearer English and
  Japanese product copy.
- Added dedicated Marketplace hero and GitHub social preview artwork based on
  the current CSV Edit icon and interface.

## 0.1.8 — 2026-08-01

- Serialized document mutations to prevent rapid consecutive edits from
  overwriting one another.
- Restored editor update state after failed mutations so external document
  changes continue to refresh the grid.
- Corrected duplicate removal for headerless files and files with hidden
  preamble rows.
- Kept empty cells at the end of both ascending and descending sorts.

## 0.1.4 — 2026-08-01

- Replaced the Excel-inspired title bar and ribbon with a compact VS Code-style
  CSV command bar and overflow menu.
- Reduced permanent interface chrome to 84 pixels and tightened the default
  cell padding to maximize the visible data area.
- Removed synthetic spreadsheet column letters and switched the default column
  colors to the active VS Code theme foreground.
- Avoided repeated DOM-wide row and column counting by passing document
  dimensions as webview metadata.
- Replaced the light and dark screenshots with the compact interface.
- Preserved BOM and line-ending style across structural edits and fallback
  serialization paths.
- Normalized batch deletion indices to prevent duplicate or invalid indices
  from deleting unintended adjacent rows or columns.
- Reduced the packaged icon size without changing its appearance.
- Bundled extension-host code with esbuild, removing dependency metadata from
  the VSIX and substantially reducing its file count.

## 0.1.3 — 2026-08-01

- Rebuilt the editor shell as a spreadsheet-style interface with Home, Data,
  and View ribbon tabs.
- Added Excel-style column letters, row headers, active-cell borders, and a
  compact worksheet status bar.
- Added an editable name box and formula bar with apply and cancel controls.
- Added direct ribbon actions for history, copying, row and column structure,
  find, filtering, transformations, validation, and zoom.
- Added responsive light and dark styling plus new original product screenshots.

## 0.1.2 — 2026-07-30

- Added GitHub Sponsors links to the repository and extension manifest.

## 0.1.1 — 2026-07-30

- Re-created the GitHub repository as an official fork of `jonaraphael/csv`.
- Rewrote the README and Marketplace introduction with original copy.
- Replaced all inherited screenshots and artwork with a new CSV Edit icon.
- Added an explicit explanation of the complete CSV Edit rewrite and retained
  the required MIT origin attribution.

## 0.1.0 — 2026-07-29

- Introduced CSV Edit as a rewritten, local-first delimited-text editor.
- Added globally remembered grid and text views.
- Added Auto, Light, and Dark themes scoped to the CSV editor.
- Added filtering, data cleanup, validation, safer message handling, and
  performance-aware parsing and rendering.
- Added English and Japanese UI localization and cross-platform CI.
