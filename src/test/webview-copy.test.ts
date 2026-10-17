import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import Papa from 'papaparse';

const source = fs.readFileSync('media/main.js', 'utf8');

const runCopy = (
  values: string[][],
  selection: Array<{ row: number; col: number }>,
  hiddenRows: number[] = [],
  extra: Record<string, unknown> = {}
) => {
  const start = source.indexOf('const copySelectionToClipboard =');
  const end = source.indexOf("window.addEventListener('message'", start);
  const messages: Array<{ type: string; text?: string; filter?: string }> = [];
  const context = {
    currentSelection: selection,
    getCellCoords: (cell: unknown) => cell,
    hasHeader: true,
    HEADER_ROW: 0,
    CSV_SEPARATOR: ',',
    t: (key: string) => key,
    showToast: () => {},
    table: { querySelector: (selector: string) => {
      const row = Number(/data-row="(\d+)"/.exec(selector)![1]);
      const col = Number(/data-col="(\d+)"/.exec(selector)?.[1] ?? 0);
      const tr = { style: { display: hiddenRows.includes(row) ? 'none' : '' } };
      return { textContent: values[row][col], closest: () => tr };
    } },
    vscode: { postMessage: (message: { type: string; text?: string }) => { messages.push(message); } },
    ...extra
  };
  vm.runInNewContext(source.slice(start, end) + '\ncopySelectionToClipboard();', context);
  return messages;
};

test('copy produces lossless TSV and skips the serial index', () => {
  const values = [['a,b', 'tab\there', '"quoted"'], ['multi\nline', '', 'tail  ']];
  const [message] = runCopy(values, [{ row: 0, col: -1 }, { row: 0, col: 0 }, { row: 1, col: 2 }]);
  assert.equal(message.type, 'copyToClipboard');
  assert.deepEqual(Papa.parse(message.text!, { delimiter: '\t' }).data, values);
  assert.ok(message.text!.endsWith('tail  '));
});

test('copy skips rows hidden by the quick filter', () => {
  const values = [['h1', 'h2'], ['keep', '1'], ['hidden', '2'], ['also', '3']];
  const [message] = runCopy(values, [{ row: 0, col: 0 }, { row: 3, col: 1 }], [2]);
  assert.equal(message.text, 'h1\th2\nkeep\t1\nalso\t3');
});

test('copy after select-all delegates to the extension with the active filter', () => {
  const messages = runCopy([['a']], [{ row: 0, col: 0 }], [], {
    isSelectAllActive: () => true,
    quickFilterQuery: 'Tok'
  });
  // Objects come from the vm realm, so compare structurally via JSON.
  assert.equal(JSON.stringify(messages), JSON.stringify([{ type: 'copyAll', filter: 'Tok' }]));
});

test('select-all tracking is invalidated by later selection changes', () => {
  assert.ok(source.includes('selectAllSelection = currentSelection;'));
  assert.ok(source.includes('currentSelection === selectAllSelection && currentSelection.length === selectAllLength'));
});

test('quick filter ignores the serial index and re-applies to loaded chunks', () => {
  assert.ok(source.includes(".filter(cell => cell.getAttribute('data-col') !== '-1')"));
  assert.ok(source.includes("window.addEventListener('csvChunkLoaded', () => { if (quickFilterQuery) applyQuickFilter(); });"));
});
