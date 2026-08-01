import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const provider = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'CsvEditorProvider.ts'), 'utf8');
const webview = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');
const stylesheet = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'editor.css'), 'utf8');

test('spreadsheet ribbon exposes view, theme, editing and data controls', () => {
  for (const id of ['viewTextButton', 'toolbarFind', 'toolbarFilter', 'toolbarTools', 'toolbarValidate', 'toolbarTheme']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
  for (const tab of ['home', 'data', 'view']) {
    assert.match(provider, new RegExp(`data-ribbon-tab="${tab}"`));
    assert.match(provider, new RegExp(`data-ribbon-panel="${tab}"`));
  }
  for (const id of ['ribbonAddRow', 'ribbonAddColumn', 'ribbonDeleteRow', 'ribbonDeleteColumn']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
});

test('spreadsheet shell includes an editable formula bar and worksheet headers', () => {
  for (const id of ['formulaNameBox', 'formulaInput', 'formulaCancel', 'formulaApply']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
  assert.match(provider, /media', 'editor\.css'/);
  assert.match(webview, /installWorksheetHeaders/);
  assert.match(webview, /sheet-column-letters/);
  assert.match(webview, /type: 'editCell', row: formulaTarget\.row/);
});

test('spreadsheet styling provides ribbon, formula bar, row headers and active-cell affordance', () => {
  for (const selector of ['.csv-app-shell', '.ribbon-tabs', '.ribbon-panel', '.formula-bar', '.sheet-column-letters', '.active-cell']) {
    assert.match(stylesheet, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(stylesheet, /--sheet-accent:\s*#107c41/);
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
