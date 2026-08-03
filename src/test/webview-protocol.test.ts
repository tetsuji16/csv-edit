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

test('rejects astronomically large index (DoS guard)', () => {
  // A huge index must be rejected at the protocol boundary so the editor never
  // attempts to trailing-fill/splice that many empty rows/columns.
  assert.equal(
    parseWebviewMessage({ type: 'insertRow', index: 1e15 }),
    undefined
  );
  assert.equal(
    parseWebviewMessage({ type: 'deleteColumn', index: Number.MAX_SAFE_INTEGER }),
    undefined
  );
});

test('rejects oversized paste text (resource-exhaustion guard)', () => {
  const huge = 'a'.repeat(100_000_001);
  assert.equal(
    parseWebviewMessage({ type: 'pasteCells', text: huge, anchorRow: 0, anchorCol: 0 }),
    undefined
  );
});

test('accepts a realistic (in-bounds) index', () => {
  const msg = parseWebviewMessage({ type: 'insertRow', index: 5 });
  assert.deepEqual(msg, { type: 'insertRow', index: 5 });
});
