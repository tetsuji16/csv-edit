import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebviewMessage } from '../webview-protocol';

test('accepts valid messages and strips unknown fields', () => {
  const message = parseWebviewMessage({ type: 'editCell', row: 1, col: 2, value: 'x', unsafe: true });
  assert.deepEqual(message, { type: 'editCell', row: 1, col: 2, value: 'x' });
});

test('rejects invalid coordinates and unknown message types', () => {
  assert.equal(parseWebviewMessage({ type: 'editCell', row: -1, col: 0, value: 'x' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'executeCode', code: 'oops' }), undefined);
});
