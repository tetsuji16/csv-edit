import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDataTool, validateCsvRows } from '../data-tools';

test('bulk text tools only change selected columns and report samples', () => {
  const result = applyDataTool([[' a ', ' b '], [' c ', 'd']], { action: 'trim', columns: [0] });
  assert.deepEqual(result.rows, [['a', ' b '], ['c', 'd']]);
  assert.equal(result.changedCells, 2);
  assert.equal(result.samples.length, 2);
});

test('duplicate removal preserves header and first data occurrence', () => {
  const result = applyDataTool(
    [['id'], ['1'], ['1'], ['2']],
    { action: 'removeDuplicates' },
    { duplicateExemptRows: [0] }
  );
  assert.deepEqual(result.rows, [['id'], ['1'], ['2']]);
  assert.equal(result.removedRows, 1);
});

test('duplicate removal includes the first row when there is no header', () => {
  const result = applyDataTool([['1'], ['1'], ['2']], { action: 'removeDuplicates' });
  assert.deepEqual(result.rows, [['1'], ['2']]);
  assert.equal(result.removedRows, 1);
});

test('duplicate removal can exempt a header after hidden preamble rows', () => {
  const result = applyDataTool(
    [['1'], ['id'], ['1'], ['1']],
    { action: 'removeDuplicates' },
    { duplicateExemptRows: [0, 1] }
  );
  assert.deepEqual(result.rows, [['1'], ['id'], ['1']]);
  assert.equal(result.removedRows, 1);
});

test('validation finds ragged rows and header problems', () => {
  const issues = validateCsvRows([['', 'Name', 'name'], ['1', 'Alice']], true);
  assert.deepEqual(issues.map(issue => issue.code), ['ragged-row', 'empty-header', 'duplicate-header']);
});
