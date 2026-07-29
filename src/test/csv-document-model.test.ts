import assert from 'node:assert/strict';
import test from 'node:test';
import { CsvDocumentModel } from '../csv-document-model';

test('preserves BOM and CRLF across a model round trip', () => {
  const model = new CsvDocumentModel();
  const snapshot = model.read(1, '\ufeffa,b\r\n1,2', ',');
  assert.equal(snapshot.hasBom, true);
  assert.equal(snapshot.lineEnding, '\r\n');
  assert.equal(model.serialize(snapshot.rows, snapshot), '\ufeffa,b\r\n1,2');
});

test('returns a stable cached snapshot for an unchanged document', () => {
  const model = new CsvDocumentModel();
  assert.equal(model.read(1, 'a,b', ','), model.read(1, 'a,b', ','));
  assert.notEqual(model.read(2, 'a,b', ','), model.read(1, 'a,b', ','));
});
