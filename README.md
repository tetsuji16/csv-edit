# CSV Edit

Edit delimited text as a spreadsheet without leaving Visual Studio Code.

CSV Edit opens CSV, TSV, TAB, and PSV files in a compact grid by default. The
underlying document stays plain text, so normal saving, source control, diffs,
and VS Code undo history continue to work. Processing is local-only.

> CSV Editは、区切り形式のテキストをVS Code上で表として編集するための
> ローカル完結型エディターです。

![CSV Edit spreadsheet interface](https://raw.githubusercontent.com/tetsuji16/csv-edit/main/images/screenshot-light.png)

The interface follows a familiar spreadsheet layout: a compact ribbon groups
editing and data commands, the name box identifies the active cell, and the
formula bar edits its complete value—including multiline text. Excel-style
column letters, row numbers, selection borders, and a worksheet status bar keep
large tables easy to navigate.

## An independent rewrite

This repository is a GitHub fork of
[jonaraphael/csv](https://github.com/jonaraphael/csv), retained so that the
project's origin and MIT attribution remain visible.

CSV Edit is a complete product and codebase rewrite. Its implementation,
architecture, interface copy, documentation, icon, and Marketplace presentation
were newly created for CSV Edit. The upstream project's README prose,
screenshots, and Marketplace artwork are not reused.

## What it does

- Opens `.csv`, `.tsv`, `.tab`, and `.psv` files directly in a grid
- Edits cells, ranges, rows, and columns with keyboard or mouse
- Provides a spreadsheet ribbon, name box, and editable formula bar
- Shows familiar column letters, row numbers, and active-cell borders
- Copies and pastes tabular data in an Excel-compatible format
- Inserts, removes, resizes, and reorders rows and columns
- Sorts columns, filters visible rows, and searches or replaces values
- Trims, changes case, fills blanks, and removes empty or duplicate rows
- Previews bulk changes before applying them as one undoable operation
- Reports uneven rows, empty headers, and duplicate headers
- Preserves BOM, line endings, delimiters, quoted values, and multiline cells
- Loads large documents in chunks and bounds expensive inference work

## Grid or text—your choice

Select **Text** in the grid, use the editor-title action, or run
**CSV Edit: Toggle Grid/Text View**. CSV Edit remembers the last selection
globally and uses it when the next supported file opens.

Run **CSV Edit: Set Theme** to choose Auto, Light, or Dark. This preference
affects only CSV Edit; Auto follows the active VS Code theme.

## Everyday shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Save | `Ctrl+S` | `Cmd+S` |
| Undo | `Ctrl+Z` | `Cmd+Z` |
| Redo | `Ctrl+Y` | `Cmd+Shift+Z` |
| Find | `Ctrl+F` | `Cmd+F` |
| Replace | `Ctrl+H` | `Cmd+H` |
| Copy / paste | `Ctrl+C` / `Ctrl+V` | `Cmd+C` / `Cmd+V` |
| Edit the active cell | `Enter` | `Enter` |
| Add a line inside a cell | `Shift+Enter` | `Shift+Enter` |

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

## File handling and privacy

CSV Edit does not send document contents to a server. Parsing, editing,
filtering, transformation, and validation happen on your machine. Display state
such as column widths, filters, scroll position, and theme choice is stored in
VS Code state rather than written into the CSV file.

Read the full [privacy statement](PRIVACY.md) or see [support](SUPPORT.md) for
help and issue reporting.

## Support development

If CSV Edit saves you time, you can
[sponsor its continued development](https://github.com/sponsors/tetsuji16).
Sponsorship supports maintenance, accessibility, performance work, and new
releases.

## Requirements

- Visual Studio Code 1.130 or newer
- Windows, macOS, or Linux

## Build from source

```sh
npm ci
npm run verify
npm run package
```

The package command produces a `.vsix` that can be installed from VS Code.

## License and origin

CSV Edit is distributed under the MIT License. The original project copyright
and derivation record are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
