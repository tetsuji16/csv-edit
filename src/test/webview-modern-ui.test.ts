import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const provider = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'CsvEditorProvider.ts'), 'utf8');
const webview = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');

test('modern toolbar exposes view, theme, tools and validation controls', () => {
  for (const id of ['viewTextButton', 'toolbarFind', 'toolbarFilter', 'toolbarTools', 'toolbarValidate', 'toolbarTheme']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
});

test('bulk data tools use preview and explicit apply messages', () => {
  assert.match(webview, /type: 'previewDataTool'/);
  assert.match(webview, /type: 'applyDataTool'/);
  assert.match(webview, /window\.confirm/);
});

test('validation output is built with textContent instead of untrusted HTML', () => {
  assert.match(webview, /message\.type === 'validationResult'/);
  assert.match(webview, /item\.textContent = String/);
});
