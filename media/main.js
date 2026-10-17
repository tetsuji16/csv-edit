// Webview script moved out of inline <script>. Kept logic changes minimal.

document.body.setAttribute('tabindex', '0');
try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }

const vscode = acquireVsCodeApi();

const root = document.getElementById('csv-root');
// Localized UI strings serialized by the extension (see src/webview-i18n.ts).
let STRINGS = {};
try { STRINGS = JSON.parse(document.getElementById('__csvStrings')?.textContent || '{}'); } catch { STRINGS = {}; }
const t = (key, vars = {}) => String(STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
const CSV_SEPARATOR = String.fromCodePoint(parseInt(root?.dataset?.sepcode || '44', 10)); // default ','
const parsePositiveNumber = value => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const configuredFontSizePx = parsePositiveNumber(root?.dataset?.fontsize);
const computedFontSizePx = parsePositiveNumber(window.getComputedStyle(document.body).fontSize);
const BASE_FONT_SIZE_PX = configuredFontSizePx ?? computedFontSizePx ?? 14;
const MOUSE_WHEEL_ZOOM_ENABLED = root?.dataset?.wheelzoomenabled !== '0';
const MOUSE_WHEEL_ZOOM_INVERTED = root?.dataset?.wheelzoominvert === '1';
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
let zoomScale = 1;
const getMinRowHeight = () => Math.max(22, Math.round(BASE_FONT_SIZE_PX * zoomScale * 1.6));

let isUpdating = false, isSelecting = false, anchorCell = null, rangeEndCell = null, currentSelection = [];
let startCell = null, endCell = null, selectionMode = "cell";
let sheetColumnAnchor = null;
let editingCell = null, originalCellValue = "";
// Edit mode:
//  - 'quick': started by typing a character (not Enter)
//  - 'detail': started by Enter or double-click
let editMode = null; // 'quick' | 'detail' | null
const DRAG_THRESHOLD_PX = 4;
const RESIZE_HANDLE_PX = 6;
let resizeState = null;
let reorderState = null;

const table = document.querySelector('#csv-root table');
const scrollContainer = document.querySelector('.table-container');
const csvPanel = document.getElementById('csvPanel');
const csvPanelTitle = document.getElementById('csvPanelTitle');
const panelBody = document.getElementById('panelBody');
const selectionStatus = document.getElementById('selectionStatus');
const aggregateStatus = document.getElementById('aggregateStatus');
const sizeStatus = document.getElementById('sizeStatus');
const visibleStatus = document.getElementById('visibleStatus');
const toastStatus = document.getElementById('toastStatus');
const zoomStatus = document.getElementById('zoomStatus');
const formulaNameBox = document.getElementById('formulaNameBox');
const formulaInput = document.getElementById('formulaInput');
const formulaApply = document.getElementById('formulaApply');
const formulaCancel = document.getElementById('formulaCancel');
const filterButton = document.getElementById('toolbarFilter');
const formulaMore = document.getElementById('formulaMore');
const updateFormulaMore = () => {
  if (!formulaMore || !formulaInput) return;
  const extra = formulaInput.value.split('\n').length - 1;
  formulaMore.textContent = extra > 0 && !formulaInput.classList.contains('expanded') ? `+${extra}` : '';
};
// Grow the value bar over the grid while editing a multi-line value.
const expandFormulaInput = () => {
  if (!formulaInput) return;
  formulaInput.classList.add('expanded');
  formulaInput.style.height = 'auto';
  formulaInput.style.height = `${Math.min(formulaInput.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
  updateFormulaMore();
};
const collapseFormulaInput = () => {
  if (!formulaInput) return;
  formulaInput.classList.remove('expanded');
  formulaInput.style.height = '';
  updateFormulaMore();
};
let formulaTarget = null;
let formulaOriginalValue = '';
let formulaDirty = false;

const DATA_ROW_COUNT = Number.parseInt(root?.dataset?.datarowcount || '0', 10) || 0;
const COLUMN_COUNT = Number.parseInt(root?.dataset?.columncount || '0', 10) || 0;
// Absolute document row of the first body (non-header) row. Cell addresses and
// navigation use it so the UI numbers rows exactly like the row-number column.
const HEADER_ROW = (() => {
  const th = table?.querySelector('thead th[data-row]');
  return th ? Number.parseInt(th.getAttribute('data-row') || '', 10) : null;
})();
const FIRST_BODY_ROW = (() => {
  if (Number.isInteger(HEADER_ROW)) return HEADER_ROW + 1;
  const td = table?.querySelector('tbody td[data-row]');
  return td ? Number.parseInt(td.getAttribute('data-row') || '0', 10) : 0;
})();
const LAST_BODY_ROW = FIRST_BODY_ROW + Math.max(0, DATA_ROW_COUNT - 1);

// UI state that must survive the full re-render after structural edits.
const readUiState = () => {
  try { return (vscode.getState() || {}).ui || {}; } catch { return {}; }
};
const writeUiState = patch => {
  try {
    const st = vscode.getState() || {};
    vscode.setState({ ...st, ui: { ...(st.ui || {}), ...patch } });
  } catch {}
};

let toastTimer = null;
const showToast = message => {
  if (!toastStatus) return;
  toastStatus.textContent = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastStatus.textContent = ''; }, 2500);
};

const isDataCell = cell => {
  if (!cell?.getAttribute) return false;
  const row = Number.parseInt(cell.getAttribute('data-row') || '', 10);
  const col = Number.parseInt(cell.getAttribute('data-col') || '', 10);
  return Number.isInteger(row) && Number.isInteger(col) && col >= 0;
};

const getActiveDataCell = () => [anchorCell, ...currentSelection].find(isDataCell) || null;

const getColumnName = col => {
  const th = table?.querySelector(`thead th[data-col="${col}"]`);
  const name = th ? (th.textContent || '').trim() : '';
  return name || `#${col + 1}`;
};
const getRowLabel = row => (row === HEADER_ROW ? t('header') : String(row - FIRST_BODY_ROW + 1));

const syncFormulaBar = () => {
  const active = getActiveDataCell();
  table?.querySelectorAll('.active-cell').forEach(cell => cell.classList.remove('active-cell'));
  if (!active) {
    formulaTarget = null;
    if (formulaNameBox && document.activeElement !== formulaNameBox) formulaNameBox.value = '';
    if (formulaInput && document.activeElement !== formulaInput) formulaInput.value = '';
    updateFormulaMore();
    return;
  }
  active.classList.add('active-cell');
  const row = Number.parseInt(active.getAttribute('data-row') || '0', 10);
  const col = Number.parseInt(active.getAttribute('data-col') || '0', 10);
  formulaTarget = { row, col, cell: active };
  // textContent keeps newlines/spaces that innerText collapses in nowrap headers.
  formulaOriginalValue = active.textContent || '';
  if (formulaNameBox && document.activeElement !== formulaNameBox) {
    formulaNameBox.value = `${getRowLabel(row)} · ${getColumnName(col)}`;
  }
  if (formulaInput && document.activeElement !== formulaInput) {
    formulaInput.value = formulaOriginalValue;
    formulaDirty = false;
  }
  updateFormulaMore();
};

// Sum / average / count of numeric values in the (rendered) selection.
const parseNumericCell = text => {
  const value = String(text || '').trim().replace(/,(?=\d{3}(\D|$))/g, '');
  if (!value || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(value)) return null;
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
};
const formatAggregate = value => {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const updateAggregates = () => {
  if (!aggregateStatus) return;
  const cells = currentSelection.filter(cell => isDataCell(cell) && cell.tagName !== 'TH' && cell.closest('tr')?.style.display !== 'none');
  if (cells.length < 2 || cells.length > 200000) {
    aggregateStatus.textContent = '';
    return;
  }
  let sum = 0;
  let count = 0;
  for (const cell of cells) {
    const num = parseNumericCell(cell.textContent);
    if (num === null) continue;
    sum += num;
    count++;
  }
  aggregateStatus.textContent = count
    ? `${t('sum')} ${formatAggregate(sum)}  ${t('average')} ${formatAggregate(sum / count)}  ${t('count')} ${count}`
    : '';
};

const updateModernStatus = () => {
  syncFormulaBar();
  if (selectionStatus) {
    const active = getActiveDataCell();
    const address = active ? `${getRowLabel(Number(active.getAttribute('data-row')))} · ${getColumnName(Number(active.getAttribute('data-col')))}` : '';
    const count = currentSelection.filter(isDataCell).length;
    selectionStatus.textContent = count > 1
      ? `${address}${address ? '  ·  ' : ''}${t('selectedCount', { n: count })}`
      : (address || t('noSelection'));
  }
  updateAggregates();
  if (sizeStatus) sizeStatus.textContent = t('rowsColumns', { rows: DATA_ROW_COUNT, cols: COLUMN_COUNT });
  if (zoomStatus) zoomStatus.textContent = `${Math.round(zoomScale * 100)}%`;
};
let statusUpdateQueued = false;
const queueModernStatusUpdate = () => {
  if (statusUpdateQueued) return;
  statusUpdateQueued = true;
  window.requestAnimationFrame(() => {
    statusUpdateQueued = false;
    updateModernStatus();
  });
};

// ───────── Selection helpers shared by toolbar and context menu ─────────
// selectionKind distinguishes whole-row/whole-column selections from
// rectangles so row/column commands target what the user selected.
let selectionKind = 'cells';
const uniqueSorted = values => Array.from(new Set(values)).sort((a, b) => a - b);
const getSelectionRows = () => uniqueSorted(currentSelection
  .map(cell => Number.parseInt(cell.getAttribute?.('data-row') || 'NaN', 10))
  .filter(n => Number.isInteger(n) && n >= 0));
const getSelectionCols = () => uniqueSorted(currentSelection
  .map(cell => Number.parseInt(cell.getAttribute?.('data-col') || 'NaN', 10))
  .filter(n => Number.isInteger(n) && n >= 0));
const getTargetRows = fallbackRow => {
  if (selectionKind === 'columns' || selectionKind === 'all') {
    return Number.isInteger(fallbackRow) && fallbackRow >= 0 ? [fallbackRow] : [];
  }
  const rows = getSelectionRows();
  if (Number.isInteger(fallbackRow) && fallbackRow >= 0 && !rows.includes(fallbackRow)) return [fallbackRow];
  return rows;
};
const getTargetCols = fallbackCol => {
  if (selectionKind === 'rows' || selectionKind === 'all') {
    return Number.isInteger(fallbackCol) && fallbackCol >= 0 ? [fallbackCol] : [];
  }
  const cols = getSelectionCols();
  if (Number.isInteger(fallbackCol) && fallbackCol >= 0 && !cols.includes(fallbackCol)) return [fallbackCol];
  return cols;
};
const postInsertRows = (rows, below) => {
  if (!rows.length) {
    vscode.postMessage({ type: 'insertRows', index: LAST_BODY_ROW + (DATA_ROW_COUNT ? 1 : 0), count: 1 });
    return;
  }
  const index = below ? rows[rows.length - 1] + 1 : rows[0];
  vscode.postMessage({ type: 'insertRows', index, count: rows.length });
};
const postInsertCols = (cols, right) => {
  if (!cols.length) {
    vscode.postMessage({ type: 'insertColumns', index: COLUMN_COUNT, count: 1 });
    return;
  }
  const index = right ? cols[cols.length - 1] + 1 : cols[0];
  vscode.postMessage({ type: 'insertColumns', index, count: cols.length });
};
const postDeleteRows = rows => {
  if (!rows.length) return;
  if (rows.length === 1) vscode.postMessage({ type: 'deleteRow', index: rows[0] });
  else vscode.postMessage({ type: 'deleteRows', indices: rows });
};
const postDeleteCols = cols => {
  if (!cols.length) return;
  if (cols.length === 1) vscode.postMessage({ type: 'deleteColumn', index: cols[0] });
  else vscode.postMessage({ type: 'deleteColumns', indices: cols });
};

// ───────── Side panel (filter / clean & transform / validation) ─────────
let activePanel = null;
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  children.forEach(child => child && node.appendChild(child));
  return node;
};
const closePanel = () => {
  if (!csvPanel) return;
  csvPanel.classList.remove('open');
  document.body.classList.remove('panel-open');
  activePanel = null;
  writeUiState({ panel: null });
  const focusTarget = anchorCell && anchorCell.isConnected ? anchorCell : document.body;
  try { focusTarget.focus({ preventScroll: true }); } catch {}
};
const openPanel = (kind, title) => {
  if (!csvPanel || !panelBody) return;
  activePanel = kind;
  csvPanelTitle.textContent = title;
  panelBody.replaceChildren();
  csvPanel.classList.add('open');
  document.body.classList.add('panel-open');
  writeUiState({ panel: kind });
};
document.getElementById('csvPanelClose')?.addEventListener('click', closePanel);
csvPanel?.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    closePanel();
  }
});

