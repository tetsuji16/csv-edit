export type DataToolAction =
  | 'trim'
  | 'uppercase'
  | 'lowercase'
  | 'fillEmpty'
  | 'removeEmptyRows'
  | 'removeDuplicates';

export type DataToolRequest = {
  action: DataToolAction;
  columns?: number[];
  value?: string;
};

export type DataToolResult = {
  rows: string[][];
  changedCells: number;
  removedRows: number;
  samples: Array<{ row: number; col: number; before: string; after: string }>;
};

export type DataToolOptions = {
  /** Rows that must not participate in duplicate detection (for example, a header row). */
  duplicateExemptRows?: readonly number[];
  /**
   * Rows no tool may change or remove (hidden preamble rows and the header
   * row). They are also exempt from duplicate detection.
   */
  protectedRows?: readonly number[];
};

export type ValidationIssue = {
  severity: 'error' | 'warning';
  code: 'ragged-row' | 'empty-header' | 'duplicate-header';
  row: number;
  col: number;
  message: string;
  /** Extra values so the webview can build a localized message. */
  expected?: number;
  actual?: number;
  name?: string;
};

const cloneRows = (rows: string[][]): string[][] => rows.map(row => row.map(value => String(value ?? '')));

export function applyDataTool(
  source: string[][],
  request: DataToolRequest,
  options: DataToolOptions = {}
): DataToolResult {
  let rows = cloneRows(source);
  let changedCells = 0;
  let removedRows = 0;
  const samples: DataToolResult['samples'] = [];
  const selected = request.columns?.length ? new Set(request.columns) : undefined;
  const protectedRows = new Set(options.protectedRows ?? []);

  if (request.action === 'removeEmptyRows') {
    const before = rows.length;
    rows = rows.filter((row, index) => protectedRows.has(index) || row.some(value => value !== ''));
    removedRows = before - rows.length;
    return { rows, changedCells, removedRows, samples };
  }

  if (request.action === 'removeDuplicates') {
    const seen = new Set<string>();
    const exemptRows = new Set([...(options.duplicateExemptRows ?? []), ...protectedRows]);
    rows = rows.filter((row, index) => {
      if (exemptRows.has(index)) {return true;}
      // With a column scope, rows are duplicates when those columns match.
      const key = JSON.stringify(selected ? row.filter((_, col) => selected.has(col)) : row);
      if (seen.has(key)) {
        removedRows++;
        return false;
      }
      seen.add(key);
      return true;
    });
    return { rows, changedCells, removedRows, samples };
  }

  // Fill empty also targets cells missing from short (ragged) rows.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  rows.forEach((row, rowIndex) => {
    if (protectedRows.has(rowIndex)) {return;}
    // A blank line (including the one after a trailing newline) is not a row
    // of empty cells; filling it would invent a record.
    if (request.action === 'fillEmpty' && row.length <= 1 && (row[0] ?? '') === '') {return;}
    if (request.action === 'fillEmpty' && request.value) {
      while (row.length < width) {row.push('');}
    }
    row.forEach((before, col) => {
      if (selected && !selected.has(col)) {return;}
      let after = before;
      if (request.action === 'trim') {after = before.trim();}
      if (request.action === 'uppercase') {after = before.toLocaleUpperCase();}
      if (request.action === 'lowercase') {after = before.toLocaleLowerCase();}
      if (request.action === 'fillEmpty' && before === '') {after = request.value ?? '';}
      if (after === before) {return;}
      row[col] = after;
      changedCells++;
      if (samples.length < 8) {samples.push({ row: rowIndex, col, before, after });}
    });
  });

  return { rows, changedCells, removedRows, samples };
}

/**
 * Validate rows from `startRow` on (earlier rows are hidden preamble rows).
 * Issue rows are absolute document row indices.
 */
export function validateCsvRows(allRows: string[][], hasHeader: boolean, startRow = 0): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const offset = Math.min(Math.max(0, startRow), allRows.length);
  const rows = allRows.slice(offset);
  // Expect the most common row width (ties favour the header) so one row
  // with an extra field is reported instead of every other row.
  const counts = new Map<number, number>();
  rows.forEach(row => counts.set(row.length, (counts.get(row.length) ?? 0) + 1));
  let width = hasHeader && rows.length ? rows[0].length : 0;
  let best = counts.get(width) ?? 0;
  counts.forEach((count, length) => {
    if (count > best) {
      best = count;
      width = length;
    }
  });
  rows.forEach((row, index) => {
    if (row.length !== width) {
      issues.push({
        severity: 'warning',
        code: 'ragged-row',
        row: offset + index,
        col: row.length,
        message: `Row ${index + 1} has ${row.length} columns; expected ${width}.`,
        expected: width,
        actual: row.length
      });
    }
  });
  if (hasHeader && rows.length) {
    const seen = new Map<string, number>();
    rows[0].forEach((header, col) => {
      const normalized = header.trim().toLocaleLowerCase();
      if (!normalized) {
        issues.push({ severity: 'warning', code: 'empty-header', row: offset, col, message: `Column ${col + 1} has an empty header.` });
      } else if (seen.has(normalized)) {
        issues.push({
          severity: 'warning',
          code: 'duplicate-header',
          row: offset,
          col,
          message: `Header "${header}" is duplicated.`,
          name: header
        });
      } else {
        seen.set(normalized, col);
      }
    });
  }
  return issues;
}
