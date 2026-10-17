import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import Papa from 'papaparse';

const runCopy = (values: string[][], selection: Array<{ row: number; col: number }>, hiddenRows: number[] = []) => {
  const source = fs.readFileSync('media/main.js', 'utf8');
  const start = source.indexOf('const copySelectionToClipboard =');
  const end = source.indexOf("window.addEventListener('message'", start);
  let copied = '';
  const context = {
    currentSelection: selection,
    getCellCoords: (cell: unknown) => cell,
    hasHeader: true,
    CSV_SEPARATOR: ',',
    table: { querySelector: (selector: string) => {
      const row = Number(/data-row="(\d+)"/.exec(selector)![1]);
      const col = Number(/data-col="(\d+)"/.exec(selector)?.[1] ?? 0);
      const tr = { style: { display: hiddenRows.includes(row) ? 'none' : '' } };
      return { textContent: values[row][col], closest: () => tr };
    } },
    vscode: { postMessage: (message: { text: string }) => { copied = message.text; } }
  };
  vm.runInNewContext(source.slice(start, end) + '\ncopySelectionToClipboard();', context);
  return copied;
};

test('copy produces lossless TSV and skips the serial index', () => {
  const values = [['a,b', 'tab\there', '"quoted"'], ['multi\nline', '', 'tail  ']];
  const copied = runCopy(values, [{ row: 0, col: -1 }, { row: 0, col: 0 }, { row: 1, col: 2 }]);
  assert.deepEqual(Papa.parse(copied, { delimiter: '\t' }).data, values);
  assert.ok(copied.endsWith('tail  '));
});

test('copy skips rows hidden by the quick filter', () => {
  const values = [['h1', 'h2'], ['keep', '1'], ['hidden', '2'], ['also', '3']];
  const copied = runCopy(values, [{ row: 0, col: 0 }, { row: 3, col: 1 }], [2]);
  assert.equal(copied, 'h1\th2\nkeep\t1\nalso\t3');
});