// Quick filter. Matching uses data cells only (not the serial index) so the
// extension-side "copy all" can apply the same rule to unloaded rows.
let quickFilterQuery = String(readUiState().filter || '');
const countLoadedBodyRows = () => table.querySelectorAll('tbody tr').length;
const applyQuickFilter = () => {
  const query = quickFilterQuery.toLocaleLowerCase();
  let shown = 0;
  let total = 0;
  table.querySelectorAll('tbody tr').forEach(row => {
    const cells = Array.from(row.querySelectorAll('td[data-col]')).filter(cell => cell.getAttribute('data-col') !== '-1');
    const text = cells.map(cell => cell.textContent).join('');
    const isVirtual = cells.every(cell => Number(cell.getAttribute('data-row')) > LAST_BODY_ROW || !DATA_ROW_COUNT);
    if (!isVirtual) total++;
    // The trailing virtual row stays visible only while no filter is active.
    const visible = !query || (!isVirtual && text.toLocaleLowerCase().includes(query));
    row.style.display = visible ? '' : 'none';
    if (visible) shown++;
  });
  const count = document.getElementById('quickFilterCount');
  if (count) count.textContent = t('filterCount', { shown, total });
  if (visibleStatus) visibleStatus.textContent = query ? t('visibleRows', { n: shown }) : '';
  filterButton?.setAttribute('aria-pressed', query ? 'true' : 'false');
  updateModernStatus();
};
const setQuickFilter = value => {
  quickFilterQuery = value;
  writeUiState({ filter: value });
  applyQuickFilter();
};
// Rows appended by chunk loading must honour an active filter too.
window.addEventListener('csvChunkLoaded', () => { if (quickFilterQuery) applyQuickFilter(); });

const showFilterPanel = (focus = true) => {
  openPanel('filter', t('filterPanel'));
  const input = el('input', { id: 'quickFilterInput', type: 'search', placeholder: t('filterPlaceholder'), 'aria-label': t('filterPanel') });
  input.value = quickFilterQuery;
  let debounce = null;
  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => setQuickFilter(input.value), 120);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounce) clearTimeout(debounce);
      setQuickFilter(input.value);
    }
  });
  panelBody.append(
    el('p', {}, [input]),
    el('p', { id: 'quickFilterCount', class: 'panel-hint' }),
    el('p', { class: 'panel-hint', text: t('filterHint') }),
    el('div', { class: 'button-row' }, [
      el('button', { type: 'button', class: 'secondary-button', text: t('filterClear'), onclick: () => { input.value = ''; setQuickFilter(''); input.focus(); } })
    ])
  );
  applyQuickFilter();
  if (focus) {
    try { input.focus(); input.select(); } catch {}
  }
};

// Clean & transform: choose a tool, preview the effect, then apply.
const DATA_TOOLS = [
  ['trim', 'toolTrim'],
  ['uppercase', 'toolUppercase'],
  ['lowercase', 'toolLowercase'],
  ['fillEmpty', 'toolFillEmpty'],
  ['removeEmptyRows', 'toolRemoveEmptyRows'],
  ['removeDuplicates', 'toolRemoveDuplicates']
];
let pendingToolRequest = null;
const showToolsPanel = (notice = '') => {
  openPanel('tools', t('toolsPanel'));
  pendingToolRequest = null;
  const selectedCols = selectionKind === 'all' ? [] : getSelectionCols();
  const scope = el('select', { id: 'toolScope', 'aria-label': t('toolScope') }, [
    el('option', { value: 'all', text: t('scopeAll') }),
    selectedCols.length && selectedCols.length < COLUMN_COUNT
      ? el('option', { value: 'selected', text: t('scopeSelected', { cols: selectedCols.map(getColumnName).join(', ') }) })
      : null
  ]);
  // Default to the selection only when the user deliberately selected a
  // column or a range; a single active cell keeps the whole-table default.
  const deliberate = selectionKind === 'columns' || currentSelection.filter(isDataCell).length > 1;
  if (deliberate && selectedCols.length && selectedCols.length < COLUMN_COUNT) scope.value = 'selected';
  const fillInput = el('input', { id: 'fillValueInput', type: 'text', placeholder: t('fillValue'), 'aria-label': t('fillValue') });
  const fillField = el('div', {}, [
    el('label', { class: 'panel-field' }, [el('span', { text: t('fillValue') }), fillInput]),
    el('div', { class: 'button-row' }, [
      el('button', { type: 'button', class: 'secondary-button', text: t('preview'), onclick: () => requestPreview() })
    ])
  ]);
  fillField.style.display = 'none';
  const result = el('div', { id: 'toolResult', 'aria-live': 'polite' });
  if (notice) result.append(el('p', { class: 'status-ok', text: notice }));
  let action = null;
  const buttons = DATA_TOOLS.map(([id, label]) => el('button', {
    type: 'button',
    'data-tool': id,
    'aria-pressed': 'false',
    text: t(label),
    onclick: () => {
      action = id;
      buttons.forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false'));
      fillField.style.display = id === 'fillEmpty' ? '' : 'none';
      if (id === 'fillEmpty') {
        result.replaceChildren();
        fillInput.focus();
        return;
      }
      requestPreview();
    }
  }));
  const requestPreview = () => {
    if (!action) return;
    const request = { action };
    if (scope.value === 'selected') request.columns = selectedCols;
    if (action === 'fillEmpty') request.value = fillInput.value;
    pendingToolRequest = request;
    result.replaceChildren(el('p', { class: 'panel-hint', text: t('previewing') }));
    vscode.postMessage({ type: 'previewDataTool', request });
  };
  scope.addEventListener('change', requestPreview);
  fillInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); requestPreview(); }
  });
  fillInput.addEventListener('input', () => { if (action === 'fillEmpty') result.replaceChildren(); });
  panelBody.append(
    el('p', { class: 'panel-hint', text: t('toolsIntro') }),
    el('label', { class: 'panel-field' }, [el('span', { text: t('toolScope') }), scope]),
    el('div', { class: 'tool-list', role: 'group' }, buttons),
    fillField,
    result
  );
  buttons[0]?.focus();
};
const renderToolPreview = message => {
  const result = document.getElementById('toolResult');
  if (!result || activePanel !== 'tools') return;
  const changed = Number(message.changedCells) || 0;
  const removed = Number(message.removedRows) || 0;
  result.replaceChildren();
  if (!changed && !removed) {
    result.append(el('p', { text: t('previewNothing') }));
    return;
  }
  result.append(el('p', { text: t('previewSummary', { cells: changed, rows: removed }) }));
  const samples = Array.isArray(message.samples) ? message.samples : [];
  if (samples.length) {
    const list = el('ul', { class: 'preview-list' });
    samples.forEach(sample => {
      const row = Number(sample.row);
      const col = Number(sample.col);
      list.append(el('li', {}, [
        el('span', { class: 'cell-ref', text: `${getRowLabel(row)} · ${getColumnName(col)}` }),
        el('del', { text: String(sample.before ?? '') || '∅' }),
        document.createTextNode(' → '),
        el('ins', { text: String(sample.after ?? '') || '∅' })
      ]));
    });
    if (changed > samples.length) list.append(el('li', { class: 'panel-hint', text: t('previewMore', { n: changed - samples.length }) }));
    result.append(list);
  }
  const request = message.request || pendingToolRequest;
  result.append(el('div', { class: 'button-row' }, [
    el('button', {
      type: 'button',
      class: 'primary-button',
      text: t('apply'),
      onclick: () => {
        writeUiState({ notice: t('applied') });
        vscode.postMessage({ type: 'applyDataTool', request });
      }
    }),
    el('button', { type: 'button', class: 'secondary-button', text: t('cancel'), onclick: () => result.replaceChildren() })
  ]));
};

// Validation: list issues; clicking one selects the offending cell.
const showValidatePanel = () => {
  openPanel('validate', t('validatePanel'));
  panelBody.append(el('p', { class: 'panel-hint', text: t('validating') }));
  vscode.postMessage({ type: 'validateData' });
};
const describeIssue = issue => {
  const row = Number(issue.row);
  const col = Number(issue.col);
  if (issue.code === 'ragged-row') {
    const label = row === HEADER_ROW ? t('headerRowLabel') : t('rowLabel', { n: row - FIRST_BODY_ROW + 1 });
    return t('issueRagged', { row: label, actual: issue.actual ?? '?', expected: issue.expected ?? '?' });
  }
  if (issue.code === 'empty-header') return t('issueEmptyHeader', { col: col + 1 });
  if (issue.code === 'duplicate-header') return t('issueDuplicateHeader', { name: issue.name ?? '', col: col + 1 });
  return String(issue.message || '');
};
const renderValidation = issues => {
  if (activePanel !== 'validate' || !panelBody) return;
  panelBody.replaceChildren();
  if (!issues.length) {
    panelBody.append(el('p', { class: 'status-ok', text: t('validationOk') }));
  } else {
    panelBody.append(el('p', { text: t('validationIssues', { n: issues.length }) }));
    const list = el('ul', { class: 'issue-list' });
    issues.slice(0, 500).forEach(issue => {
      list.append(el('li', {}, [el('button', {
        type: 'button',
        text: describeIssue(issue),
        onclick: () => {
          const row = Number(issue.row);
          const col = Math.max(0, Math.min(Number(issue.col), COLUMN_COUNT - 1));
          const cell = ensureRenderedCellByCoords(row, col);
          if (cell) {
            setSingleSelection(cell);
            updateModernStatus();
          }
        }
      })]));
    });
    if (issues.length > 500) list.append(el('li', { class: 'panel-hint', text: t('previewMore', { n: issues.length - 500 }) }));
    panelBody.append(list);
  }
  panelBody.append(el('div', { class: 'button-row' }, [
    el('button', { type: 'button', class: 'secondary-button', text: t('revalidate'), onclick: showValidatePanel })
  ]));
};

// ───────── Command bar ─────────
const commandOverflow = document.getElementById('commandOverflow');
const closeOverflow = () => { if (commandOverflow) commandOverflow.open = false; };
commandOverflow?.addEventListener('click', event => {
  if (event.target.closest('.command-menu button')) closeOverflow();
});
commandOverflow?.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeOverflow();
    commandOverflow.querySelector('summary')?.focus();
  }
});
document.addEventListener('mousedown', event => {
  if (commandOverflow?.open && !event.target.closest?.('#commandOverflow')) closeOverflow();
});
const onClick = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);
onClick('viewTextButton', () => vscode.postMessage({ type: 'openTextView' }));
onClick('undoButton', () => vscode.postMessage({ type: 'undo' }));
onClick('redoButton', () => vscode.postMessage({ type: 'redo' }));
onClick('toolbarFind', () => openFindReplace(false));
onClick('toolbarTools', () => (activePanel === 'tools' ? closePanel() : showToolsPanel()));
onClick('toolbarValidate', () => showValidatePanel());
onClick('toolbarFilter', () => (activePanel === 'filter' ? closePanel() : showFilterPanel()));
onClick('toolbarTheme', () => vscode.postMessage({ type: 'cycleTheme' }));
onClick('toggleHeaderButton', () => vscode.postMessage({ type: 'toggleHeader' }));
onClick('toggleSerialButton', () => vscode.postMessage({ type: 'toggleSerialIndex' }));
onClick('changeDelimiterButton', () => vscode.postMessage({ type: 'changeSeparator' }));
onClick('delimiterStatus', () => vscode.postMessage({ type: 'changeSeparator' }));
onClick('ribbonCopy', () => copySelectionToClipboard());
onClick('ribbonCut', () => cutSelection());
onClick('ribbonPaste', () => pasteFromExtensionClipboard());
onClick('ribbonClear', () => clearSelectedCells());
onClick('ribbonZoomOut', () => zoomOut());
onClick('ribbonZoomReset', () => resetZoom());
onClick('ribbonZoomIn', () => zoomIn());
onClick('ribbonAddRow', () => postInsertRows(getTargetRows().slice(-1), true));
onClick('ribbonAddColumn', () => postInsertCols(getTargetCols().slice(-1), true));
onClick('ribbonDeleteRow', () => postDeleteRows(getTargetRows()));
onClick('ribbonDeleteColumn', () => postDeleteCols(getTargetCols()));

// ───────── Value bar ─────────
const restoreFormulaValue = () => {
  if (formulaInput) formulaInput.value = formulaOriginalValue;
  formulaDirty = false;
  formulaInput?.blur();
  if (anchorCell?.isConnected) { try { anchorCell.focus({ preventScroll: true }); } catch {} }
};

const commitFormulaValue = () => {
  if (!formulaTarget || !formulaInput) return;
  const value = formulaInput.value;
  if (value !== formulaOriginalValue) {
    formulaTarget.cell.textContent = value;
    vscode.postMessage({ type: 'editCell', row: formulaTarget.row, col: formulaTarget.col, value });
    formulaOriginalValue = value;
  }
  formulaDirty = false;
  formulaInput.blur();
  if (formulaTarget.cell?.isConnected) { try { formulaTarget.cell.focus({ preventScroll: true }); } catch {} }
  updateModernStatus();
};

formulaInput?.addEventListener('focus', () => {
  formulaOriginalValue = formulaInput.value;
  formulaDirty = false;
  expandFormulaInput();
});
formulaInput?.addEventListener('input', () => { formulaDirty = true; expandFormulaInput(); });
formulaInput?.addEventListener('blur', event => {
  collapseFormulaInput();
  if (formulaDirty && event.relatedTarget !== formulaApply && event.relatedTarget !== formulaCancel) {
    commitFormulaValue();
  }
});
formulaInput?.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    restoreFormulaValue();
  } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    commitFormulaValue();
  } else if (event.key === 'Enter' && (event.shiftKey || event.altKey)) {
    // Insert a line break inside the value.
    event.preventDefault();
    const start = formulaInput.selectionStart;
    const end = formulaInput.selectionEnd;
    formulaInput.setRangeText('\n', start, end, 'end');
    formulaDirty = true;
    expandFormulaInput();
  }
});
formulaApply?.addEventListener('click', commitFormulaValue);
formulaCancel?.addEventListener('click', restoreFormulaValue);

