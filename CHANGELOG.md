# Changelog

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
