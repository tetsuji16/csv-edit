# CSV Edit

A fast, modern spreadsheet editor for CSV files in Visual Studio Code.

CSV Edit opens `.csv`, `.tsv`, `.tab`, and `.psv` files as an editable grid by
default. It keeps the file as plain text, works with VS Code's save and undo
model, and never uploads your data.

> 日本語: CSV EditはCSV系ファイルを既定で表形式表示し、VS Code内で安全に
> 編集できるローカル専用エディターです。

![CSV Edit dark theme](https://raw.githubusercontent.com/tetsuji16/csv-edit/main/images/Screenshot_dark.png)

## Highlights

- Spreadsheet editing with cell, range, row, and column selection
- Excel-compatible copy and paste
- Insert, delete, resize, and reorder rows and columns
- Sort, quick filter, find and replace
- Undo and redo through VS Code's document history
- Data tools with a preview before applying bulk changes
- Validation for ragged rows and invalid headers
- Chunked rendering for large files
- CSV, TSV, TAB, and PSV delimiter support
- Per-file header, separator, sizing, scroll, and selection state
- Grid/text view preference remembered globally
- Independent Auto, Light, and Dark themes
- English and Japanese command and setting labels
- Runtime-validated editor messages and cached parsing for safer, faster editing

## Views and theme

Use the **Text** button in the grid or the editor-title action to switch between
the grid and VS Code's text editor. The last choice becomes the default for the
next CSV-like file you open.

Use the sun/moon button or **CSV Edit: Set Theme** to choose Auto, Light, or
Dark. This changes CSV Edit only; it does not change the VS Code workbench.

## Data tools

Open **Tools** to trim whitespace, change case, fill empty cells, remove empty
rows, or remove duplicate rows. CSV Edit shows the number of affected cells and
rows before applying the operation. Each accepted operation is one undo step.

Open **Validate** to detect rows with inconsistent column counts, empty headers,
and duplicate headers.

## Keyboard

| Action | Windows/Linux | macOS |
|---|---|---|
| Save | `Ctrl+S` | `Cmd+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` | `Cmd+Z` / `Cmd+Shift+Z` |
| Find / Replace | `Ctrl+F` / `Ctrl+H` | `Cmd+F` / `Cmd+H` |
| Copy / Paste | `Ctrl+C` / `Ctrl+V` | `Cmd+C` / `Cmd+V` |
| Select all | `Ctrl+A` | `Cmd+A` |
| Edit cell | `Enter` or double-click | `Enter` or double-click |
| New line in cell | `Shift+Enter` | `Shift+Enter` |

## Commands

- `CSV Edit: Open as Grid`
- `CSV Edit: Open as Text`
- `CSV Edit: Toggle Grid/Text View`
- `CSV Edit: Set Theme`
- `CSV Edit: Find`
- `CSV Edit: Replace`
- `CSV Edit: Toggle Filters`
- `CSV Edit: Open Data Tools`
- `CSV Edit: Validate Data`

Legacy `CSV:` commands remain available for header, index, separator, encoding,
font, and link settings.

## Requirements

- Visual Studio Code 1.130 or newer
- Windows, macOS, or Linux

## Development

```sh
npm ci
npm run verify
npm run package
```

The package command creates an installable `.vsix`. Marketplace publishing is
intentionally manual and requires credentials owned by publisher `tetsuji16`.

## Privacy and support

See [PRIVACY.md](PRIVACY.md) and [SUPPORT.md](SUPPORT.md).

CSV Edit is MIT licensed and derived from
[jonaraphael/csv](https://github.com/jonaraphael/csv). See [NOTICE](NOTICE).

## Architecture

Papa Parse is the single CSV parser/serializer. A cached document model
preserves BOM and line endings, while Zod validates every message crossing the
webview boundary. Large-file width and type inference use bounded stratified
samples; row rendering continues to use on-demand chunks.