// Name box: type "12" or "12,3" (row number as shown, optional column) to jump.
formulaNameBox?.addEventListener('focus', () => { try { formulaNameBox.select(); } catch {} });
formulaNameBox?.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    formulaNameBox.blur();
    syncFormulaBar();
    if (anchorCell?.isConnected) { try { anchorCell.focus({ preventScroll: true }); } catch {} }
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const match = /^\s*(\d+)\s*(?:[,:;\s]\s*(\d+))?\s*$/.exec(formulaNameBox.value);
  if (!match) return;
  const displayRow = Math.max(1, Number.parseInt(match[1], 10));
  const col = match[2] ? Math.max(0, Number.parseInt(match[2], 10) - 1) : (formulaTarget?.col ?? 0);
  const row = Math.min(FIRST_BODY_ROW + displayRow - 1, LAST_BODY_ROW + 1);
  const cell = ensureRenderedCellByCoords(row, Math.min(col, Math.max(0, COLUMN_COUNT - 1)));
  formulaNameBox.blur();
  if (cell) {
    setSingleSelection(cell);
    cell.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  updateModernStatus();
});

document.addEventListener('click', () => setTimeout(updateModernStatus, 0));
document.addEventListener('keyup', event => {
  if (event.target !== formulaInput && event.target !== formulaNameBox) queueModernStatusUpdate();
});
setTimeout(updateModernStatus, 0);
const dragIndicator = document.createElement('div');
dragIndicator.style.position = 'fixed';
dragIndicator.style.pointerEvents = 'none';
dragIndicator.style.zIndex = '20000';
dragIndicator.style.background = '#0a84ff';
dragIndicator.style.display = 'none';
document.body.appendChild(dragIndicator);
let columnSizeState = {};
let rowSizeState = {};

const normalizeSizeState = (raw, minSize) => {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const idx = parseInt(k, 10);
    const size = Number(v);
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (!Number.isFinite(size) || size < minSize) continue;
    out[String(idx)] = Math.round(size);
  }
  return out;
};

const applySizeStateToRenderedCells = () => {
  for (const [col, width] of Object.entries(columnSizeState)) {
    const px = Math.max(40, Math.round(Number(width)));
    table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
      cell.style.width = `${px}px`;
      cell.style.minWidth = `${px}px`;
      cell.style.maxWidth = `${px}px`;
    });
  }
  for (const [row, height] of Object.entries(rowSizeState)) {
    const px = Math.max(getMinRowHeight(), Math.round(Number(height)));
    table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
      cell.style.height = `${px}px`;
      cell.style.minHeight = `${px}px`;
    });
  }
};

const getFirstDataRow = () => {
  const cells = Array.from(table.querySelectorAll('tbody td[data-col]:not([data-col="-1"])'));
  let min = Infinity;
  for (const el of cells) {
    const v = parseInt(el.getAttribute('data-row') || 'NaN', 10);
    if (!Number.isNaN(v)) min = Math.min(min, v);
  }
  return Number.isFinite(min) ? min : 0;
};

const setZoomScale = (nextScale, persist = true) => {
  const normalized = clamp(Math.round(nextScale * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(normalized - zoomScale) < 0.001) {
    return false;
  }
  zoomScale = normalized;
  document.body.style.fontSize = `${Math.max(1, BASE_FONT_SIZE_PX * zoomScale)}px`;
  applySizeStateToRenderedCells();
  if (persist) {
    persistState();
  }
  return true;
};
const zoomIn = () => setZoomScale(zoomScale + ZOOM_STEP);
const zoomOut = () => setZoomScale(zoomScale - ZOOM_STEP);
const resetZoom = () => setZoomScale(1);
const isZoomModifier = e => (e.ctrlKey || e.metaKey) && !e.altKey;
const isZoomInShortcut = e => e.code === 'NumpadAdd' || e.key === '+' || e.key === '=';
const isZoomOutShortcut = e => e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_';
const isZoomResetShortcut = e => e.key === '0';
const maybeHandleZoomShortcut = e => {
  if (!isZoomModifier(e)) return false;
  if (isZoomInShortcut(e)) {
    e.preventDefault();
    zoomIn();
    return true;
  }
  if (isZoomOutShortcut(e)) {
    e.preventDefault();
    zoomOut();
    return true;
  }
  if (isZoomResetShortcut(e)) {
    e.preventDefault();
    resetZoom();
    return true;
  }
  return false;
};

// Persist/restore view state (scroll + selection) across webview reloads
const persistState = () => {
  try {
    const st = vscode.getState() || {};
    const anchor = anchorCell ? getCellCoords(anchorCell) : null;
    const nextState = {
      ...st,
      scrollX: scrollContainer ? scrollContainer.scrollLeft : 0,
      scrollY: scrollContainer ? scrollContainer.scrollTop : (window.scrollY || window.pageYOffset || 0),
      anchorRow: anchor ? anchor.row : undefined,
      anchorCol: anchor ? anchor.col : undefined,
      columnSizes: { ...columnSizeState },
      rowSizes: { ...rowSizeState },
      zoomScale
    };
    vscode.setState(nextState);
  } catch {}
};

const restoreState = () => {
  try {
    const st = vscode.getState() || {};
    const restoredZoom = parsePositiveNumber(st.zoomScale);
    setZoomScale(restoredZoom ?? 1, false);
    columnSizeState = normalizeSizeState(st.columnSizes, 40);
    rowSizeState = normalizeSizeState(st.rowSizes, getMinRowHeight());
    applySizeStateToRenderedCells();
    if (typeof st.scrollX === 'number' && scrollContainer) {
      scrollContainer.scrollLeft = st.scrollX;
    }
    // If the saved scroll position is beyond current height (because only the first
    // chunk is mounted), progressively load more chunks until we can restore it.
    if (typeof st.scrollY === 'number') {
      if (scrollContainer) {
        let guard = 100;
      while (
        typeof window.__csvLoadNextChunk === 'function' &&
        (scrollContainer.scrollHeight - scrollContainer.clientHeight < st.scrollY) &&
        guard-- > 0
      ) {
        if (!window.__csvLoadNextChunk()) break;
      }
      applySizeStateToRenderedCells();
      scrollContainer.scrollTop = st.scrollY;
    } else {
      window.scrollTo(0, st.scrollY);
      }
    }
    if (typeof st.anchorRow === 'number' && typeof st.anchorCol === 'number') {
      const tag = (st.anchorRow === HEADER_ROW ? 'th' : 'td');
      let sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
      // If not present yet (due to chunking), load chunks until available or exhausted
      if (!sel && typeof window.__csvLoadNextChunk === 'function') {
        let guard = 100; // prevent infinite loops
        while (!sel && typeof window.__csvLoadNextChunk === 'function' && guard-- > 0) {
          if (!window.__csvLoadNextChunk()) break;
          sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
        }
      }
      applySizeStateToRenderedCells();
      if (sel) {
        clearSelection();
        sel.classList.add('selected');
        currentSelection.push(sel);
        anchorCell = sel; rangeEndCell = sel;
        try { sel.focus({ preventScroll: true }); } catch { try { sel.focus(); } catch {} }
      }
    }
    // Re-apply scroll after any late chunk loads from selection restoration
    if (typeof st.scrollY === 'number' && scrollContainer) {
      scrollContainer.scrollTop = st.scrollY;
    }
  } catch {}
};

/* ──────────── VIRTUAL-SCROLL LOADER ──────────── */
// We use a <template> to carry JSON so CSP doesn't block it like a <script> might
const chunkTemplate = document.getElementById('__csvChunks');
let csvChunks = [];
try {
  csvChunks = chunkTemplate ? JSON.parse(chunkTemplate.textContent || '[]') : [];
} catch (e) {
  // Swallow parse errors; chunking will simply be disabled
  csvChunks = [];
}
let remoteNextChunkStart = Number.parseInt(root?.dataset?.nextchunkstart || '', 10);
if (!Number.isInteger(remoteNextChunkStart) || remoteNextChunkStart < 0) {
  remoteNextChunkStart = -1;
}
let remoteHasMoreChunks = root?.dataset?.hasmorechunks === '1' && remoteNextChunkStart >= 0;
let remoteChunkRequestInFlight = false;
let remoteChunkRequestedStart = -1;
let remoteChunkRequestSeq = 0;
let pendingEnsureTarget = null;
let nearBottom = () => false;
let loadNextChunk = () => false;

const requestRemoteChunk = () => {
  if (!remoteHasMoreChunks) return;
  if (remoteChunkRequestInFlight) return;
  if (!Number.isInteger(remoteNextChunkStart) || remoteNextChunkStart < 0) {
    remoteHasMoreChunks = false;
    return;
  }
  remoteChunkRequestInFlight = true;
  remoteChunkRequestedStart = remoteNextChunkStart;
  remoteChunkRequestSeq += 1;
  vscode.postMessage({ type: 'requestChunk', start: remoteNextChunkStart, requestId: remoteChunkRequestSeq });
};

if (csvChunks.length || remoteHasMoreChunks) {
  const tbody = table.tBodies[0];
  let loading = false;

  loadNextChunk = () => {
    if (loading || !tbody) return false;
    if (!csvChunks.length) {
      requestRemoteChunk();
      return false;
    }
    loading = true;
    try {
      const html = csvChunks.shift();
      if (html) {
        tbody.insertAdjacentHTML('beforeend', html);
        applySizeStateToRenderedCells();
        window.dispatchEvent(new Event('csvChunkLoaded'));
      }
      if (!csvChunks.length) {
        requestRemoteChunk();
      }
      return !!html;
    } finally {
      loading = false;
    }
  };
  // Expose for restoration logic
  window.__csvLoadNextChunk = loadNextChunk;

  nearBottom = () => {
    if (!scrollContainer) return false;
    const remain = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    return remain < 300; // px threshold
  };

  const io = new IntersectionObserver((entries)=>{
    if (entries[0] && entries[0].isIntersecting) {
      loadNextChunk();
      const last = tbody && tbody.querySelector('tr:last-child');
      if (last) io.observe(last);
    }
  }, { root: scrollContainer || null, rootMargin: '0px 0px 300px 0px' });

  const prime = () => {
    const last = tbody && tbody.querySelector('tr:last-child');
    if (last) { io.observe(last); }
  };
  prime();

  // Fallback: scroll-driven loader to ensure progress even if IO misses
  const scrollHandler = () => {
    if (!csvChunks.length && !remoteHasMoreChunks) return;
    if (nearBottom()) {
      // Load until we create headroom or exhaust currently available chunks
      let guard = 10;
      while (nearBottom() && guard-- > 0) {
        if (!loadNextChunk()) break;
      }
      prime();
    }
  };
  if (scrollContainer) scrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
  else window.addEventListener('scroll', scrollHandler, { passive: true });
}

const ensureTargetStep = () => {
  if (!pendingEnsureTarget) return;
  const { row, col } = pendingEnsureTarget;
  const sel = table.querySelector(`td[data-row="${row}"][data-col="${col}"], th[data-row="${row}"][data-col="${col}"]`);
  if (sel) {
    const { onReady } = pendingEnsureTarget;
    pendingEnsureTarget = null;
    if (typeof onReady === 'function') onReady(sel);
    return;
  }
  pendingEnsureTarget.guard -= 1;
  if (pendingEnsureTarget.guard <= 0 || (!remoteHasMoreChunks && !csvChunks.length)) {
    pendingEnsureTarget = null;
    return;
  }
  if (!loadNextChunk()) {
    requestRemoteChunk();
  }
};
window.addEventListener('csvChunkLoaded', ensureTargetStep);
/* ───────── END VIRTUAL-SCROLL LOADER ───────── */

// Restore state after initial DOM is ready
restoreState();
setTimeout(() => { try { restoreState(); } catch {} }, 0);
requestAnimationFrame(() => { try { restoreState(); } catch {} });

// Track scroll to persist state (prefer container)
if (scrollContainer) {
  scrollContainer.addEventListener('scroll', () => {
    persistState();
  }, { passive: true });
} else {
  window.addEventListener('scroll', () => { persistState(); }, { passive: true });
}

// Persist on blur/visibility change and restore on focus/visibility
window.addEventListener('blur', () => { persistState(); }, { passive: true });
window.addEventListener('focus', () => {
  setTimeout(() => { try { restoreState(); } catch {} }, 0);
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistState();
  } else if (document.visibilityState === 'visible') {
    setTimeout(() => { try { restoreState(); } catch {} }, 0);
  }
});

const handleZoomWheel = e => {
  if (!MOUSE_WHEEL_ZOOM_ENABLED) return;
  if (!isZoomModifier(e)) return;
  if (Math.abs(e.deltaY) < 0.1) return;
  e.preventDefault();
  const naturalDirection = e.deltaY < 0 ? 1 : -1;
  const direction = MOUSE_WHEEL_ZOOM_INVERTED ? -naturalDirection : naturalDirection;
  if (direction > 0) {
    zoomIn();
  } else {
    zoomOut();
  }
};
window.addEventListener('wheel', handleZoomWheel, { passive: false });

