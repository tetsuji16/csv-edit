import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import Papa from 'papaparse';

test('copy produces lossless TSV and skips the serial index', () => {
  const source = fs.readFileSync('media/main.js', 'utf8');
  const start = source.indexOf('const copySelectionToClipboard =');
  const end = source.indexOf("window.addEventListener('message'", start);
  const values = [['a,b', 'tab\there', '"quoted"'], ['multi\nline', '', 'tail  ']];
  let copied = '';
  const context = {
    currentSelection: [{ row: 0, col: -1 }, { row: 0, col: 0 }, { row: 1, col: 2 }],
    getCellCoords: (cell: unknown) => cell,
    hasHeader: true,
    CSV_SEPARATOR: ',',
    table: { querySelector: (selector: string) => {
      const matches = [...selector.matchAll(/data-(?:row|col)="(\d+)"/g)];
      return { textContent: values[Number(matches[0][1])][Number(matches[1][1])] };
    } },
    vscode: { postMessage: (message: { text: string }) => { copied = message.text; } }
  };
  vm.runInNewContext(source.slice(start, end) + '\ncopySelectionToClipboard();', context);
  assert.deepEqual(Papa.parse(copied, { delimiter: '\t' }).data, values);
  assert.ok(copied.endsWith('tail  '));
});
