import assert from 'node:assert/strict';
import test from 'node:test';
import { CsvDocumentModel } from '../csv-document-model';

test('preserves BOM and CRLF across a model round trip', () => {
  const model = new CsvDocumentModel();
  const snapshot = model.read(1, '﻿a,b\r\n1,2', ',');
  assert.equal(snapshot.hasBom, true);
  assert.equal(snapshot.lineEnding, '\r\n');
  assert.equal(model.serialize(snapshot.rows, snapshot), '﻿a,b\r\n1,2');
});

test('returns a stable cached snapshot for an unchanged document', () => {
  const model = new CsvDocumentModel();
  assert.equal(model.read(1, 'a,b', ','), model.read(1, 'a,b', ','));
  assert.notEqual(model.read(2, 'a,b', ','), model.read(1, 'a,b', ','));
});

test('cache is keyed by version+delimiter and does not retain document text', () => {
  const model = new CsvDocumentModel();
  const a = model.read(1, 'a,b,c', ',');
  // A different string instance with the same version+delimiter must still hit
  // the cache (the model must not hold the full text, so memory stays O(1) per
  // document regardless of file size).
  const b = model.read(1, 'a,b,c', ',');
  assert.equal(a, b);
  // Changing the delimiter forces a re-parse even at the same version.
  const c = model.read(1, 'a\tb\tc', '\t');
  assert.notEqual(a, c);
  assert.deepEqual(c.rows, [['a', 'b', 'c']]);
  // The cache entry must not carry a `text` field (would double memory on huge files).
  const cached = (model as unknown as { cached?: { text?: unknown } }).cached;
  assert.ok(cached && !('text' in cached), 'cached snapshot must not retain document text');
});