const hasHeader = document.querySelector('thead') !== null;
const getCellCoords = cell => ({ row: parseInt(cell.getAttribute('data-row')), col: parseInt(cell.getAttribute('data-col')) });
const clearSelection = () => {
  currentSelection.forEach(c => c.classList.remove('selected'));
  currentSelection = [];
  selectionKind = 'cells';
};
const contextMenu = document.getElementById('contextMenu');

const hideContextMenu = () => {
  if (contextMenu.style.display === 'none' || !contextMenu.style.display) return false;
  contextMenu.style.display = 'none';
  return true;
};

// Spreadsheet-style context menu: clipboard, sort, and row/column structure.
// Row/column commands act on every selected row/column, not only the cell
// under the pointer.
const showContextMenu = (x, y, row, col) => {
  contextMenu.replaceChildren();
  const item = (label, shortcut, cb) => {
    const d = document.createElement('div');
    d.className = 'menu-item';
    d.setAttribute('role', 'menuitem');
    d.tabIndex = -1;
    d.append(document.createTextNode(label));
    if (shortcut) {
      const k = document.createElement('kbd');
      k.textContent = shortcut;
      d.append(k);
    }
    d.addEventListener('click', () => { hideContextMenu(); cb(); });
    contextMenu.appendChild(d);
  };
  const divider = () => {
    if (!contextMenu.lastChild || contextMenu.lastChild.className === 'menu-separator') return;
    const d = document.createElement('div');
    d.className = 'menu-separator';
    contextMenu.appendChild(d);
  };

  const hasData = currentSelection.some(isDataCell);
  if (hasData) {
    item(t('cutSelection'), 'Ctrl+X', () => cutSelection());
    item(t('copySelection'), 'Ctrl+C', () => copySelectionToClipboard());
  }
  item(t('pasteSelection'), 'Ctrl+V', () => pasteFromExtensionClipboard());
  if (hasData) item(t('clearSelection'), 'Del', () => clearSelectedCells());

  if (!isNaN(col) && col >= 0) {
    divider();
    item(t('sortAscending'), '', () => vscode.postMessage({ type: 'sortColumn', index: col, ascending: true }));
    item(t('sortDescending'), '', () => vscode.postMessage({ type: 'sortColumn', index: col, ascending: false }));
  }

  if (!isNaN(row) && row >= 0) {
    divider();
    const rows = getTargetRows(row);
    const n = rows.length;
    item(n > 1 ? t('insertRowsAbove', { n }) : t('insertRowAbove'), '', () => postInsertRows(rows, false));
    item(n > 1 ? t('insertRowsBelow', { n }) : t('insertRowBelow'), '', () => postInsertRows(rows, true));
    item(n > 1 ? t('deleteRows', { n }) : t('deleteRow'), '', () => postDeleteRows(rows));
  }

  if (!isNaN(col) && col >= 0) {
    divider();
    const cols = getTargetCols(col);
    const n = cols.length;
    item(n > 1 ? t('insertColumnsLeft', { n }) : t('insertColumnLeft'), '', () => postInsertCols(cols, false));
    item(n > 1 ? t('insertColumnsRight', { n }) : t('insertColumnRight'), '', () => postInsertCols(cols, true));
    item(n > 1 ? t('deleteColumns', { n }) : t('deleteColumn'), '', () => postDeleteCols(cols));
  }

  // Keep the menu inside the viewport.
  contextMenu.style.display = 'block';
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';
  const rect = contextMenu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
  const first = contextMenu.querySelector('.menu-item');
  if (first) {
    first.classList.add('focused');
    try { contextMenu.focus({ preventScroll: true }); } catch {}
  }
};
contextMenu.tabIndex = -1;
contextMenu.addEventListener('keydown', e => {
  e.stopPropagation();
  const items = Array.from(contextMenu.querySelectorAll('.menu-item'));
  const current = items.findIndex(node => node.classList.contains('focused'));
  const move = delta => {
    items.forEach(node => node.classList.remove('focused'));
    const next = items[(current + delta + items.length) % items.length];
    next?.classList.add('focused');
  };
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); items[current]?.click(); }
  else if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    hideContextMenu();
    if (anchorCell?.isConnected) { try { anchorCell.focus({ preventScroll: true }); } catch {} }
  }
});
window.addEventListener('blur', () => hideContextMenu());
scrollContainer?.addEventListener('scroll', () => hideContextMenu(), { passive: true });

const getElementTarget = target => {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};
const getLinkTarget = target => {
  const el = getElementTarget(target);
  return el ? el.closest('.csv-link[data-href]') : null;
};
const getCellTarget = target => {
  const el = getElementTarget(target);
  return el ? el.closest('td, th') : null;
};
const isColumnHeaderCell = cell => {
  if (!cell || cell.tagName !== 'TH') return false;
  const col = cell.getAttribute('data-col');
  return col !== null && col !== '-1';
};
const isRowIndexCell = cell => cell && cell.getAttribute && cell.getAttribute('data-col') === '-1';
const getSelectedColumnIds = () => {
  const ids = currentSelection
    .filter(el => el && el.tagName === 'TH')
    .map(el => parseInt(el.getAttribute('data-col') || 'NaN', 10))
    .filter(v => !Number.isNaN(v) && v >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
};
const getSelectedRowIds = () => {
  const ids = currentSelection
    .filter(el => isRowIndexCell(el))
    .map(el => parseInt(el.getAttribute('data-row') || 'NaN', 10))
    .filter(v => !Number.isNaN(v) && v >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
};
const hideDragIndicator = () => {
  dragIndicator.style.display = 'none';
};
const showColumnDropIndicator = x => {
  const rect = table.getBoundingClientRect();
  dragIndicator.style.left = `${Math.round(x) - 1}px`;
  dragIndicator.style.top = `${Math.round(rect.top)}px`;
  dragIndicator.style.width = '2px';
  dragIndicator.style.height = `${Math.max(1, Math.round(rect.height))}px`;
  dragIndicator.style.display = 'block';
};
const showRowDropIndicator = y => {
  const rect = table.getBoundingClientRect();
  dragIndicator.style.left = `${Math.round(rect.left)}px`;
  dragIndicator.style.top = `${Math.round(y) - 1}px`;
  dragIndicator.style.width = `${Math.max(1, Math.round(rect.width))}px`;
  dragIndicator.style.height = '2px';
  dragIndicator.style.display = 'block';
};
const getColumnDropTarget = clientX => {
  const headers = Array.from(table.querySelectorAll('thead th[data-col]'))
    .map(cell => ({ cell, col: parseInt(cell.getAttribute('data-col') || 'NaN', 10) }))
    .filter(entry => !Number.isNaN(entry.col) && entry.col >= 0)
    .sort((a, b) => a.col - b.col);
  if (!headers.length) return null;

  let beforeIndex = headers[0].col;
  let indicatorX = headers[0].cell.getBoundingClientRect().left;
  for (const entry of headers) {
    const rect = entry.cell.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      beforeIndex = entry.col;
      indicatorX = rect.left;
      return { beforeIndex, indicatorX };
    }
    beforeIndex = entry.col + 1;
    indicatorX = rect.right;
  }
  return { beforeIndex, indicatorX };
};
const getRowDropTarget = clientY => {
  const rows = Array.from(table.querySelectorAll('tbody td[data-col="-1"]'))
    .map(cell => ({ cell, row: parseInt(cell.getAttribute('data-row') || 'NaN', 10) }))
    .filter(entry => !Number.isNaN(entry.row) && entry.row >= 0)
    .sort((a, b) => a.row - b.row);
  if (!rows.length) return null;

  let beforeIndex = rows[0].row;
  let indicatorY = rows[0].cell.getBoundingClientRect().top;
  for (const entry of rows) {
    const rect = entry.cell.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeIndex = entry.row;
      indicatorY = rect.top;
      return { beforeIndex, indicatorY };
    }
    beforeIndex = entry.row + 1;
    indicatorY = rect.bottom;
  }
  return { beforeIndex, indicatorY };
};
const getResizeEdgeInfo = (target, e) => {
  if (!target) return null;
  if (isColumnHeaderCell(target)) {
    const col = parseInt(target.getAttribute('data-col') || 'NaN', 10);
    if (!Number.isNaN(col)) {
      const rect = target.getBoundingClientRect();
      const edgeDelta = rect.right - e.clientX;
      if (edgeDelta >= 0 && edgeDelta <= RESIZE_HANDLE_PX) {
        return { axis: 'column', index: col, rect };
      }
    }
  }
  if (isRowIndexCell(target)) {
    const row = parseInt(target.getAttribute('data-row') || 'NaN', 10);
    if (!Number.isNaN(row)) {
      const rect = target.getBoundingClientRect();
      const edgeDelta = rect.bottom - e.clientY;
      if (edgeDelta >= 0 && edgeDelta <= RESIZE_HANDLE_PX) {
        return { axis: 'row', index: row, rect };
      }
    }
  }
  return null;
};
const applyColumnWidth = (col, widthPx) => {
  const width = Math.max(40, Math.round(widthPx));
  columnSizeState[String(col)] = width;
  table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
  });
};
const resetColumnWidth = col => {
  delete columnSizeState[String(col)];
  table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
    cell.style.width = '';
    cell.style.minWidth = '';
    cell.style.maxWidth = '';
  });
};
const applyRowHeight = (row, heightPx) => {
  const height = Math.max(getMinRowHeight(), Math.round(heightPx));
  rowSizeState[String(row)] = height;
  table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
    cell.style.height = `${height}px`;
    cell.style.minHeight = `${height}px`;
  });
};
const resetRowHeight = row => {
  delete rowSizeState[String(row)];
  table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
    cell.style.height = '';
    cell.style.minHeight = '';
  });
};
const startResizeDrag = (target, e) => {
  if (e.button !== 0) return false;
  const edge = getResizeEdgeInfo(target, e);
  if (!edge) return false;
  if (edge.axis === 'column') {
    resizeState = { axis: 'column', index: edge.index, startPos: e.clientX, startSize: edge.rect.width };
    table.style.cursor = 'col-resize';
    return true;
  }
  const rowCells = Array.from(table.querySelectorAll(`[data-row="${edge.index}"]`));
  const startHeight = rowCells.reduce((max, cell) => Math.max(max, cell.getBoundingClientRect().height), edge.rect.height);
  resizeState = { axis: 'row', index: edge.index, startPos: e.clientY, startSize: startHeight };
  table.style.cursor = 'row-resize';
  return true;
};
const startReorderDrag = (target, e) => {
  if (e.button !== 0) return false;
  if (isColumnHeaderCell(target) && target.classList.contains('selected')) {
    const col = parseInt(target.getAttribute('data-col') || 'NaN', 10);
    if (Number.isNaN(col)) return false;
    const selected = getSelectedColumnIds();
    const indices = selected.includes(col) ? selected : [col];
    reorderState = {
      axis: 'column',
      indices,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      beforeIndex: null
    };
    return true;
  }
  if (isRowIndexCell(target) && target.classList.contains('selected')) {
    const row = parseInt(target.getAttribute('data-row') || 'NaN', 10);
    if (Number.isNaN(row)) return false;
    const selected = getSelectedRowIds();
    const indices = selected.includes(row) ? selected : [row];
    reorderState = {
      axis: 'row',
      indices,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      beforeIndex: null
    };
    return true;
  }
  return false;
};
const onGlobalDragMove = e => {
  if (resizeState) {
    e.preventDefault();
    if (resizeState.axis === 'column') {
      const delta = e.clientX - resizeState.startPos;
      applyColumnWidth(resizeState.index, resizeState.startSize + delta);
    } else if (resizeState.axis === 'row') {
      const delta = e.clientY - resizeState.startPos;
      applyRowHeight(resizeState.index, resizeState.startSize + delta);
    }
    return;
  }
  if (!reorderState) return;

  const movedX = Math.abs(e.clientX - reorderState.startX);
  const movedY = Math.abs(e.clientY - reorderState.startY);
  if (!reorderState.active && movedX < DRAG_THRESHOLD_PX && movedY < DRAG_THRESHOLD_PX) {
    return;
  }
  reorderState.active = true;
  e.preventDefault();

  if (reorderState.axis === 'column') {
    const target = getColumnDropTarget(e.clientX);
    if (!target) return;
    reorderState.beforeIndex = target.beforeIndex;
    showColumnDropIndicator(target.indicatorX);
  } else {
    const target = getRowDropTarget(e.clientY);
    if (!target) return;
    reorderState.beforeIndex = target.beforeIndex;
    showRowDropIndicator(target.indicatorY);
  }
};
const onGlobalDragEnd = () => {
  if (resizeState) {
    resizeState = null;
    table.style.cursor = '';
    persistState();
  }
  if (!reorderState) return;

  const { axis, indices, active, beforeIndex } = reorderState;
  reorderState = null;
  hideDragIndicator();
  table.style.cursor = '';

  if (!active || !Number.isFinite(beforeIndex)) return;
  if (axis === 'column') {
    vscode.postMessage({ type: 'reorderColumns', indices, beforeIndex });
  } else {
    vscode.postMessage({ type: 'reorderRows', indices, beforeIndex });
  }
};
document.addEventListener('mousemove', onGlobalDragMove);
document.addEventListener('mouseup', onGlobalDragEnd);
const postOpenLink = link => {
  const url = link.getAttribute('data-href') || link.getAttribute('href');
  if (url) {
    vscode.postMessage({ type: 'openLink', url });
  }
};

