import assert from 'node:assert/strict';
import test from 'node:test';
import Papa from 'papaparse';
import { buildCopyAllRows, rowMatchesQuickFilter, rowsToClipboardTsv } from '../clipboard-tsv';

test('rowsToClipboardTsv quotes only fields that need it and round-trips', () => {
  const rows = [['a,b', 'tab\there', '"q"'], ['multi\r\nline', '', 'tail  ']];
  const text = rowsToClipboardTsv(rows);
  assert.equal(text.split('\n')[0], 'a,b\t"tab\there"\t"""q"""');
  assert.deepEqual(Papa.parse(text, { delimiter: '\t' }).data, rows);
});

test('rowMatchesQuickFilter is a case-insensitive substring match', () => {
  assert.ok(rowMatchesQuickFilter(['Alice', 'Tokyo'], 'TOK'));
  assert.ok(rowMatchesQuickFilter(['x'], ''));
  assert.ok(!rowMatchesQuickFilter(['Bob', 'Osaka'], 'tok'));
});

test('buildCopyAllRows skips preamble rows, pads ragged rows, and filters only the body', () => {
  const data = [['# preamble'], ['name', 'city'], ['Alice', 'Tokyo'], ['Bob'], ['Carol', 'Kyoto']];
  assert.deepEqual(buildCopyAllRows(data, 1, true, ''), [['name', 'city'], ['Alice', 'Tokyo'], ['Bob', ''], ['Carol', 'Kyoto']]);
  assert.deepEqual(buildCopyAllRows(data, 1, true, 'kyo'), [['name', 'city'], ['Alice', 'Tokyo'], ['Carol', 'Kyoto']]);
  assert.deepEqual(buildCopyAllRows(data, 1, false, 'name'), [['name', 'city']]);
  assert.deepEqual(buildCopyAllRows([], 0, true, ''), []);
});
