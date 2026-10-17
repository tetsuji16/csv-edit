import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';

// Stub 'vscode' before importing the provider.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return { window: { activeColorTheme: { kind: 1 } }, ColorThemeKind: { Dark: 1 } } as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { applyDataTool, validateCsvRows } from '../data-tools';
import { CsvEditorProvider } from '../CsvEditorProvider';
import { formatString, getWebviewStrings } from '../webview-i18n';
import { parseWebviewMessage } from '../webview-protocol';

const webview = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');

test('data tools never rewrite protected header or preamble rows', () => {
  const rows = [['# exported'], ['name', 'city'], [' alice ', ''], ['bob', 'osaka']];
  const upper = applyDataTool(rows, { action: 'uppercase' }, { protectedRows: [0, 1] });
  assert.deepEqual(upper.rows.slice(0, 2), [['# exported'], ['name', 'city']]);
  assert.deepEqual(upper.rows[2], [' ALICE ', '']);
  const filled = applyDataTool(rows, { action: 'fillEmpty', value: 'n/a' }, { protectedRows: [0, 1] });
  assert.equal(filled.rows[0].length, 1, 'preamble row is not padded');
  assert.deepEqual(filled.rows[2], [' alice ', 'n/a']);
});

test('fill empty pads ragged rows but ignores blank lines', () => {
  const rows = [['a', 'b', 'c'], ['1'], ['']];
  const result = applyDataTool(rows, { action: 'fillEmpty', value: '-' });
  assert.deepEqual(result.rows, [['a', 'b', 'c'], ['1', '-', '-'], ['']]);
  assert.equal(result.changedCells, 2);
});

test('remove empty rows keeps protected rows; duplicates honour the column scope', () => {
  const kept = applyDataTool([[''], ['x'], ['']], { action: 'removeEmptyRows' }, { protectedRows: [0] });
  assert.deepEqual(kept.rows, [[''], ['x']]);
  const dupes = applyDataTool([['id', 'v'], ['1', 'a'], ['1', 'b'], ['2', 'a']], { action: 'removeDuplicates', columns: [0] }, { protectedRows: [0] });
  assert.deepEqual(dupes.rows, [['id', 'v'], ['1', 'a'], ['2', 'a']]);
});

test('validation compares rows with the typical width and skips hidden rows', () => {
  const rows = [['meta'], ['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6', '7'], ['8', '9', '10']];
  const issues = validateCsvRows(rows, true, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].row, 3);
  assert.equal(issues[0].expected, 3);
  assert.equal(issues[0].actual, 4);
});

test('all-text CSVs are recognised as having a header', () => {
  const header = CsvEditorProvider.__test.getEffectiveHeader([['name', 'city'], ['Alice', 'Tokyo'], ['Bob', 'Osaka']], 0);
  assert.equal(header, true);
  // A first row that repeats as data is not a header.
  const noHeader = CsvEditorProvider.__test.getEffectiveHeader([['Alice', 'Tokyo'], ['Bob', 'Osaka'], ['Alice', 'Kyoto']], 0);
  assert.equal(noHeader, false);
});

test('English and Japanese UI strings cover the same keys and placeholders', () => {
  const en = getWebviewStrings('en') as Record<string, string>;
  const ja = getWebviewStrings('ja-JP') as Record<string, string>;
  assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    const vars = (s: string) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(vars(ja[key]), vars(en[key]), key);
  }
  assert.equal(formatString('{a} of {b}', { a: 1, b: 2 }), '1 of 2');
  // Every t('key') used by the webview exists.
  for (const match of webview.matchAll(/\bt\('(\w+)'/g)) {
    assert.ok(match[1] in en, `missing string ${match[1]}`);
  }
  for (const match of provider.matchAll(/(?:esc\(|format\()s\.(\w+)/g)) {
    assert.ok(match[1] in en, `missing string ${match[1]}`);
  }
});

test('new webview messages are validated', () => {
  assert.ok(parseWebviewMessage({ type: 'clearAll', filter: 'x' }));
  assert.ok(parseWebviewMessage({ type: 'pasteFromClipboard', anchorRow: 1, anchorCol: 0 }));
  for (const type of ['toggleHeader', 'toggleSerialIndex', 'changeSeparator']) {
    assert.ok(parseWebviewMessage({ type }), type);
  }
  assert.equal(parseWebviewMessage({ type: 'pasteFromClipboard', anchorRow: -1, anchorCol: 0 }), undefined);
});

test('webview keyboard model covers spreadsheet essentials', () => {
  assert.ok(webview.includes("e.key === 'F2'"), 'F2 edits');
  assert.ok(webview.includes("key === 'x'"), 'Ctrl+X cuts');
  assert.ok(webview.includes("key === 'PageDown' || key === 'PageUp'"), 'paging');
  assert.ok(webview.includes("if (ctrl) return false;"), 'Ctrl+PageUp/Down stay with VS Code');
  // IME composition must start editing without preventDefault.
  assert.ok(webview.includes("const isImeKey = e => e.isComposing || e.key === 'Process' || e.keyCode === 229;"));
  assert.ok(webview.includes("editCell(cell, undefined, 'quick', { keepCaret: true });"));
  // Delete clears a selection with one batched message (one undo step).
  assert.match(webview, /const clearSelectedCells = \(\) => \{[\s\S]*?type: 'replaceCells'/);
});