document.addEventListener('click', (e) => {
  contextMenu.style.display = 'none';

  const link = getLinkTarget(e.target);
  if (!link) {
    return;
  }
  // Never navigate inside the webview.
  e.preventDefault();
  if (!(e.ctrlKey || e.metaKey)) {
    return;
  }
  // Ctrl/Cmd+click should open externally once, while regular clicks
  // still behave like normal cell interactions.
  if (e.detail === 1) {
    e.stopPropagation();
    postOpenLink(link);
  }
});

table.addEventListener('contextmenu', e => {
  const target = getCellTarget(e.target);
  if (!target) return;
  const col = parseInt(target.getAttribute('data-col') ?? '', 10);
  const row = parseInt(target.getAttribute('data-row') ?? '', 10);
  e.preventDefault();
  if (editingCell) return;
  // The row-number column offers row commands; the corner cell only clipboard.
  showContextMenu(e.clientX, e.clientY, row, col);
});

table.addEventListener('mousedown', e => {
  const link = getLinkTarget(e.target);
  // Ctrl/Cmd+click on a link opens externally on click; keep existing selection unchanged.
  if (link && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return;
  }
  const target = getCellTarget(e.target);
  if (!target) return;

  if (target.classList.contains('sheet-column-header')) {
    e.preventDefault();
    const col = Number.parseInt(target.dataset.sheetCol || '0', 10);
    const previousCol = Number.isInteger(sheetColumnAnchor) ? sheetColumnAnchor : col;
    selectFullColumnRange(e.shiftKey ? previousCol : col, col);
    anchorCell = currentSelection.find(cell => cell.getAttribute('data-col') === String(col)) || currentSelection[0] || null;
    rangeEndCell = anchorCell;
    sheetColumnAnchor = col;
    target.focus();
    persistState();
    updateModernStatus();
    return;
  }
  sheetColumnAnchor = null;

  // Preserve selection on right-click; select target if outside current selection
  if (e.button === 2) { // right mouse button
    if (!editingCell) {
      e.preventDefault();
      if (!target.classList.contains('selected')) {
        clearSelection();
        target.classList.add('selected');
        currentSelection.push(target);
        anchorCell = target;
        rangeEndCell = target;
        try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
        updateModernStatus();
      }
    }
    return; // do not start drag selection on right-click
  }
  if (e.button !== 0) return;
  if (!editingCell && startResizeDrag(target, e)) {
    e.preventDefault();
    return;
  }
  if (!editingCell && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && startReorderDrag(target, e)) {
    e.preventDefault();
    return;
  }

  // ──────── NEW: Shift+Click range selection ────────
  if (e.shiftKey && anchorCell && !editingCell) {
    const aRowAttr = anchorCell.getAttribute('data-row');
    const aColAttr = anchorCell.getAttribute('data-col');
    const tRowAttr = target.getAttribute('data-row');
    const tColAttr = target.getAttribute('data-col');
    // Ensure both have coordinates of some form
    if (aRowAttr !== null && tRowAttr !== null) {
      // Case 1: Header-to-header shift click → full column range
      if (anchorCell.tagName === 'TH' && target.tagName === 'TH' && aColAttr !== null && tColAttr !== null) {
        e.preventDefault();
        const startCol = parseInt(aColAttr, 10);
        const endCol = parseInt(tColAttr, 10);
        selectFullColumnRange(startCol, endCol);
        rangeEndCell = target;
        anchorCell.focus();
        return;
      }
      // Case 2: Serial-index-to-serial-index shift click → full row range
      if (aColAttr === '-1' && tColAttr === '-1') {
        e.preventDefault();
        const startRow = parseInt(aRowAttr, 10);
        const endRow = parseInt(tRowAttr, 10);
        selectFullRowRange(startRow, endRow);
        rangeEndCell = target;
        anchorCell.focus();
        return;
      }
      // Case 3: Regular cell-to-cell rectangle (exclude header/serial)
      if (
        aColAttr !== null && tColAttr !== null &&
        aColAttr !== '-1' && tColAttr !== '-1' &&
        target.tagName !== 'TH' && anchorCell.tagName !== 'TH'
      ) {
        e.preventDefault();
        selectRange(getCellCoords(anchorCell), getCellCoords(target));
        rangeEndCell = target;
        anchorCell.focus();
        return;
      }
    }
  }

  if(editingCell){ if(e.target !== editingCell) editingCell.blur(); else return; } else clearSelection();

  /* ──────── NEW: select-all via top-left header cell ──────── */
  if (
    target.tagName === 'TH' &&                 // header cell
    !target.hasAttribute('data-col') &&        // serial-index header has *no* data-col
    !target.hasAttribute('data-row')           // and no data-row
  ) {
    e.preventDefault();
    clearSelection();
    selectAllCells();
    isSelecting = false;
    anchorCell  = null;
    return;
  }
  /* ──────── END NEW BLOCK ──────── */
  
  selectionMode = (target.tagName === 'TH') ? "column" : (target.getAttribute('data-col') === '-1' ? "row" : "cell");
  startCell = target; endCell = target; rangeEndCell = target; isSelecting = true; e.preventDefault();
  target.focus();
});

table.addEventListener('mousemove', e => {
  if(!isSelecting) return;
  let target = getCellTarget(e.target);
  if (!target) return;
  if(selectionMode === "cell"){
    endCell = target;
    rangeEndCell = target;
    selectRange(getCellCoords(startCell), getCellCoords(endCell));
  } else if(selectionMode === "column"){
    if(target.tagName !== 'TH'){
      const col = target.getAttribute('data-col');
      target = table.querySelector('thead th[data-col="'+col+'"]') || target;
    }
    endCell = target;
    rangeEndCell = target;
    const startCol = parseInt(startCell.getAttribute('data-col'));
    const endCol = parseInt(endCell.getAttribute('data-col'));
    selectFullColumnRange(startCol, endCol);
  } else if(selectionMode === "row"){
    if(target.getAttribute('data-col') !== '-1'){
      const row = target.getAttribute('data-row');
      target = table.querySelector('td[data-col="-1"][data-row="'+row+'"]') || target;
    }
    endCell = target;
    rangeEndCell = target;
    const startRow = parseInt(startCell.getAttribute('data-row'));
    const endRow = parseInt(endCell.getAttribute('data-row'));
    selectFullRowRange(startRow, endRow);
  }
});

table.addEventListener('mousemove', e => {
  if (isSelecting || resizeState || (reorderState && reorderState.active)) {
    return;
  }
  const target = getCellTarget(e.target);
  if (!target) {
    table.style.cursor = '';
    return;
  }
  const edge = getResizeEdgeInfo(target, e);
  if (edge) {
    table.style.cursor = edge.axis === 'column' ? 'col-resize' : 'row-resize';
    return;
  }
  table.style.cursor = '';
});

table.addEventListener('mouseleave', () => {
  if (!resizeState) {
    table.style.cursor = '';
  }
});

table.addEventListener('mouseup', e => {
  if(!isSelecting) return;
  isSelecting = false;
  if(selectionMode === "cell"){
    if(startCell === endCell){
      clearSelection();
      startCell.classList.add('selected');
      currentSelection.push(startCell);
    }
    anchorCell = startCell;
    rangeEndCell = endCell;
    persistState();
  } else if(selectionMode === "column"){
    const startCol = parseInt(startCell.getAttribute('data-col'));
    const endCol = parseInt(endCell.getAttribute('data-col'));
    selectFullColumnRange(startCol, endCol); anchorCell = startCell; rangeEndCell = endCell; persistState();
  } else if(selectionMode === "row"){
    const startRow = parseInt(startCell.getAttribute('data-row'));
    const endRow = parseInt(endCell.getAttribute('data-row'));
    selectFullRowRange(startRow, endRow); anchorCell = startCell; rangeEndCell = endCell; persistState();
  }
});

const selectRange = (start, end) => {
  clearSelection();
  const minRow = Math.min(start.row, end.row), maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.col, end.col), maxCol = Math.max(start.col, end.col);
  for(let r = minRow; r <= maxRow; r++){
    for(let c = minCol; c <= maxCol; c++){
      const selector = (r === HEADER_ROW ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
      const selCell = table.querySelector(selector);
      if(selCell){ selCell.classList.add('selected'); currentSelection.push(selCell); }
    }
  }
  queueModernStatusUpdate();
};

const selectFullColumnRange = (col1, col2) => {
  clearSelection();
  const minCol = Math.min(col1, col2), maxCol = Math.max(col1, col2);
  table.querySelectorAll('tr').forEach(row => {
    Array.from(row.children).forEach(cell => {
      const cellCol = cell.getAttribute('data-col');
      if(cellCol !== null && parseInt(cellCol) >= minCol && parseInt(cellCol) <= maxCol){
        cell.classList.add('selected'); currentSelection.push(cell);
      }
    });
  });
  selectionKind = 'columns';
  queueModernStatusUpdate();
};

const selectFullRowRange = (row1, row2) => {
  clearSelection();
  const minRow = Math.min(row1, row2), maxRow = Math.max(row1, row2);
  table.querySelectorAll('tr').forEach(row => {
    Array.from(row.children).forEach(cell => {
      const r = cell.getAttribute('data-row');
      if(r !== null && parseInt(r) >= minRow && parseInt(r) <= maxRow){
        cell.classList.add('selected'); currentSelection.push(cell);
      }
    });
  });
  selectionKind = 'rows';
  queueModernStatusUpdate();
};

const getDataCellCoords = cell => {
  if (!cell || typeof cell.getAttribute !== 'function') return null;
  const coords = getCellCoords(cell);
  if (!coords || !Number.isInteger(coords.row) || !Number.isInteger(coords.col)) return null;
  if (coords.row < 0 || coords.col < 0) return null;
  return coords;
};

const getDataSelectionBounds = () => {
  const coords = currentSelection
    .map(cell => getDataCellCoords(cell))
    .filter(Boolean);
  if (!coords.length) return null;
  const keys = new Set(coords.map(c => `${c.row}:${c.col}`));
  const rows = coords.map(c => c.row);
  const cols = coords.map(c => c.col);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const expectedCount = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  const rectangular = keys.size === expectedCount;
  return { minRow, maxRow, minCol, maxCol, rectangular };
};

const getPasteAnchorCoords = () => {
  const anchor = getDataCellCoords(anchorCell);
  if (anchor) return anchor;
  const fromActive = getDataCellCoords(getCellTarget(document.activeElement));
  if (fromActive) return fromActive;
  const bounds = getDataSelectionBounds();
  if (bounds) return { row: bounds.minRow, col: bounds.minCol };
  return null;
};

const findReplaceWidget = document.getElementById('findReplaceWidget');
const replaceToggleGutter = document.getElementById('replaceToggleGutter');
const replaceToggle = document.getElementById('replaceToggle');
const findInput = document.getElementById('findInput');
const replaceInput = document.getElementById('replaceInput');
const findStatus = document.getElementById('findStatus');
const findPrev = document.getElementById('findPrev');
const findNext = document.getElementById('findNext');
const findClose = document.getElementById('findClose');
const findCaseToggle = document.getElementById('findCaseToggle');
const findWordToggle = document.getElementById('findWordToggle');
const findRegexToggle = document.getElementById('findRegexToggle');
const replaceCaseToggle = document.getElementById('replaceCaseToggle');
const replaceOne = document.getElementById('replaceOne');
const replaceAll = document.getElementById('replaceAll');

const findReplaceState = {
  open: false,
  replaceExpanded: false,
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  invalidRegex: false
};
let findMatches = [];
let findMatchesTruncated = false;
let currentMatchIndex = -1;
let findDebounce = null;
let findFocusBeforeOpen = null;
let findRequestSeq = 0;
let latestFindRequestId = 0;
const pendingFindRequests = new Map();
let findMatchKeySet = new Set();

const escapeRegexLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getFindMatchKey = (row, col) => `${row}:${col}`;
const isFindWidgetTarget = target => {
  const el = getElementTarget(target);
  return !!(el && el.closest('#findReplaceWidget'));
};
const clearFindHighlights = () => {
  document.querySelectorAll('.highlight, .active-match').forEach(el => {
    el.classList.remove('highlight');
    el.classList.remove('active-match');
  });
};
const setReplaceExpanded = expanded => {
  findReplaceState.replaceExpanded = expanded;
  findReplaceWidget.classList.toggle('replace-collapsed', !expanded);
  findReplaceWidget.classList.toggle('replace-expanded', expanded);
  replaceToggle.setAttribute('aria-expanded', String(expanded));
  replaceToggle.querySelector('.codicon')?.classList.toggle('codicon-chevron-down', expanded);
  replaceToggle.querySelector('.codicon')?.classList.toggle('codicon-chevron-right', !expanded);
  persistFindState();
};
// Find state survives the full re-render that follows structural edits.
const persistFindState = () => {
  writeUiState({
    find: {
      open: findReplaceState.open,
      replaceExpanded: findReplaceState.replaceExpanded,
      matchCase: findReplaceState.matchCase,
      wholeWord: findReplaceState.wholeWord,
      regex: findReplaceState.regex,
      preserveCase: findReplaceState.preserveCase,
      query: findInput.value,
      replacement: replaceInput.value
    }
  });
};
const syncFindToggleUi = () => {
  findCaseToggle.setAttribute('aria-pressed', String(findReplaceState.matchCase));
  findWordToggle.setAttribute('aria-pressed', String(findReplaceState.wholeWord));
  findRegexToggle.setAttribute('aria-pressed', String(findReplaceState.regex));
  replaceCaseToggle.setAttribute('aria-pressed', String(findReplaceState.preserveCase));
};
const updateFindStatus = () => {
  const query = findInput.value;
  if (!query || query.length === 0 || findMatches.length === 0) {
    findStatus.textContent = findReplaceState.invalidRegex ? t('invalidRegex') : t('noResults');
    findStatus.classList.toggle('fr-status-empty', !!query);
    return;
  }
  findStatus.classList.remove('fr-status-empty');
  const suffix = findMatchesTruncated ? '+' : '';
  findStatus.textContent = t('matchPosition', { i: currentMatchIndex + 1, n: `${findMatches.length}${suffix}` });
};
const updateFindControls = () => {
  const hasQuery = findInput.value.length > 0;
  const hasMatches = findMatches.length > 0 && !findReplaceState.invalidRegex;
  findPrev.disabled = !hasMatches;
  findNext.disabled = !hasMatches;
  replaceOne.disabled = !hasQuery || !hasMatches;
  replaceAll.disabled = !hasQuery || !hasMatches;
};
const getFindPattern = () => {
  const query = findInput.value;
  if (!query) return null;
  let source = findReplaceState.regex ? query : escapeRegexLiteral(query);
  if (findReplaceState.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  return source;
};
const buildFindRegex = global => {
  const source = getFindPattern();
  if (!source) return null;
  const flags = `${global ? 'g' : ''}${findReplaceState.matchCase ? '' : 'i'}`;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};
const getRenderedFindCells = () => {
  return Array.from(table.querySelectorAll('td[data-col], th[data-col]'));
};
const getRenderedCellByCoords = (row, col) => {
  return table.querySelector(`td[data-row="${row}"][data-col="${col}"], th[data-row="${row}"][data-col="${col}"]`);
};
const ensureRenderedCellByCoords = (row, col, onReady) => {
  let cell = getRenderedCellByCoords(row, col);
  if (cell) {
    return cell;
  }
  if (typeof window.__csvLoadNextChunk !== 'function') {
    return null;
  }
  let guard = 50000;
  while (!cell && guard-- > 0) {
    if (!window.__csvLoadNextChunk()) break;
    cell = getRenderedCellByCoords(row, col);
  }
  if (!cell && (remoteHasMoreChunks || remoteChunkRequestInFlight)) {
    pendingEnsureTarget = { row, col, guard: 5000, onReady };
    requestRemoteChunk();
  }
  return cell;
};
const applyFindHighlightsToRendered = () => {
  if (!findMatchKeySet.size) {
    return;
  }
  getRenderedFindCells().forEach(cell => {
    const row = parseInt(cell.getAttribute('data-row') || 'NaN', 10);
    const col = parseInt(cell.getAttribute('data-col') || 'NaN', 10);
    if (Number.isNaN(row) || Number.isNaN(col) || col < 0) {
      return;
    }
    if (findMatchKeySet.has(getFindMatchKey(row, col))) {
      cell.classList.add('highlight');
    }
  });
};
const setActiveFindMatch = (index, shouldScroll = true) => {
  document.querySelectorAll('.active-match').forEach(el => el.classList.remove('active-match'));
  if (!findMatches.length) {
    currentMatchIndex = -1;
    updateFindStatus();
    updateFindControls();
    return;
  }
  const normalized = ((index % findMatches.length) + findMatches.length) % findMatches.length;
  currentMatchIndex = normalized;
  const match = findMatches[currentMatchIndex];
  const cell = match ? ensureRenderedCellByCoords(match.row, match.col) : null;
  if (cell) {
    cell.classList.add('highlight');
    cell.classList.add('active-match');
    if (shouldScroll) {
      cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
  }
  updateFindStatus();
  updateFindControls();
};
const runFind = (preserveIndex = false) => {
  const query = findInput.value;
  const priorIndex = currentMatchIndex;
  const requestId = ++findRequestSeq;
  latestFindRequestId = requestId;
  pendingFindRequests.set(requestId, { preserveIndex, priorIndex });

  clearFindHighlights();
  findMatches = [];
  findMatchKeySet = new Set();
  currentMatchIndex = -1;
  findReplaceState.invalidRegex = false;
  if (!query) {
    updateFindStatus();
    updateFindControls();
    return;
  }

  vscode.postMessage({
    type: 'findMatches',
    requestId,
    query,
    options: {
      matchCase: findReplaceState.matchCase,
      wholeWord: findReplaceState.wholeWord,
      regex: findReplaceState.regex
    }
  });
  updateFindStatus();
  updateFindControls();
};
const scheduleFind = (preserveIndex = false) => {
  if (findDebounce) clearTimeout(findDebounce);
  findDebounce = setTimeout(() => {
    runFind(preserveIndex);
  }, 150);
};
const navigateFind = reverse => {
  if (!findMatches.length) return;
  const delta = reverse ? -1 : 1;
  setActiveFindMatch(currentMatchIndex + delta);
};
const preserveReplacementCase = (replacement, matched) => {
  if (!replacement || !matched) return replacement;
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  const first = matched.charAt(0);
  const rest = matched.slice(1);
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
};
const replaceInText = (text, replaceAllMatches) => {
  const regex = buildFindRegex(replaceAllMatches);
  if (!regex) return text;
  const replacementText = replaceInput.value;
  if (!findReplaceState.preserveCase) {
    return text.replace(regex, replacementText);
  }
  return text.replace(regex, matched => preserveReplacementCase(replacementText, matched));
};
const replaceCurrentMatch = () => {
  if (!findMatches.length || findReplaceState.invalidRegex) return;
  const match = findMatches[currentMatchIndex];
  if (!match) {
    runFind(true);
    return;
  }
  const original = String(match.value ?? '');
  const next = replaceInText(original, false);
  if (next === original) {
    navigateFind(false);
    return;
  }
  const cell = ensureRenderedCellByCoords(match.row, match.col);
  if (cell) {
    cell.textContent = next;
  }
  vscode.postMessage({ type: 'editCell', row: match.row, col: match.col, value: next });
  runFind(true);
};
const replaceAllMatches = () => {
  if (findReplaceState.invalidRegex || !findInput.value || !findMatches.length) return;
  const seen = new Set();
  if (!findMatches.length) return;
  const replacements = [];
  findMatches.forEach(match => {
    if (!match) return;
    const key = getFindMatchKey(match.row, match.col);
    if (seen.has(key)) return;
    seen.add(key);
    const original = String(match.value ?? '');
    const next = replaceInText(original, true);
    if (next !== original) {
      const cell = getRenderedCellByCoords(match.row, match.col);
      if (cell) {
        cell.textContent = next;
      }
      replacements.push({ row: match.row, col: match.col, value: next });
    }
  });
  if (replacements.length > 0) {
    vscode.postMessage({ type: 'replaceCells', replacements });
  }
  runFind(false);
};
const openFindReplace = (expandReplace, focus = true) => {
  if (focus) {
    findFocusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  findReplaceState.open = true;
  findReplaceWidget.classList.add('open');
  setReplaceExpanded(expandReplace);
  syncFindToggleUi();
  if (focus) {
    // Seed the query from a short single-line selection, like VS Code.
    const active = getActiveDataCell();
    const seed = (active?.textContent || '').trim();
    if (!findInput.value && seed && seed.length <= 80 && !/\n/.test(seed)) {
      findInput.value = seed;
    }
    try { findInput.focus({ preventScroll: true }); } catch { try { findInput.focus(); } catch {} }
    findInput.select();
  }
  runFind(true);
};
const closeFindReplace = () => {
  if (findDebounce) {
    clearTimeout(findDebounce);
    findDebounce = null;
  }
  pendingFindRequests.clear();
  latestFindRequestId = 0;
  findReplaceState.open = false;
  findReplaceWidget.classList.remove('open');
  persistFindState();
  clearFindHighlights();
  findMatches = [];
  currentMatchIndex = -1;
  findReplaceState.invalidRegex = false;
  updateFindStatus();
  updateFindControls();
  const focusTarget = (findFocusBeforeOpen && findFocusBeforeOpen.isConnected)
    ? findFocusBeforeOpen
    : (anchorCell || document.body);
  try { focusTarget.focus({ preventScroll: true }); } catch { try { focusTarget.focus(); } catch {} }
};

findInput.addEventListener('input', () => { scheduleFind(false); persistFindState(); });
replaceInput.addEventListener('input', () => persistFindState());
// Alt+C / Alt+W / Alt+R toggle search options, as in VS Code.
const handleFindOptionShortcut = e => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return false;
  const key = (e.key || '').toLowerCase();
  const toggle = key === 'c' ? findCaseToggle : key === 'w' ? findWordToggle : key === 'r' ? findRegexToggle : null;
  if (!toggle) return false;
  e.preventDefault();
  toggle.click();
  return true;
};
findInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.isComposing) return;
  if (handleFindOptionShortcut(e)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (e.key === 'F3') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    navigateFind(e.shiftKey);
  }
});
replaceInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.isComposing) return;
  if (handleFindOptionShortcut(e)) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
    e.preventDefault();
    replaceAllMatches();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  if (e.key === 'F3') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    replaceCurrentMatch();
  }
});
replaceToggleGutter.addEventListener('click', () => {
  setReplaceExpanded(!findReplaceState.replaceExpanded);
});
findCaseToggle.addEventListener('click', () => {
  findReplaceState.matchCase = !findReplaceState.matchCase;
  syncFindToggleUi();
  persistFindState();
  runFind(true);
});
findWordToggle.addEventListener('click', () => {
  findReplaceState.wholeWord = !findReplaceState.wholeWord;
  syncFindToggleUi();
  persistFindState();
  runFind(true);
});
findRegexToggle.addEventListener('click', () => {
  findReplaceState.regex = !findReplaceState.regex;
  syncFindToggleUi();
  persistFindState();
  runFind(true);
});
replaceCaseToggle.addEventListener('click', () => {
  findReplaceState.preserveCase = !findReplaceState.preserveCase;
  syncFindToggleUi();
  persistFindState();
});
findPrev.addEventListener('click', () => navigateFind(true));
findNext.addEventListener('click', () => navigateFind(false));
findClose.addEventListener('click', closeFindReplace);
replaceOne.addEventListener('click', replaceCurrentMatch);
replaceAll.addEventListener('click', replaceAllMatches);
syncFindToggleUi();
updateFindStatus();
updateFindControls();
window.addEventListener('csvChunkLoaded', () => {
  if (!findReplaceState.open || findMatches.length === 0) {
    return;
  }
  applyFindHighlightsToRendered();
  if (currentMatchIndex >= 0 && currentMatchIndex < findMatches.length) {
    const active = findMatches[currentMatchIndex];
    const cell = getRenderedCellByCoords(active.row, active.col);
    if (cell) {
      cell.classList.add('active-match');
    }
  }
});

// ───────── Keyboard navigation ─────────
// Arrow-like keys we treat as navigation. PageUp/PageDown are handled
// separately and never with Ctrl/Cmd, which VS Code uses to switch tabs.
const NAV_KEYS = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Up','Down','Left','Right','Home','End'];
const isRowHidden = cell => cell?.closest?.('tr')?.style.display === 'none';
const TOP_ROW = Number.isInteger(HEADER_ROW) ? HEADER_ROW : FIRST_BODY_ROW;
let renderedMaxCol = null;
const getMaxCol = () => {
  if (renderedMaxCol === null) {
    const firstRow = table.querySelector('tr');
    const cols = firstRow
      ? Array.from(firstRow.querySelectorAll('[data-col]')).map(cell => Number.parseInt(cell.getAttribute('data-col') || '-1', 10))
      : [];
    renderedMaxCol = Math.max(0, ...cols);
  }
  return renderedMaxCol;
};
// Last row the user can land on: the last data row, or the trailing empty row
// when the file has no data rows yet.
const getBottomRow = () => (DATA_ROW_COUNT > 0 ? LAST_BODY_ROW : FIRST_BODY_ROW);
const cellAt = (row, col, onReady) => {
  if (row < TOP_ROW || col < 0 || col > getMaxCol()) return null;
  if (Number.isInteger(HEADER_ROW) && row === HEADER_ROW) {
    return table.querySelector(`th[data-row="${row}"][data-col="${col}"]`);
  }
  return ensureRenderedCellByCoords(row, col, onReady);
};
// Find the nearest row in `direction` from `row` (inclusive) whose cell is
// rendered and not hidden by the quick filter.
const visibleCellFrom = (row, col, direction) => {
  let r = row;
  for (let guard = 0; guard < 200000; guard++) {
    const cell = cellAt(r, col);
    if (!cell) return null;
    if (!isRowHidden(cell)) return cell;
    r += direction;
  }
  return null;
};
const moveSelectionTo = (cell, extend) => {
  if (!cell) return;
  if (extend && anchorCell) {
    rangeEndCell = cell;
    const anchor = anchorCell;
    selectRange(getCellCoords(anchor), getCellCoords(cell));
    anchorCell = anchor;
    persistState();
    try { anchor.focus({ preventScroll: true }); } catch {}
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } else {
    setSingleSelection(cell);
  }
  queueModernStatusUpdate();
};
const getPageRows = () => {
  const sample = anchorCell || table.querySelector('tbody td');
  const rowHeight = sample ? Math.max(1, sample.getBoundingClientRect().height) : 22;
  const viewport = scrollContainer ? scrollContainer.clientHeight : window.innerHeight;
  return Math.max(1, Math.floor(viewport / rowHeight) - 2);
};
// Returns true when the key was handled as grid navigation.
const handleNavigationKey = e => {
  const ref = (e.shiftKey ? rangeEndCell : null) || anchorCell;
  if (!ref) return false;
  const { row, col } = getCellCoords(ref);
  if (!Number.isInteger(row) || !Number.isInteger(col) || col < 0) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  let target = null;
  if (key === 'PageDown' || key === 'PageUp') {
    if (ctrl) return false;
    const delta = getPageRows() * (key === 'PageDown' ? 1 : -1);
    const nextRow = Math.max(TOP_ROW, Math.min(getBottomRow(), row + delta));
    target = visibleCellFrom(nextRow, col, delta > 0 ? -1 : 1) || visibleCellFrom(nextRow, col, delta > 0 ? 1 : -1);
  } else if (key === 'Home' || key === 'End') {
    const atEnd = key === 'End';
    if (ctrl) {
      const targetRow = atEnd ? getBottomRow() : TOP_ROW;
      const targetCol = atEnd ? getMaxCol() : 0;
      const select = cell => { if (cell) moveSelectionTo(cell, e.shiftKey); };
      target = cellAt(targetRow, targetCol, select);
      if (target && isRowHidden(target)) target = visibleCellFrom(targetRow, targetCol, atEnd ? -1 : 1);
    } else {
      target = cellAt(row, atEnd ? getMaxCol() : 0);
    }
  } else {
    const dir = key.replace('Arrow', '');
    if (ctrl) {
      if (dir === 'Left') target = cellAt(row, 0);
      else if (dir === 'Right') target = cellAt(row, getMaxCol());
      else if (dir === 'Up') target = visibleCellFrom(TOP_ROW, col, 1);
      else if (dir === 'Down') {
        const select = cell => { if (cell) moveSelectionTo(isRowHidden(cell) ? visibleCellFrom(getBottomRow(), col, -1) : cell, e.shiftKey); };
        target = cellAt(getBottomRow(), col, select);
        if (target && isRowHidden(target)) target = visibleCellFrom(getBottomRow(), col, -1);
      }
    } else if (dir === 'Left') target = cellAt(row, col - 1);
    else if (dir === 'Right') target = cellAt(row, col + 1);
    else if (dir === 'Up') target = visibleCellFrom(row - 1, col, -1);
    else if (dir === 'Down') {
      // Stay on the trailing empty row instead of walking off the grid.
      target = row + 1 <= getBottomRow() + 1 ? visibleCellFrom(row + 1, col, 1) : null;
    }
  }
  if (target) {
    moveSelectionTo(target, e.shiftKey);
  }
  return true;
};

