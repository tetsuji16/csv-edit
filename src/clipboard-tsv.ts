// Clipboard helpers shared by the extension-side "copy all" path. The webview
// builds the same TSV for partial selections (see copySelectionToClipboard in
// media/main.js); keep the quoting rules in sync.

export function quoteTsvField(value: string): string {
  return /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function rowsToClipboardTsv(rows: string[][]): string {
  return rows.map(row => row.map(quoteTsvField).join('\t')).join('\n');
}

// Mirrors the webview quick filter: case-insensitive substring match against
// the row's data cells concatenated (the serial index column is ignored).
export function rowMatchesQuickFilter(row: string[], query: string): boolean {
  const needle = query.toLocaleLowerCase();
  return !needle || row.join('').toLocaleLowerCase().includes(needle);
}

// Rows the grid shows: skip hidden preamble rows, pad ragged rows to the
// widest visible column, keep the header row, and apply the quick filter to
// body rows only (the header is never filtered in the grid).
export function buildCopyAllRows(
  data: string[][],
  hiddenRows: number,
  treatHeader: boolean,
  filterQuery: string
): string[][] {
  const offset = Math.min(Math.max(0, hiddenRows), data.length);
  const visible = data.slice(offset);
  const width = Math.max(1, visible.reduce((max, row) => Math.max(max, row.length), 0));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');
  const header = treatHeader && visible.length ? [pad(visible[0])] : [];
  const body = (treatHeader ? visible.slice(1) : visible)
    .map(pad)
    .filter(row => rowMatchesQuickFilter(row, filterQuery));
  return [...header, ...body];
}
