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
};

export type ValidationIssue = {
  severity: 'error' | 'warning';
  code: 'ragged-row' | 'empty-header' | 'duplicate-header';
  row: number;
  col: number;
  message: string;
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

  if (request.action === 'removeEmptyRows') {
    const before = rows.length;
    rows = rows.filter(row => row.some(value => value !== ''));
    removedRows = before - rows.length;
    return { rows, changedCells, removedRows, samples };
  }

  if (request.action === 'removeDuplicates') {
    const seen = new Set<string>();
    const exemptRows = new Set(options.duplicateExemptRows ?? []);
    rows = rows.filter((row, index) => {
      if (exemptRows.has(index)) {return true;}
      const key = JSON.stringify(row);
      if (seen.has(key)) {
        removedRows++;
        return false;
      }
      seen.add(key);
      return true;
    });
    return { rows, changedCells, removedRows, samples };
  }

  rows.forEach((row, rowIndex) => row.forEach((before, col) => {
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
  }));

  return { rows, changedCells, removedRows, samples };
}

export function validateCsvRows(rows: string[][], hasHeader: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  rows.forEach((row, index) => {
    if (row.length !== width) {
      issues.push({
        severity: 'warning',
        code: 'ragged-row',
        row: index,
        col: Math.max(0, row.length - 1),
        message: `Row ${index + 1} has ${row.length} columns; expected ${width}.`
      });
    }
  });
  if (hasHeader && rows.length) {
    const seen = new Map<string, number>();
    rows[0].forEach((header, col) => {
      const normalized = header.trim().toLocaleLowerCase();
      if (!normalized) {
        issues.push({ severity: 'warning', code: 'empty-header', row: 0, col, message: `Column ${col + 1} has an empty header.` });
      } else if (seen.has(normalized)) {
        issues.push({ severity: 'warning', code: 'duplicate-header', row: 0, col, message: `Header "${header}" is duplicated.` });
      } else {
        seen.set(normalized, col);
      }
    });
  }
  return issues;
}