// Start editing the active cell. IME composition (e.g. Japanese input) begins
// with a 'Process' keydown; the editor must be focused before composition
// starts, so the default action is not prevented.
const isImeKey = e => e.isComposing || e.key === 'Process' || e.keyCode === 229;

const isInChrome = target => {
  const node = getElementTarget(target);
  return !!(node && node.closest('.csv-commandbar, .cell-bar, #csvPanel, #contextMenu, #findReplaceWidget'));
};

document.addEventListener('keydown', e => {
  if (maybeHandleZoomShortcut(e)) {
    return;
  }
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.altKey && key === 'f') {
    e.preventDefault();
    openFindReplace(false);
    return;
  }
  if (ctrl && !e.altKey && key === 'h') {
    e.preventDefault();
    openFindReplace(true);
    return;
  }
  if (findReplaceState.open && ctrl && key === 'g') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (findReplaceState.open && e.key === 'F3') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (isFindWidgetTarget(e.target) || isInChrome(e.target)) {
    return;
  }

  // Escape: close the innermost thing first.
  if (e.key === 'Escape') {
    if (hideContextMenu()) { e.preventDefault(); return; }
    if (editingCell) {
      // textContent (not innerText) so newlines are restored as text, not <br>.
      e.preventDefault(); editingCell.textContent = originalCellValue; editingCell.blur();
      if (anchorCell?.isConnected) { try { anchorCell.focus({ preventScroll: true }); } catch {} }
      return;
    }
    if (findReplaceState.open) { e.preventDefault(); closeFindReplace(); return; }
    if (activePanel) { e.preventDefault(); closePanel(); return; }
    if (currentSelection.length > 1 && anchorCell) {
      setSingleSelection(anchorCell);
    }
    return;
  }

  if (!editingCell) {
    if (ctrl && !e.altKey && key === 'a') {
      e.preventDefault(); selectAllCells(); return;
    }
    if (ctrl && !e.altKey && key === 'c' && currentSelection.length > 0) {
      e.preventDefault(); copySelectionToClipboard(); return;
    }
    if (ctrl && !e.altKey && key === 'x' && currentSelection.length > 0) {
      e.preventDefault(); cutSelection(); return;
    }
    // Clear contents of selected cells as one undoable edit.
    if (currentSelection.length > 0 && (e.key === 'Delete' || e.key === 'Backspace') && !ctrl) {
      e.preventDefault();
      clearSelectedCells();
      return;
    }
  }

  if (!editingCell && e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const refCell = anchorCell || getCellTarget(document.activeElement) || currentSelection[0] || document.querySelector('td.selected, th.selected');
    if (!refCell) return;
    const coords = getCellCoords(refCell);
    if (!coords || !Number.isInteger(coords.row) || !Number.isInteger(coords.col) || coords.col < 0) {
      return;
    }
    const minCol = 0;
    const maxCol = getMaxCol();
    const isBackward = !!e.shiftKey;
    let targetRow = coords.row;
    let targetCol = coords.col + (isBackward ? -1 : 1);
    if (!isBackward && targetCol > maxCol) {
      targetRow += 1;
      targetCol = minCol;
    } else if (isBackward && targetCol < minCol) {
      if (targetRow <= TOP_ROW) {
        return;
      }
      targetRow -= 1;
      targetCol = maxCol;
    }
    const nextCell = ensureRenderedCellByCoords(targetRow, targetCol);
    if (nextCell) {
      setSingleSelection(nextCell);
    }
    return;
  }

  /* ──────── EDIT ENTRY: Enter, F2, direct typing, IME ──────── */
  const activeCell = anchorCell && isDataCell(anchorCell) ? anchorCell : null;
  if (!editingCell && activeCell) {
    if (currentSelection.length > 1 && (e.key === 'Enter' || e.key === 'F2' || isImeKey(e) || (e.key.length === 1 && !ctrl && !e.altKey))) {
      // Editing always targets the active cell, like spreadsheets.
      setSingleSelection(activeCell);
    }
  }
  // Row numbers are not editable values.
  if (!editingCell && anchorCell && !isDataCell(anchorCell) && (e.key === 'Enter' || e.key === 'F2' || isImeKey(e) || (e.key.length === 1 && !ctrl && !e.altKey))) {
    e.preventDefault();
    return;
  }
  if (!editingCell && anchorCell && currentSelection.length === 1) {
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const cell = anchorCell;
      // Detail edit via Enter / F2
      editCell(cell, undefined, 'detail');
      if (e.key === 'Enter' && e.shiftKey) {
        // Shift+Enter from selection should open detail edit and insert
        // a newline immediately on the very first keypress.
        appendVisibleNewlineAtEnd(cell);
      }
      return;
    }
    if (isImeKey(e)) {
      const cell = anchorCell;
      // Do not preventDefault: the IME composes straight into the cell.
      cell.textContent = '';
      editCell(cell, undefined, 'quick', { keepCaret: true });
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const cell = anchorCell;
      // Quick edit via direct typing: start edit and inject the first char.
      editCell(cell, undefined, 'quick');
      // Overwrite existing content with the typed character.
      cell.textContent = e.key;
      setCursorToEnd(cell);
      return;
    }
  }

  /* ──────── NAVIGATION ──────── */
  if (!editingCell && (NAV_KEYS.includes(e.key) || e.key === 'PageUp' || e.key === 'PageDown')) {
    if (handleNavigationKey(e)) {
      e.preventDefault();
    }
    return;
  }

  // Keys that confirm or navigate an IME composition belong to the IME.
  if (editingCell && isImeKey(e)) {
    return;
  }

  // QUICK EDIT: Arrow keys commit and move selection (no re-entering edit)
  if (editingCell && editMode === 'quick' && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const cellRef = editingCell;
    cellRef.blur();
    setSingleSelection(cellRef);
    handleNavigationKey({ key: e.key, shiftKey: false, ctrlKey: false, metaKey: false });
    return;
  }

  // DETAIL EDIT: Arrow Up/Down go to start/end of contents; Left/Right default caret move
  if (editingCell && editMode === 'detail' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (e.key === 'ArrowUp') setCursorToStart(editingCell);
    if (e.key === 'ArrowDown') setCursorToEnd(editingCell);
    return;
  }

  if (editingCell && ((e.ctrlKey || e.metaKey) && key === 's')) {
    e.preventDefault();
    editingCell.blur();
    vscode.postMessage({ type: 'save' });
  }
  if (editingCell && e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey || e.altKey) {
      if (!insertNewlineAtCaret(editingCell)) {
        appendVisibleNewlineAtEnd(editingCell);
      }
      return;
    }
    const { row, col } = getCellCoords(editingCell);
    const editedCell = editingCell;
    editingCell.blur();
    const targetRow = row + 1;
    // Editing Enter commits and moves selection down (no auto-edit).
    const nextCell = ensureRenderedCellByCoords(targetRow, col);
    if (nextCell) {
      setSingleSelection(nextCell);
    } else {
      setSingleSelection(editedCell);
      try {
        const st = vscode.getState() || {};
        vscode.setState({ ...st, anchorRow: targetRow, anchorCol: col });
      } catch {}
    }
  }
  if (editingCell && e.key === 'Tab') {
    e.preventDefault();
    const cell = editingCell;
    const { row, col } = getCellCoords(cell);
    const maxCol = getMaxCol();
    const isBackward = !!e.shiftKey;
    let targetRow = row;
    let targetCol = col + (isBackward ? -1 : 1);
    let canMove = true;
    if (!isBackward && targetCol > maxCol) {
      targetRow += 1;
      targetCol = 0;
    } else if (isBackward && targetCol < 0) {
      if (targetRow <= TOP_ROW) {
        canMove = false;
      } else {
        targetRow -= 1;
        targetCol = maxCol;
      }
    }
    cell.blur();
    // Editing Tab commits and moves selection only (no auto-edit).
    const nextCell = canMove ? ensureRenderedCellByCoords(targetRow, targetCol) : null;
    if (nextCell) {
      setSingleSelection(nextCell);
    } else {
      setSingleSelection(cell);
    }
  }
});

document.addEventListener('paste', e => {
  if (isFindWidgetTarget(e.target)) {
    return;
  }
  if (editingCell) {
    return;
  }
  const clipboard = e.clipboardData;
  if (!clipboard) {
    return;
  }
  const text = clipboard.getData('text/plain');
  if (typeof text !== 'string' || text.length === 0) {
    return;
  }
  const anchor = getPasteAnchorCoords();
  if (!anchor) {
    return;
  }
  e.preventDefault();
  const selection = getDataSelectionBounds();
  vscode.postMessage({
    type: 'pasteCells',
    text,
    anchorRow: anchor.row,
    anchorCol: anchor.col,
    selection: selection || undefined
  });
});

// Remembers the selection array created by select-all; any later selection
// change replaces or grows the array, which invalidates it.
let selectAllSelection = null, selectAllLength = 0;
const isSelectAllActive = () => selectAllSelection !== null &&
  currentSelection === selectAllSelection && currentSelection.length === selectAllLength;

const selectAllCells = () => {
  clearSelection();
  table.querySelectorAll('td[data-col], th[data-col]').forEach(cell => {
    cell.classList.add('selected');
    currentSelection.push(cell);
  });
  selectionKind = 'all';
  selectAllSelection = currentSelection;
  selectAllLength = currentSelection.length;
  queueModernStatusUpdate();
};

const setCursorToEnd = cell => { setTimeout(() => { 
  const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}, 10); };

const setCursorToStart = cell => { setTimeout(() => {
  const range = document.createRange(); range.selectNodeContents(cell); range.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}, 10); };

