import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const provider = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'CsvEditorProvider.ts'), 'utf8');
const webview = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'main.js'), 'utf8');
const stylesheet = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'editor.css'), 'utf8');

test('compact command bar exposes focused CSV editing controls', () => {
  for (const id of ['viewTextButton', 'toolbarFind', 'toolbarFilter', 'toolbarTools', 'toolbarValidate', 'toolbarTheme']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
  for (const id of ['ribbonAddRow', 'ribbonAddColumn', 'ribbonDeleteRow', 'ribbonDeleteColumn']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
  assert.match(provider, /class="csv-commandbar"/);
  assert.match(provider, /class="command-overflow"/);
  assert.doesNotMatch(provider, /sheet-titlebar|data-ribbon-tab|data-ribbon-panel/);
});

test('compact shell includes an editable selected-cell bar without spreadsheet chrome', () => {
  for (const id of ['formulaNameBox', 'formulaInput', 'formulaCancel', 'formulaApply']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
  assert.match(provider, /media', 'editor\.css'/);
  assert.match(provider, /data-rowcount=/);
  assert.match(provider, /data-columncount=/);
  assert.doesNotMatch(webview, /installWorksheetHeaders|sheet-column-letters|toColumnLabel/);
  assert.match(webview, /type: 'editCell', row: formulaTarget\.row/);
});

test('VS Code styling maximizes grid space and uses workbench theme tokens', () => {
  for (const selector of ['.csv-workbench', '.csv-commandbar', '.command-menu', '.cell-bar', '.active-cell']) {
    assert.match(stylesheet, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(stylesheet, /grid-template-rows:\s*32px 30px minmax\(0, 1fr\) 22px/);
  assert.match(provider, /--vscode-editor-background/);
  assert.match(provider, /--vscode-focusBorder/);
  assert.match(stylesheet, /--vscode-editor-selectionBackground/);
  assert.doesNotMatch(stylesheet, /#217346|--sheet-titlebar|--sheet-accent/);
});

test('status updates use document metadata rather than scanning every rendered cell', () => {
  assert.match(webview, /root\?\.dataset\?\.rowcount/);
  assert.match(webview, /root\?\.dataset\?\.columncount/);
  assert.doesNotMatch(webview, /new Set\(Array\.from\(table\.querySelectorAll\('\[data-row\]'\)\)/);
});

test('CSS lives in media/editor.css, not duplicated in the provider <style>', () => {
  // The provider <style> must only carry build-time values (theme tokens, font,
  // cell padding, per-column colors). Layout/visual rules belong exclusively in
  // media/editor.css so there is a single source of truth and no drift.
  const deadClasses = ['.csv-toolbar', '.csv-status', '.csv-panel', '#findReplaceWidget'];
  for (const sel of deadClasses) {
    assert.doesNotMatch(provider, new RegExp(`${sel.replace(/[.#]/g, '\\$&')}\\s*\\{`), `provider <style> must not define ${sel}`);
  }
  // The shipped stylesheet must own every visual rule the markup relies on.
  for (const sel of ['.csv-link', '.highlight', '.active-match', '#contextMenu', '#findReplaceWidget .fr-input', '#findReplaceWidget .fr-toggle-btn']) {
    assert.match(stylesheet, new RegExp(sel.replace(/[.#]/g, '\\$&')), `editor.css must define ${sel}`);
  }
  // cellPadding must actually reach the stylesheet via a CSS variable.
  assert.match(provider, /--csv-cell-padding:\s*\$\{cellPadding\}px/);
  assert.match(stylesheet, /var\(--csv-cell-padding, 2px\)/);
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