const setCursorAtPoint = (cell, x, y) => {
  let range;
  if(document.caretRangeFromPoint) { range = document.caretRangeFromPoint(x,y); }
  else if(document.caretPositionFromPoint) { let pos = document.caretPositionFromPoint(x,y); range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  if(range){ let sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
};

const getDataColumnBounds = () => {
  const cols = Array.from(table.querySelectorAll('td[data-col], th[data-col]'))
    .map(el => parseInt(el.getAttribute('data-col') || 'NaN', 10))
    .filter(col => Number.isInteger(col) && col >= 0);
  if (!cols.length) {
    return null;
  }
  return { minCol: Math.min(...cols), maxCol: Math.max(...cols) };
};

const setSingleSelection = cell => {
  if (!cell) return;
  clearSelection();
  cell.classList.add('selected');
  currentSelection.push(cell);
  anchorCell = cell;
  rangeEndCell = cell;
  persistState();
  try { cell.focus({ preventScroll: true }); } catch { try { cell.focus(); } catch {} }
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
};

const NEWLINE_SENTINEL_ATTR = 'data-csv-newline-sentinel';
const removeNewlineSentinels = cell => {
  if (!cell) return;
  cell.querySelectorAll(`[${NEWLINE_SENTINEL_ATTR}="true"]`).forEach(node => node.remove());
};

const placeCaretBeforeSentinel = sentinel => {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (sentinel.firstChild) {
    range.setStart(sentinel.firstChild, 0);
  } else {
    range.setStartBefore(sentinel);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
};

const appendVisibleNewlineAtEnd = cell => {
  removeNewlineSentinels(cell);
  const sentinel = document.createElement('span');
  sentinel.setAttribute(NEWLINE_SENTINEL_ATTR, 'true');
  sentinel.textContent = '\u200B';
  cell.appendChild(document.createTextNode('\n'));
  cell.appendChild(sentinel);
  placeCaretBeforeSentinel(sentinel);
};

const isRangeAtEndOfCell = (cell, range) => {
  const probe = document.createRange();
  probe.selectNodeContents(cell);
  probe.setEnd(range.endContainer, range.endOffset);
  const caretOffset = probe.toString().length;
  return caretOffset >= (cell.textContent || '').length;
};

const insertNewlineAtCaret = cell => {
  removeNewlineSentinels(cell);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) return false;
  const atEnd = range.collapsed && isRangeAtEndOfCell(cell, range);
  range.deleteContents();
  if (atEnd) {
    const sentinel = document.createElement('span');
    sentinel.setAttribute(NEWLINE_SENTINEL_ATTR, 'true');
    sentinel.textContent = '\u200B';
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode('\n'));
    fragment.appendChild(sentinel);
    range.insertNode(fragment);
    placeCaretBeforeSentinel(sentinel);
    return true;
  }
  const newlineNode = document.createTextNode('\n');
  range.insertNode(newlineNode);
  range.setStartAfter(newlineNode);
  range.setEndAfter(newlineNode);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
};

const editCell = (cell, event, mode = 'detail', options = {}) => {
  if(editingCell === cell) return;
  if(editingCell) editingCell.blur();
  cell.classList.remove('selected');
  originalCellValue = cell.textContent;
  editingCell = cell;
  editMode = mode;
  cell.classList.add('editing');
  cell.setAttribute('contenteditable', 'true');
  cell.focus();
  const onBlurHandler = () => {
    removeNewlineSentinels(cell);
    const value = cell.textContent;
    const coords = getCellCoords(cell);
    vscode.postMessage({ type: 'editCell', row: coords.row, col: coords.col, value: value });
    cell.removeAttribute('contenteditable');
    cell.classList.remove('editing');
    editingCell = null;
    editMode = null;
    cell.removeEventListener('blur', onBlurHandler);
  };
  cell.addEventListener('blur', onBlurHandler);
  if (options.keepCaret) return;
  event ? setCursorAtPoint(cell, event.clientX, event.clientY) : setCursorToEnd(cell);
};

table.addEventListener('dblclick', e => {
  const edgeTarget = getCellTarget(e.target);
  if (edgeTarget?.classList.contains('sheet-column-header') || edgeTarget?.classList.contains('sheet-corner')) {
    return;
  }
  const edge = getResizeEdgeInfo(edgeTarget, e);
  if (edge) {
    e.preventDefault();
    e.stopPropagation();
    if (edge.axis === 'column') {
      resetColumnWidth(edge.index);
    } else {
      resetRowHeight(edge.index);
    }
    persistState();
    return;
  }
  const link = getLinkTarget(e.target);
  if (link) {
    e.preventDefault();
    // Ctrl/Cmd+click is handled by the click listener; do not enter edit mode here.
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      return;
    }
  }
  const target = getCellTarget(e.target);
  if (!target || !isDataCell(target)) return;
  clearSelection();
  editCell(target, e);
});

const copySelectionToClipboard = () => {
  if (currentSelection.length === 0) return;
  // Select-all only covers rendered chunks; let the extension copy every row.
  if (typeof isSelectAllActive === 'function' && isSelectAllActive()) {
    vscode.postMessage({ type: 'copyAll', filter: typeof quickFilterQuery === 'string' ? quickFilterQuery : '' });
    if (typeof showToast === 'function') showToast(t('copiedAll'));
    return;
  }

  // Only copy real data/header columns; skip serial index column (col === -1)
  const coords = currentSelection
    .map(cell => getCellCoords(cell))
    .filter(c => !isNaN(c.row) && !isNaN(c.col) && c.col >= 0);
  if (coords.length === 0) return;
  const minRow = Math.min(...coords.map(c => c.row)), maxRow = Math.max(...coords.map(c => c.row));
  const minCol = Math.min(...coords.map(c => c.col)), maxCol = Math.max(...coords.map(c => c.col));
  const rows = [];
  for(let r = minRow; r <= maxRow; r++){
    const tag = r === HEADER_ROW ? 'th' : 'td';
    // Like spreadsheets, skip rows hidden by the quick filter.
    const rowEl = table.querySelector(tag + '[data-row="'+r+'"]')?.closest?.('tr');
    if (rowEl && rowEl.style.display === 'none') continue;
    let rowVals = [];
    for(let c = minCol; c <= maxCol; c++){
      const selector = tag + '[data-row="'+r+'"][data-col="'+c+'"]';
      const cell = table.querySelector(selector);
      const value = cell ? cell.textContent : '';
      rowVals.push(/[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value);
    }
    rows.push(rowVals.join('\t'));
  }
  vscode.postMessage({ type: 'copyToClipboard', text: rows.join('\n') });
  if (typeof showToast === 'function') showToast(t('copied', { n: coords.length }));
};

// Clear the selected data cells in one undoable edit.
const clearSelectedCells = () => {
  if (isSelectAllActive()) {
    vscode.postMessage({ type: 'clearAll', filter: quickFilterQuery });
    return;
  }
  const cells = currentSelection.filter(cell => isDataCell(cell) && !isRowHidden(cell) && cell.textContent !== '');
  if (!cells.length) return;
  const replacements = cells.map(cell => {
    const { row, col } = getCellCoords(cell);
    cell.textContent = '';
    return { row, col, value: '' };
  });
  vscode.postMessage({ type: 'replaceCells', replacements });
  showToast(t('cleared', { n: replacements.length }));
  queueModernStatusUpdate();
};

const cutSelection = () => {
  if (!currentSelection.some(isDataCell)) return;
  const selectAll = isSelectAllActive();
  copySelectionToClipboard();
  if (selectAll) {
    vscode.postMessage({ type: 'clearAll', filter: quickFilterQuery });
  } else {
    clearSelectedCells();
  }
};

// Menu-driven paste: the webview cannot read the clipboard itself, so the
// extension reads it and applies the same paste logic as Ctrl+V.
const pasteFromExtensionClipboard = () => {
  const anchor = getPasteAnchorCoords();
  if (!anchor) return;
  vscode.postMessage({
    type: 'pasteFromClipboard',
    anchorRow: anchor.row,
    anchorCol: anchor.col,
    selection: getDataSelectionBounds() || undefined
  });
};

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'uiCommand') {
    if (message.command === 'find') openFindReplace(false);
    if (message.command === 'replace') openFindReplace(true);
    if (message.command === 'dataTools') showToolsPanel();
    if (message.command === 'validate') showValidatePanel();
    if (message.command === 'filter') (activePanel === 'filter' ? closePanel() : showFilterPanel());
  } else if (message.type === 'dataToolPreview') {
    renderToolPreview(message);
  } else if (message.type === 'validationResult') {
    renderValidation(Array.isArray(message.issues) ? message.issues : []);
  } else if(message.type === 'focus'){
    if (anchorCell) {
      try { anchorCell.focus({ preventScroll: true }); } catch { try { anchorCell.focus(); } catch {} }
    } else {
      try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }
    }
  } else if (message.type === 'chunkData') {
    const requestId = Number(message.requestId);
    const start = Number(message.start);
    if (remoteChunkRequestInFlight) {
      if (!Number.isInteger(requestId) || requestId !== remoteChunkRequestSeq) {
        return;
      }
      if (!Number.isInteger(start) || start !== remoteChunkRequestedStart) {
        return;
      }
    }
    remoteChunkRequestInFlight = false;
    remoteChunkRequestedStart = -1;
    const html = typeof message.html === 'string' ? message.html : '';
    const nextStart = Number(message.nextStart);
    const done = !!message.done;
    if (html.length > 0) {
      csvChunks.push(html);
    }
    if (!done && Number.isInteger(nextStart) && nextStart >= 0) {
      remoteNextChunkStart = nextStart;
      remoteHasMoreChunks = true;
    } else {
      remoteNextChunkStart = -1;
      remoteHasMoreChunks = false;
    }
    if (csvChunks.length && pendingEnsureTarget) {
      ensureTargetStep();
    } else if (csvChunks.length && nearBottom()) {
      loadNextChunk();
    }
  } else if(message.type === 'updateCell'){
    isUpdating = true;
    const { row, col, value, rendered } = message;
    const cell = table.querySelector('td[data-row="'+row+'"][data-col="'+col+'"], th[data-row="'+row+'"][data-col="'+col+'"]');
    if (cell) {
      if (typeof rendered === 'string') {
        cell.innerHTML = rendered;
      } else {
        cell.textContent = value;
      }
    }
    isUpdating = false;
    if (findReplaceState.open && findInput.value) {
      scheduleFind(true);
    }
  } else if (message.type === 'pasteApplied') {
    const startRow = Number(message.startRow);
    const startCol = Number(message.startCol);
    const endRow = Number(message.endRow);
    const endCol = Number(message.endCol);
    if (
      !Number.isInteger(startRow) || !Number.isInteger(startCol) ||
      !Number.isInteger(endRow) || !Number.isInteger(endCol) ||
      startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol
    ) {
      return;
    }
    const startCell = ensureRenderedCellByCoords(startRow, startCol);
    const endCell = ensureRenderedCellByCoords(endRow, endCol);
    if (!startCell || !endCell) {
      return;
    }
    anchorCell = startCell;
    rangeEndCell = endCell;
    selectRange({ row: startRow, col: startCol }, { row: endRow, col: endCol });
    persistState();
    try { startCell.focus({ preventScroll: true }); } catch { try { startCell.focus(); } catch {} }
    endCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
  } else if (message.type === 'findMatchesResult') {
    if (!findReplaceState.open) {
      return;
    }
    const requestId = Number(message.requestId);
    const requestState = pendingFindRequests.get(requestId);
    pendingFindRequests.delete(requestId);
    if (!Number.isInteger(requestId) || requestId !== latestFindRequestId) {
      return;
    }

    findReplaceState.invalidRegex = !!message.invalidRegex;
    findMatchesTruncated = !!message.truncated;
    findMatches = Array.isArray(message.matches)
      ? message.matches
        .map(raw => {
          const row = Number(raw?.row);
          const col = Number(raw?.col);
          if (!Number.isInteger(row) || row < 0 || !Number.isInteger(col) || col < 0) {
            return null;
          }
          return { row, col, value: String(raw?.value ?? '') };
        })
        .filter(Boolean)
      : [];
    findMatchKeySet = new Set(findMatches.map(match => getFindMatchKey(match.row, match.col)));

    clearFindHighlights();
    applyFindHighlightsToRendered();
    if (findMatches.length > 0) {
      const preserveIndex = !!requestState?.preserveIndex;
      const priorIndex = Number.isInteger(requestState?.priorIndex) ? requestState.priorIndex : -1;
      const nextIndex = preserveIndex && priorIndex >= 0
        ? Math.min(priorIndex, findMatches.length - 1)
        : 0;
      setActiveFindMatch(nextIndex);
    } else {
      currentMatchIndex = -1;
      updateFindStatus();
      updateFindControls();
    }
  }
});

// After initial restoreState, if there's a pending edit request, perform it
const maybeResumePendingEdit = () => {
  try {
    const st = vscode.getState() || {};
    if (st && typeof st.anchorRow === 'number' && typeof st.anchorCol === 'number' && st.pendingEdit === 'detail') {
      const tag = (st.anchorRow === HEADER_ROW ? 'th' : 'td');
      const sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
      if (sel) {
        editCell(sel, undefined, 'detail');
        // clear pending flag
        const next = { ...st };
        delete next.pendingEdit;
        vscode.setState(next);
      }
    }
  } catch {}
};

// Try after load and after visibility/focus restores
setTimeout(maybeResumePendingEdit, 0);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(maybeResumePendingEdit, 0); });
window.addEventListener('focus', () => { setTimeout(maybeResumePendingEdit, 0); }, { passive: true });

// Restore panels, filter and find after the full re-render that follows a
// structural edit, so the user's working context is not lost.
const restoreUiState = () => {
  const ui = readUiState();
  if (quickFilterQuery) applyQuickFilter();
  if (ui.find && ui.find.open) {
    findInput.value = String(ui.find.query || '');
    replaceInput.value = String(ui.find.replacement || '');
    findReplaceState.matchCase = !!ui.find.matchCase;
    findReplaceState.wholeWord = !!ui.find.wholeWord;
    findReplaceState.regex = !!ui.find.regex;
    findReplaceState.preserveCase = !!ui.find.preserveCase;
    openFindReplace(!!ui.find.replaceExpanded, false);
  }
  const notice = ui.notice ? String(ui.notice) : '';
  if (notice) writeUiState({ notice: '' });
  if (ui.panel === 'filter') showFilterPanel(false);
  else if (ui.panel === 'tools') showToolsPanel(notice);
  else if (ui.panel === 'validate') showValidatePanel();
  else if (notice) showToast(notice);
};
restoreUiState();
