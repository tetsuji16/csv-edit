import Papa from 'papaparse';
import * as vscode from 'vscode';
import * as path from 'path';
import { applyDataTool, DataToolOptions, DataToolRequest, validateCsvRows } from './data-tools';
import { CsvDocumentModel } from './csv-document-model';
import { parseWebviewMessage } from './webview-protocol';

type SeparatorMode = 'extension' | 'auto' | 'default';
type SeparatorSettings = {
  mode: SeparatorMode;
  defaultSeparator: string;
  byExtension: Record<string, string>;
};
type CsvFieldSpan = {
  start: number;
  end: number;
  quoted: boolean;
};
type PasteSelectionBounds = {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  rectangular: boolean;
};
type PastePlan = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  fillSelection: boolean;
};
type PasteApplyResult = {
  changed: boolean;
  structuralChange: boolean;
  updates: Array<{ row: number; col: number; value: string }>;
  plan: PastePlan;
};
type ChunkRenderState = {
  startAbs: number;
  allRows: string[][];
  allRowsCount: number;
  chunkRows: number;
  includeTrailingEmptyRow: boolean;
  addSerialIndex: boolean;
  numColumns: number;
  columnWidths: number[];
  columnColors: string[];
  clickableLinks: boolean;
  isDark: boolean;
  serialIndexWidthCh: number;
};
type ChunkResponse = {
  html: string;
  nextStart: number;
  done: boolean;
};

// Per-document controller. Manages one webview + document.
class CsvEditorController {
  // Note: Global registry lives on CsvEditorProvider (wrapper)

  private static readonly BYTES_PER_MB = 1024 * 1024;
  private static readonly DEFAULT_MAX_FILE_SIZE_MB = 10;
  private static readonly LARGE_FILE_CONTINUE_THIS_TIME = 'Continue This Time';
  private static readonly LARGE_FILE_IGNORE_FOREVER = 'Ignore Forever';

  private isUpdatingDocument = false;
  private isSaving = false;
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;
  private separatorCache: { version: number; configKey: string; separator: string } | undefined;
  private isDiffContext = false;
  private chunkRenderState: ChunkRenderState | undefined;
  private documentMutationQueue: Promise<void> = Promise.resolve();
  private readonly documentModel = new CsvDocumentModel();

  constructor(private readonly context: vscode.ExtensionContext) {}

  // (no static helpers here; see wrapper CsvEditorProvider)

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;

    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const csvEditConfig = vscode.workspace.getConfiguration('csvEdit', this.document.uri);
    if (csvEditConfig.get<'grid' | 'text'>('defaultView', 'grid') === 'text') {
      await this.openWithDefaultEditorAndClose(webviewPanel, document.uri);
      return;
    }
    if (!config.get<boolean>('enabled', true)) {
      // When disabled, immediately hand off to the default editor and close this tab
      await this.openWithDefaultEditorAndClose(webviewPanel, document.uri);
      return;
    }

    const proceed = await this.confirmLargeFileOpen(config, webviewPanel, _token);
    if (!proceed) {
      return;
    }

    this.currentWebviewPanel = webviewPanel;
    CsvEditorProvider.editors.push(this);

    webviewPanel.webview.options = {
      enableScripts: true,
      // Use file path for compatibility with older VS Code types (no Uri.joinPath)
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    this.refreshDiffContext(webviewPanel);
    this.updateWebviewContent();

    if (webviewPanel.active) {
      CsvEditorProvider.currentActive = this;
    }

    webviewPanel.webview.postMessage({ type: 'focus' });
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        const diffChanged = this.refreshDiffContext(e.webviewPanel);
        if (diffChanged) {
          this.updateWebviewContent();
        }
        e.webviewPanel.webview.postMessage({ type: 'focus' });
        CsvEditorProvider.currentActive = this;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async rawMessage => {
      const e = parseWebviewMessage(rawMessage);
      if (!e) {
        console.warn('CSV Edit: ignored invalid webview message');
        return;
      }
      switch (e.type) {
        case 'editCell':
          await this.enqueueDocumentMutation(() => this.updateDocument(e.row, e.col, e.value));
          break;
        case 'replaceCells':
          await this.enqueueDocumentMutation(() => this.replaceCells(e.replacements));
          break;
        case 'pasteCells':
          await this.enqueueDocumentMutation(() => this.pasteCells(e.text, e.anchorRow, e.anchorCol, e.selection));
          break;
        case 'requestChunk':
          await this.requestChunk(e.start, e.requestId);
          break;
        case 'findMatches':
          await this.findMatches(e.requestId, e.query, e.options);
          break;
        case 'save':
          await this.enqueueDocumentMutation(() => this.handleSave());
          break;
        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(e.text);
          console.log('CSV: Copied to clipboard');
          break;
        case 'insertColumn':
          await this.enqueueDocumentMutation(() => this.insertColumn(e.index));
          break;
        case 'insertColumns':
          await this.enqueueDocumentMutation(() => this.insertColumns(e.index, e.count));
          break;
        case 'deleteColumn':
          await this.enqueueDocumentMutation(() => this.deleteColumn(e.index));
          break;
        case 'deleteColumns':
          await this.enqueueDocumentMutation(() => this.deleteColumns(e.indices));
          break;
        case 'insertRow':
          await this.enqueueDocumentMutation(() => this.insertRow(e.index));
          break;
        case 'insertRows':
          await this.enqueueDocumentMutation(() => this.insertRows(e.index, e.count));
          break;
        case 'deleteRow':
          await this.enqueueDocumentMutation(() => this.deleteRow(e.index));
          break;
        case 'deleteRows':
          await this.enqueueDocumentMutation(() => this.deleteRows(e.indices));
          break;
        case 'reorderColumns':
          await this.enqueueDocumentMutation(() => this.reorderColumns(e.indices, e.beforeIndex));
          break;
        case 'reorderRows':
          await this.enqueueDocumentMutation(() => this.reorderRows(e.indices, e.beforeIndex));
          break;
        case 'sortColumn':
          await this.enqueueDocumentMutation(() => this.sortColumn(e.index, e.ascending));
          break;
        case 'openLink':
          await this.openLinkExternally(e.url);
          break;
        case 'previewDataTool':
          await this.previewDataTool(e.request);
          break;
        case 'applyDataTool':
          await this.enqueueDocumentMutation(() => this.applyDataTool(e.request));
          break;
        case 'validateData':
          await this.validateData();
          break;
        case 'openTextView':
          await vscode.workspace.getConfiguration('csvEdit').update(
            'defaultView',
            'text',
            vscode.ConfigurationTarget.Global
          );
          await vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default', {
            preview: false,
            preserveFocus: false
          });
          break;
        case 'undo':
          await this.enqueueDocumentMutation(async () => {
            await vscode.commands.executeCommand('undo');
          });
          break;
        case 'redo':
          await this.enqueueDocumentMutation(async () => {
            await vscode.commands.executeCommand('redo');
          });
          break;
        case 'cycleTheme': {
          const cfg = vscode.workspace.getConfiguration('csvEdit');
          const current = cfg.get<'auto' | 'light' | 'dark'>('theme', 'auto');
          const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
          await cfg.update('theme', next, vscode.ConfigurationTarget.Global);
          CsvEditorProvider.editors.forEach(editor => editor.refresh());
          break;
        }
      }
    });

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !this.isUpdatingDocument &&
        !this.isSaving
      ) {
        setTimeout(() => this.updateWebviewContent(), 250);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      CsvEditorProvider.editors = CsvEditorProvider.editors.filter(ed => ed !== this);
      this.currentWebviewPanel = undefined;
    });
  }

  private getMaxFileSizeLimitMb(config: vscode.WorkspaceConfiguration): number {
    const raw = Number(config.get<number>('maxFileSizeMB', CsvEditorController.DEFAULT_MAX_FILE_SIZE_MB));
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    return raw;
  }

  private shouldPromptForLargeFile(fileSizeBytes: number, maxFileSizeMB: number): boolean {
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
      return false;
    }
    if (!Number.isFinite(maxFileSizeMB) || maxFileSizeMB <= 0) {
      return false;
    }
    const thresholdBytes = Math.floor(maxFileSizeMB * CsvEditorController.BYTES_PER_MB);
    return fileSizeBytes > thresholdBytes;
  }

  private formatSizeMb(fileSizeBytes: number): string {
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
      return '0.0';
    }
    return (fileSizeBytes / CsvEditorController.BYTES_PER_MB).toFixed(1);
  }

  private async openWithDefaultEditorAndClose(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
    try {
      const opts: any = {
        viewColumn: webviewPanel.viewColumn,
        preserveFocus: !webviewPanel.active,
        preview: webviewPanel.active ? webviewPanel.active : false
      };
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', opts);
    } finally {
      try { webviewPanel.dispose(); } catch {}
    }
  }

  /**
   * Re-open the current document in the grid editor or the default text editor,
   * depending on the requested target view. Used when the user changes the
   * `csvEdit.defaultView` setting so the open editor follows immediately.
   */
  public async switchView(target: 'grid' | 'text'): Promise<void> {
    const alreadyGrid = this.currentWebviewPanel !== undefined;
    if (target === 'grid' && alreadyGrid) { return; }
    if (target === 'text' && !alreadyGrid) { return; }
    const uri = this.document.uri;
    const viewType = target === 'grid' ? CsvEditorProvider.viewType : 'default';
    const opts: any = {
      viewColumn: this.currentWebviewPanel?.viewColumn,
      preserveFocus: false,
      preview: false
    };
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, opts);
    } catch (e) {
      console.error('CSV: switchView failed', e);
    }
  }

  private async confirmLargeFileOpen(
    config: vscode.WorkspaceConfiguration,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    const maxFileSizeMB = this.getMaxFileSizeLimitMb(config);
    if (maxFileSizeMB <= 0) {
      return true;
    }

    let sizeBytes = 0;
    try {
      const stat = await vscode.workspace.fs.stat(this.document.uri);
      sizeBytes = Number(stat.size);
    } catch (err) {
      console.warn(`CSV: unable to stat file size for ${this.document.uri.toString()}`, err);
      return true;
    }

    if (token.isCancellationRequested) {
      return false;
    }
    if (!this.shouldPromptForLargeFile(sizeBytes, maxFileSizeMB)) {
      return true;
    }

    const fileLabel = path.basename(this.document.uri.fsPath || this.document.uri.path || this.document.uri.toString());
    const selected = await vscode.window.showWarningMessage(
      `CSV: "${fileLabel}" is ${this.formatSizeMb(sizeBytes)} MB and exceeds the csv.maxFileSizeMB limit (${maxFileSizeMB} MB).`,
      {
        modal: true,
        detail: 'Opening large files in CSV view can be slow and block the editor.'
      },
      CsvEditorController.LARGE_FILE_CONTINUE_THIS_TIME,
      CsvEditorController.LARGE_FILE_IGNORE_FOREVER
    );

    if (selected === CsvEditorController.LARGE_FILE_CONTINUE_THIS_TIME) {
      return true;
    }
    if (selected === CsvEditorController.LARGE_FILE_IGNORE_FOREVER) {
      await vscode.workspace
        .getConfiguration('csv')
        .update('maxFileSizeMB', 0, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('CSV: Large-file prompt disabled (csv.maxFileSizeMB = 0).');
      return true;
    }

    try { webviewPanel.dispose(); } catch {}
    return false;
  }

  public refresh() {
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    if (!config.get<boolean>('enabled', true)) {
      this.currentWebviewPanel?.dispose();
      vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
    } else {
      if (this.currentWebviewPanel) {
        this.forceReload();
      }
    }
  }

  public postUiCommand(command: string, payload?: unknown): Thenable<boolean> {
    return this.currentWebviewPanel?.webview.postMessage({ type: 'uiCommand', command, payload })
      ?? Promise.resolve(false);
  }

  private forceReload() {
    if (!this.currentWebviewPanel) {return;}
    const panel = this.currentWebviewPanel;
    // First, blank the DOM to ensure a full script/style reinit on next set
    panel.webview.html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>';
    setTimeout(() => {
      try {
        this.updateWebviewContent();
      } catch (err) {
        console.error('CSV: forceReload failed', err);
      }
    }, 0);
  }

  public isActive(): boolean {
    return !!this.currentWebviewPanel?.active;
  }

  private refreshDiffContext(webviewPanel: vscode.WebviewPanel): boolean {
    const next = this.isLikelyDiffContext(webviewPanel, this.document.uri);
    const changed = next !== this.isDiffContext;
    this.isDiffContext = next;
    return changed;
  }

  private isLikelyDiffContext(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri): boolean {
    if (uri.scheme === 'git') {
      return true;
    }

    const title = webviewPanel.title || '';
    if (title.includes('↔')) {
      return true;
    }

    const key = uri.toString();
    const tabGroups = (vscode.window as any)?.tabGroups?.all;
    if (!Array.isArray(tabGroups)) {
      return false;
    }
    for (const group of tabGroups) {
      const activeTab: any = group?.activeTab;
      const input: any = activeTab?.input;
      const original: unknown = input?.original;
      const modified: unknown = input?.modified;
      if (original instanceof vscode.Uri && modified instanceof vscode.Uri) {
        if (original.toString() === key || modified.toString() === key) {
          return true;
        }
      }
    }
    return false;
  }

  private static resolveEffectiveColumnColorMode(
    baseMode: string,
    isDiffContext: boolean,
    useThemeForegroundInDiff: boolean
  ): 'type' | 'theme' {
    const normalizedBase: 'type' | 'theme' = baseMode === 'theme' ? 'theme' : 'type';
    if (isDiffContext && useThemeForegroundInDiff) {
      return 'theme';
    }
    return normalizedBase;
  }

  private static normalizeFontSize(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return Math.round(parsed * 100) / 100;
  }

  private static resolveEffectiveFontSize(csvFontSize: unknown, editorFontSize: unknown): number {
    return (
      CsvEditorController.normalizeFontSize(csvFontSize) ??
      CsvEditorController.normalizeFontSize(editorFontSize) ??
      14
    );
  }

  public getDocumentUri(): vscode.Uri {
    return this.document.uri;
  }

  public getCurrentSeparator(): string {
    return this.getSeparator();
  }

  private parseCurrentRows(): string[][] {
    return this.documentModel.read(
      this.document.version,
      this.document.getText(),
      this.getSeparator()
    ).rows;
  }

  private enqueueDocumentMutation(operation: () => Promise<void>): Promise<void> {
    const queued = this.documentMutationQueue.then(operation);
    this.documentMutationQueue = queued
      .catch(error => {
        console.error('CSV Edit: document mutation failed', error);
      })
      .finally(() => {
        // Several structural-edit paths touch this guard. Reset it centrally so
        // a rejected VS Code edit cannot permanently suppress document refreshes.
        this.isUpdatingDocument = false;
      });
    return this.documentMutationQueue;
  }

  private getDataToolOptions(rows: string[][]): DataToolOptions {
    const hiddenRows = Math.min(Math.max(0, this.getHiddenRows()), rows.length);
    const protectedRowCount = hiddenRows + (this.getEffectiveHeader(rows, hiddenRows) ? 1 : 0);
    return protectedRowCount > 0
      ? { duplicateExemptRows: Array.from({ length: protectedRowCount }, (_, index) => index) }
      : {};
  }

  /** Serialize structural edits while retaining the document's BOM and line ending. */
  private serializeRows(rows: string[][], separator: string): string {
    const snapshot = this.documentModel.read(
      this.document.version,
      this.document.getText(),
      separator
    );
    return this.documentModel.serialize(rows, snapshot);
  }

  private async previewDataTool(request: DataToolRequest): Promise<void> {
    await this.documentMutationQueue;
    const rows = this.parseCurrentRows();
    const result = applyDataTool(rows, request, this.getDataToolOptions(rows));
    await this.currentWebviewPanel?.webview.postMessage({
      type: 'dataToolPreview',
      request,
      changedCells: result.changedCells,
      removedRows: result.removedRows,
      samples: result.samples
    });
  }

  private async applyDataTool(request: DataToolRequest): Promise<void> {
    const rows = this.parseCurrentRows();
    const result = applyDataTool(rows, request, this.getDataToolOptions(rows));
    if (!result.changedCells && !result.removedRows) {return;}
    const snapshot = this.documentModel.read(
      this.document.version,
      this.document.getText(),
      this.getSeparator()
    );
    const newText = this.documentModel.serialize(result.rows, snapshot);
    const lastLine = Math.max(0, this.document.lineCount - 1);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(0, 0, lastLine, this.document.lineAt(lastLine).text.length),
      newText
    );
    this.isUpdatingDocument = true;
    try {
      await vscode.workspace.applyEdit(edit);
      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private async validateData(): Promise<void> {
    const rows = this.parseCurrentRows();
    const issues = validateCsvRows(
      rows,
      CsvEditorProvider.getHeaderForUri(this.context, this.document.uri)
    );
    await this.currentWebviewPanel?.webview.postMessage({ type: 'validationResult', issues });
  }

  // ───────────── Document Editing Methods ─────────────

  private async updateDocument(row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    let structuralChange = false;
    let applied = false;
    try {
      const separator = this.getSeparator();
      const oldText = this.document.getText();
      // Reuse the cached parse snapshot instead of re-parsing on every keystroke
      // edit; mutateDataForEdit mutates in place, so copy the rows first to avoid
      // polluting the shared cache entry.
      const snapshot = this.documentModel.read(this.document.version, oldText, separator);
      const data = snapshot.rows.map(row => row.slice());
      const hadRows = data.length;
      const hadColsAtRow = (data[row] ? data[row].length : 0);
      const previousValue =
        row < hadRows && col < hadColsAtRow
          ? String(data[row][col] ?? '')
          : undefined;

      const { data: nextData, trimmed, createdRow, createdCol } = this.mutateDataForEdit(data, row, col, value);
      structuralChange = !!(trimmed || createdRow || createdCol || row >= hadRows || col >= hadColsAtRow);

      if (!structuralChange && previousValue === value) {
        return;
      }

      let newCsvText: string | undefined;
      if (!structuralChange) {
        newCsvText = CsvEditorProvider.applyFieldUpdatesPreservingFormat(
          oldText,
          separator,
          [{ row, col, value: String(value ?? '') }]
        );
      }
      if (newCsvText === undefined) {
        newCsvText = this.serializeRows(nextData, separator);
      }

      if (newCsvText === oldText) {
        return;
      }

      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newCsvText);
      await vscode.workspace.applyEdit(edit);
      applied = true;
    } finally {
      this.isUpdatingDocument = false;
    }

    if (!applied) {
      return;
    }

    console.log(`CSV: Updated row ${row + 1}, column ${col + 1} to "${value}"`);
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const rendered = this.formatCellContent(value ?? '', clickableLinks);
    this.currentWebviewPanel?.webview.postMessage({ type: 'updateCell', row, col, value, rendered });

    // Trigger a full re-render if structure may have changed (new row/col created)
    if (structuralChange) {
      try { this.updateWebviewContent(); } catch (e) { console.error('CSV: refresh failed after structural edit', e); }
    }
  }

  private async replaceCells(replacements: unknown): Promise<void> {
    if (!Array.isArray(replacements) || replacements.length === 0) {
      return;
    }
    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const oldText = this.document.getText();
      // Reuse the cached parse snapshot; replaceCells only reads coordinates and
      // pushes updates, so the cached rows can be shared without copying.
      const data = this.documentModel.read(this.document.version, oldText, separator).rows;
      const updates: Array<{ row: number; col: number; value: string }> = [];

      let changed = false;
      for (const replacement of replacements) {
        if (!replacement || typeof replacement !== 'object') {
          continue;
        }
        const row = Number((replacement as any).row);
        const col = Number((replacement as any).col);
        if (!Number.isInteger(row) || row < 0 || !Number.isInteger(col) || col < 0) {
          continue;
        }
        if (row >= data.length) {
          continue;
        }
        if (col >= (data[row]?.length ?? 0)) {
          continue;
        }
        const raw = (replacement as any).value;
        const nextValue = raw === undefined || raw === null ? '' : String(raw);
        if ((data[row][col] ?? '') === nextValue) {
          continue;
        }
        data[row][col] = nextValue;
        updates.push({ row, col, value: nextValue });
        changed = true;
      }
      if (!changed) {
        return;
      }

      let newCsvText = CsvEditorProvider.applyFieldUpdatesPreservingFormat(oldText, separator, updates);
      if (newCsvText === undefined) {
        newCsvText = this.serializeRows(data, separator);
      }
      if (newCsvText === oldText) {
        return;
      }

      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newCsvText);
      await vscode.workspace.applyEdit(edit);

      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private parseClipboardMatrix(text: string): string[][] {
    if (!text || text.length === 0) {
      return [];
    }
    const parsed = Papa.parse(text, { dynamicTyping: false, delimiter: '' });
    const rowsRaw = Array.isArray(parsed.data) ? parsed.data : [];
    const matrix: string[][] = rowsRaw.map(rawRow => {
      if (Array.isArray(rawRow)) {
        return rawRow.map(cell => String(cell ?? ''));
      }
      return [String(rawRow ?? '')];
    });
    while (matrix.length > 0 && matrix[matrix.length - 1].every(value => value === '')) {
      matrix.pop();
    }
    if (matrix.length === 0) {
      return [];
    }
    const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    if (width <= 0) {
      return [];
    }
    matrix.forEach(row => {
      while (row.length < width) {
        row.push('');
      }
    });
    return matrix;
  }

  private static parsePasteSelectionBounds(raw: unknown): PasteSelectionBounds | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const minRow = Number((raw as any).minRow);
    const maxRow = Number((raw as any).maxRow);
    const minCol = Number((raw as any).minCol);
    const maxCol = Number((raw as any).maxCol);
    if (
      !Number.isInteger(minRow) || minRow < 0 ||
      !Number.isInteger(maxRow) || maxRow < minRow ||
      !Number.isInteger(minCol) || minCol < 0 ||
      !Number.isInteger(maxCol) || maxCol < minCol
    ) {
      return undefined;
    }
    return {
      minRow,
      maxRow,
      minCol,
      maxCol,
      rectangular: !!(raw as any).rectangular
    };
  }

  private static computePastePlan(
    matrix: string[][],
    anchorRow: number,
    anchorCol: number,
    selection: PasteSelectionBounds | undefined
  ): PastePlan | undefined {
    const height = matrix.length;
    const width = height > 0 ? Math.max(0, matrix[0].length) : 0;
    if (height <= 0 || width <= 0) {
      return undefined;
    }
    const canFillSelection = !!selection
      && selection.rectangular
      && (selection.maxRow > selection.minRow || selection.maxCol > selection.minCol)
      && height === 1
      && width === 1;
    if (canFillSelection) {
      return {
        startRow: selection.minRow,
        startCol: selection.minCol,
        endRow: selection.maxRow,
        endCol: selection.maxCol,
        fillSelection: true
      };
    }
    return {
      startRow: anchorRow,
      startCol: anchorCol,
      endRow: anchorRow + height - 1,
      endCol: anchorCol + width - 1,
      fillSelection: false
    };
  }

  private static applyPasteMatrixToData(
    data: string[][],
    matrix: string[][],
    anchorRow: number,
    anchorCol: number,
    selection: PasteSelectionBounds | undefined
  ): PasteApplyResult {
    const plan = CsvEditorController.computePastePlan(matrix, anchorRow, anchorCol, selection);
    if (!plan) {
      return {
        changed: false,
        structuralChange: false,
        updates: [],
        plan: {
          startRow: anchorRow,
          startCol: anchorCol,
          endRow: anchorRow,
          endCol: anchorCol,
          fillSelection: false
        }
      };
    }

    const updates: Array<{ row: number; col: number; value: string }> = [];
    let changed = false;
    let structuralChange = false;

    const setCellValue = (row: number, col: number, nextValue: string) => {
      const hasRow = row >= 0 && row < data.length;
      const hasCol = hasRow && col >= 0 && col < data[row].length;
      const prevValue = hasCol ? String(data[row][col] ?? '') : '';
      if (prevValue === nextValue) {
        return;
      }
      if (!hasRow || !hasCol) {
        structuralChange = true;
      }
      while (data.length <= row) {
        data.push([]);
      }
      while (data[row].length <= col) {
        data[row].push('');
      }
      data[row][col] = nextValue;
      updates.push({ row, col, value: nextValue });
      changed = true;
    };

    if (plan.fillSelection) {
      const value = String(matrix[0][0] ?? '');
      for (let row = plan.startRow; row <= plan.endRow; row++) {
        for (let col = plan.startCol; col <= plan.endCol; col++) {
          setCellValue(row, col, value);
        }
      }
    } else {
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          setCellValue(plan.startRow + r, plan.startCol + c, String(matrix[r][c] ?? ''));
        }
      }
    }

    return { changed, structuralChange, updates, plan };
  }

  private async pasteCells(
    rawText: unknown,
    rawAnchorRow: unknown,
    rawAnchorCol: unknown,
    rawSelection: unknown
  ): Promise<void> {
    const text = typeof rawText === 'string' ? rawText : '';
    if (!text) {
      return;
    }
    const anchorRow = Number(rawAnchorRow);
    const anchorCol = Number(rawAnchorCol);
    if (!Number.isInteger(anchorRow) || anchorRow < 0 || !Number.isInteger(anchorCol) || anchorCol < 0) {
      return;
    }
    const matrix = this.parseClipboardMatrix(text);
    if (!matrix.length || !matrix[0].length) {
      return;
    }
    const selection = CsvEditorController.parsePasteSelectionBounds(rawSelection);

    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const oldText = this.document.getText();
      // Reuse the cached parse snapshot; applyPasteMatrixToData mutates in place,
      // so copy the rows first to avoid polluting the shared cache entry.
      const snapshot = this.documentModel.read(this.document.version, oldText, separator);
      const data = snapshot.rows.map(row => row.slice());

      const pasteResult = CsvEditorController.applyPasteMatrixToData(data, matrix, anchorRow, anchorCol, selection);
      if (!pasteResult.changed) {
        return;
      }

      let newCsvText: string | undefined;
      if (!pasteResult.structuralChange) {
        newCsvText = CsvEditorProvider.applyFieldUpdatesPreservingFormat(oldText, separator, pasteResult.updates);
      }
      if (newCsvText === undefined) {
        newCsvText = this.serializeRows(data, separator);
      }
      if (newCsvText === oldText) {
        return;
      }

      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newCsvText);
      await vscode.workspace.applyEdit(edit);

      this.updateWebviewContent();
      this.currentWebviewPanel?.webview.postMessage({
        type: 'pasteApplied',
        startRow: pasteResult.plan.startRow,
        startCol: pasteResult.plan.startCol,
        endRow: pasteResult.plan.endRow,
        endCol: pasteResult.plan.endCol
      });
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private renderChunkFromState(state: ChunkRenderState, start: number): ChunkResponse {
    if (!Number.isInteger(start) || start < 0) {
      return { html: '', nextStart: -1, done: true };
    }

    if (start < state.allRowsCount) {
      const end = Math.min(start + state.chunkRows, state.allRowsCount);
      const html = state.allRows.slice(start, end).map((row, localR) => {
        const absRow = state.startAbs + start + localR;
        const displayIdx = start + localR + 1;
        let cells = '';
        for (let cIdx = 0; cIdx < state.numColumns; cIdx++) {
          const rawValue = row[cIdx] || '';
          const safe = this.formatCellContent(rawValue, state.clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          cells += `<td tabindex="0" style="min-width:${Math.min(state.columnWidths[cIdx] || 0, 100)}ch;max-width:100ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:${state.columnColors[cIdx]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;"${titleAttr} data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
        }
        const idxCell = state.addSerialIndex
          ? `<td tabindex="0" style="min-width:${state.serialIndexWidthCh}ch;max-width:${state.serialIndexWidthCh}ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>`
          : '';
        return `<tr>${idxCell}${cells}</tr>`;
      }).join('');

      if (end < state.allRowsCount) {
        return { html, nextStart: end, done: false };
      }
      if (state.includeTrailingEmptyRow) {
        return { html, nextStart: state.allRowsCount, done: false };
      }
      return { html, nextStart: -1, done: true };
    }

    if (start === state.allRowsCount && state.includeTrailingEmptyRow) {
      const virtualAbs = state.startAbs + state.allRowsCount;
      const displayIdx = state.allRowsCount + 1;
      const idxCell = state.addSerialIndex
        ? `<td tabindex="0" style="min-width:${state.serialIndexWidthCh}ch;max-width:${state.serialIndexWidthCh}ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:#888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>`
        : '';
      const dataCells = Array.from({ length: state.numColumns }, (_, i) => `<td tabindex="0" style="min-width:${Math.min(state.columnWidths[i] || 0, 100)}ch;max-width:100ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:${state.columnColors[i]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
      return { html: `<tr>${idxCell}${dataCells}</tr>`, nextStart: -1, done: true };
    }

    return { html: '', nextStart: -1, done: true };
  }

  private async requestChunk(rawStart: unknown, requestId: unknown): Promise<void> {
    if (!this.currentWebviewPanel || !this.chunkRenderState) {
      return;
    }
    const start = Number(rawStart);
    if (!Number.isInteger(start) || start < 0) {
      this.currentWebviewPanel.webview.postMessage({
        type: 'chunkData',
        requestId,
        start: -1,
        html: '',
        nextStart: -1,
        done: true
      });
      return;
    }
    const response = this.renderChunkFromState(this.chunkRenderState, start);
    this.currentWebviewPanel.webview.postMessage({
      type: 'chunkData',
      requestId,
      start,
      html: response.html,
      nextStart: response.nextStart,
      done: response.done
    });
  }

  private escapeFindRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildFindRegex(query: string, options: { regex: boolean; wholeWord: boolean; matchCase: boolean }): RegExp | undefined {
    if (!query) {return undefined;}
    const useRegex = !!options.regex;
    const wholeWord = !!options.wholeWord;
    const matchCase = !!options.matchCase;
    let source = useRegex ? query : this.escapeFindRegex(query);
    if (wholeWord) {
      source = `\\b(?:${source})\\b`;
    }
    const flags = matchCase ? 'g' : 'gi';
    try {
      return new RegExp(source, flags);
    } catch {
      return undefined;
    }
  }

  private async findMatches(requestId: unknown, query: unknown, options: unknown): Promise<void> {
    if (!this.currentWebviewPanel) {
      return;
    }

    const requestQuery = typeof query === 'string' ? query : '';
    const optsRaw = (options && typeof options === 'object') ? options as any : {};
    const opts = {
      regex: !!optsRaw.regex,
      wholeWord: !!optsRaw.wholeWord,
      matchCase: !!optsRaw.matchCase
    };

    const postResult = (payload: { matches: Array<{ row: number; col: number; value: string }>; invalidRegex: boolean; truncated?: boolean }) => {
      this.currentWebviewPanel?.webview.postMessage({
        type: 'findMatchesResult',
        requestId,
        matches: payload.matches,
        invalidRegex: payload.invalidRegex,
        truncated: !!payload.truncated
      });
    };

    if (!requestQuery) {
      postResult({ matches: [], invalidRegex: false });
      return;
    }

    const regex = this.buildFindRegex(requestQuery, opts);
    if (!regex) {
      postResult({ matches: [], invalidRegex: true });
      return;
    }

    const separator = this.getSeparator();
    const parsed = Papa.parse(this.document.getText(), { dynamicTyping: false, delimiter: separator });
    const data = this.trimTrailingEmptyRows((parsed.data || []) as string[][]);
    const hiddenRows = this.getHiddenRows();
    const offset = Math.min(Math.max(0, hiddenRows), data.length);
    const matches: Array<{ row: number; col: number; value: string }> = [];
    // Cap the number of reported matches. A sub-string query against a large CSV
    // can match millions of cells; collecting them all would blow up memory and
    // the postMessage payload. We stop early and flag the truncation.
    const MAX_FIND_MATCHES = 50_000;
    let truncated = false;

    for (let row = offset; row < data.length; row++) {
      const current = data[row] || [];
      for (let col = 0; col < current.length; col++) {
        const value = String(current[col] ?? '');
        regex.lastIndex = 0;
        if (regex.test(value)) {
          if (matches.length >= MAX_FIND_MATCHES) {
            truncated = true;
            break;
          }
          matches.push({ row, col, value });
        }
      }
      if (truncated) {break;}
    }

    postResult({ matches, invalidRegex: false, truncated });
  }

  // Apply an edit to a 2D data array, enforcing virtual row/cell invariants.
  // - Empty edits on non-existent virtual row/col are ignored
  // - Non-empty edits expand rows/cols as needed
  // - When editing the last row, trailing empty rows are trimmed
  private mutateDataForEdit(data: string[][], row: number, col: number, value: string): { data: string[][]; trimmed: boolean; createdRow: boolean; createdCol: boolean } {
    // Work on the same array instance (callers pass freshly parsed data)
    const hadRows = data.length;
    const hadColsAtRow = (data[row] ? data[row].length : 0);
    const wasEditingLastRow = row >= (data.length - 1);

    const rowExists = row < data.length;
    const colExists = rowExists && col < (data[row]?.length ?? 0);

    if (value === '') {
      if (!rowExists) {
        return { data, trimmed: false, createdRow: false, createdCol: false };
      }
      if (!colExists) {
        return { data, trimmed: false, createdRow: false, createdCol: false };
      }
      data[row][col] = '';
    } else {
      while (data.length <= row) {data.push([]);}
      while (data[row].length <= col) {data[row].push('');}
      data[row][col] = value;
    }

    let trimmed = false;
    if (wasEditingLastRow) {
      const isRowEmpty = (arr: string[] | undefined) => {
        if (!arr || arr.length === 0) {return true;}
        for (let i = 0; i < arr.length; i++) {
          if ((arr[i] ?? '') !== '') {return false;}
        }
        return true;
      };
      while (data.length > 0 && isRowEmpty(data[data.length - 1])) {
        data.pop();
        trimmed = true;
      }
    }

    return {
      data,
      trimmed,
      createdRow: value !== '' && row >= hadRows,
      createdCol: value !== '' && col >= hadColsAtRow
    };
  }

  private async handleSave() {
    this.isSaving = true;
    try {
      const success = await this.document.save();
      console.log(success ? 'CSV: Document saved' : 'CSV: Failed to save document');
    } catch (error) {
      console.error('CSV: Error saving document', error);
    } finally {
      this.isSaving = false;
    }
  }

  private async insertColumn(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since insertColumn mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    for (const row of data) {
      if (index > row.length) {
        while (row.length < index) {row.push('');}
      }
      row.splice(index, 0, '');
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async insertColumns(index: number, count: number) {
    if (count <= 0) {return;}
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since insertColumns mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    for (let k = 0; k < count; k++) {
      for (const row of data) {
        if (index > row.length) {
          while (row.length < index) {row.push('');}
        }
        row.splice(index, 0, '');
      }
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteColumn(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since deleteColumn mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    for (const row of data) {
      if (index < row.length) {
        row.splice(index, 1);
      }
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteColumns(indices: number[]) {
    if (!indices || !indices.length) {return;}
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since deleteColumns mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    const numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
    const sorted = this.normalizeIndices(indices, numColumns).sort((a, b) => b - a);
    for (const idx of sorted) {
      for (const row of data) {
        if (idx < row.length) {
          row.splice(idx, 1);
        }
      }
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async sortColumn(index: number, ascending: boolean) {
    this.isUpdatingDocument = true;

    const config       = vscode.workspace.getConfiguration('csv', this.document.uri);
    const separator    = this.getSeparator();
    const hidden       = this.getHiddenRows();

    const text   = this.document.getText();
    // Reuse the cached parse snapshot (copy, since sortColumn mutates in place).
    const rows   = this.trimTrailingEmptyRows(
      this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice())
    );
    const treatHeader  = this.getEffectiveHeader(rows, this.getHiddenRows());

    const offset = Math.min(Math.max(0, hidden), rows.length);
    let header: string[] = [];
    let body:   string[][] = [];

    if (treatHeader && offset < rows.length) {
      header = rows[offset];
      body   = rows.slice(offset + 1);
    } else {
      body   = rows.slice(offset);
    }

    const cmp = (a: string, b: string) => {
      const sa = (a ?? '').trim();
      const sb = (b ?? '').trim();
      const aEmpty = sa === '';
      const bEmpty = sb === '';
      if (aEmpty && bEmpty) {return 0;}
      if (aEmpty) {return 1;} // empty sorts last
      if (bEmpty) {return -1;}

      // Dates take precedence over numeric compare (avoid parseFloat on ISO)
      const aIsDate = this.isDate(sa);
      const bIsDate = this.isDate(sb);
      if (aIsDate && bIsDate) {
        const da = Date.parse(sa);
        const db = Date.parse(sb);
        if (!isNaN(da) && !isNaN(db)) {return da - db;}
      }

      const na = parseFloat(sa), nb = parseFloat(sb);
      if (!isNaN(na) && !isNaN(nb)) {return na - nb;}
      return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
    };

    body.sort((r1, r2) => {
      const left = r1[index] ?? '';
      const right = r2[index] ?? '';
      const diff = cmp(left, right);
      // Empty cells stay at the bottom in both directions. Reversing the whole
      // comparator would unexpectedly move them to the top for descending sort.
      if (left.trim() === '' || right.trim() === '') {return diff;}
      return ascending ? diff : -diff;
    });

    const prefix = rows.slice(0, offset);
    const combined = treatHeader ? [...prefix, header, ...body] : [...prefix, ...body];

    // Sanitize before unparse: ensure undefined/null/NaN become empty strings
    const sanitized: string[][] = combined.map(r => r.map((v: any) => {
      if (v === undefined || v === null) {return '';}
      const t = typeof v;
      if (t === 'number') {
        return Number.isNaN(v) ? '' : String(v);
      }
      const s = String(v);
      return s.toLowerCase() === 'nan' ? '' : s;
    }));

    const newCsv = this.serializeRows(sanitized, separator);

    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newCsv);
    await vscode.workspace.applyEdit(edit);

    this.isUpdatingDocument = false;
    this.updateWebviewContent();
    console.log(`CSV: Sorted column ${index + 1} (${ascending ? 'A-Z' : 'Z-A'})`);
  }

  private async insertRow(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since insertRow mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    const numColumns = data.reduce((max, r) => Math.max(max, r.length), 0);
    const newRow = Array(numColumns).fill('');
    if (index > data.length) {
      while (data.length < index) {data.push(Array(numColumns).fill(''));}
    }
    data.splice(index, 0, newRow);
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async insertRows(index: number, count: number) {
    if (count <= 0) {return;}
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since insertRows mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    const numColumns = data.reduce((max, r) => Math.max(max, r.length), 0);
    for (let k = 0; k < count; k++) {
      const newRow = Array(numColumns).fill('');
      if (index > data.length) {
        while (data.length < index) {data.push(Array(numColumns).fill(''));}
      }
      data.splice(index, 0, newRow);
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteRow(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since deleteRow mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    if (index < data.length) {
      data.splice(index, 1);
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteRows(indices: number[]) {
    if (!indices || !indices.length) {return;}
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    // Reuse the cached parse snapshot (copy, since deleteRows mutates in place).
    const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
    const sorted = this.normalizeIndices(indices, data.length).sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx < data.length) {
        data.splice(idx, 1);
      }
    }
    const newText = this.serializeRows(data, separator);
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private normalizeIndices(indices: unknown, maxExclusive: number): number[] {
    if (!Array.isArray(indices) || maxExclusive <= 0) {return [];}
    const seen = new Set<number>();
    const out: number[] = [];
    for (const raw of indices) {
      const num = Number(raw);
      if (!Number.isFinite(num)) {continue;}
      const idx = Math.trunc(num);
      if (idx < 0 || idx >= maxExclusive || seen.has(idx)) {continue;}
      seen.add(idx);
      out.push(idx);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  private reorderByIndices<T>(items: T[], indices: unknown, beforeIndex: unknown): { reordered: T[]; changed: boolean } {
    const selected = this.normalizeIndices(indices, items.length);
    if (!selected.length) {
      return { reordered: [...items], changed: false };
    }

    const before = Number(beforeIndex);
    const safeBefore = Number.isFinite(before) ? Math.trunc(before) : items.length;
    const clampedBefore = Math.min(Math.max(safeBefore, 0), items.length);

    const selectedSet = new Set(selected);
    const moving = selected.map(i => items[i]);
    const remaining = items.filter((_, i) => !selectedSet.has(i));
    const removedBefore = selected.filter(i => i < clampedBefore).length;
    const insertAt = Math.min(Math.max(clampedBefore - removedBefore, 0), remaining.length);
    const reordered = [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];

    let changed = false;
    for (let i = 0; i < items.length; i++) {
      if (reordered[i] !== items[i]) {
        changed = true;
        break;
      }
    }
    return { reordered, changed };
  }

  private async reorderColumns(indices: unknown, beforeIndex: unknown) {
    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const text = this.document.getText();
      // Reuse the cached parse snapshot (copy, since reorderColumns mutates in place).
      const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
      const numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
      if (numColumns <= 0) {return;}

      const sourceOrder = Array.from({ length: numColumns }, (_, i) => i);
      const { reordered: columnOrder, changed } = this.reorderByIndices(sourceOrder, indices, beforeIndex);
      if (!changed) {return;}

      const reorderedData = data.map(row => {
        const normalized = Array.from({ length: numColumns }, (_, i) => row[i] ?? '');
        const next = columnOrder.map(colIdx => normalized[colIdx] ?? '');
        while (next.length > 0 && next[next.length - 1] === '') {
          next.pop();
        }
        return next;
      });

      const newText = this.serializeRows(reorderedData, separator);
      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newText);
      await vscode.workspace.applyEdit(edit);
      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private async reorderRows(indices: unknown, beforeIndex: unknown) {
    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const text = this.document.getText();
      // Reuse the cached parse snapshot (copy, since reorderRows mutates in place).
      const data = this.documentModel.read(this.document.version, text, separator).rows.map(row => row.slice());
      if (!data.length) {return;}

      const { reordered, changed } = this.reorderByIndices(data, indices, beforeIndex);
      if (!changed) {return;}

      const newText = this.serializeRows(reordered, separator);
      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newText);
      await vscode.workspace.applyEdit(edit);
      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  // ───────────── Webview Rendering ─────────────

  private updateWebviewContent() {
    if (!this.currentWebviewPanel) {return;}

    const webview = this.currentWebviewPanel.webview;
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const addSerialIndex = CsvEditorProvider.getSerialIndexForUri(this.context, this.document.uri);
    const separator = this.getSeparator();
    const hiddenRows = this.getHiddenRows();

    let parsed;
    try {
      parsed = {
        data: this.documentModel.read(
          this.document.version,
          this.document.getText(),
          separator
        ).rows
      };
    } catch (error) {
      console.error('CSV: Error parsing CSV content', error);
      parsed = { data: [] };
    }

    const fontFamily =
      config.get<string>('fontFamily') ||
      vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'Menlo');
    const fontSize = CsvEditorController.resolveEffectiveFontSize(
      config.get<number>('fontSize', 0),
      vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14)
    );

    const cellPadding = config.get<number>('cellPadding', 2);
    const data = this.trimTrailingEmptyRows((parsed.data || []) as string[][]);
    const columnCount = data.reduce((max, row) => Math.max(max, row.length), 0);
    const treatHeader = this.getEffectiveHeader(data, hiddenRows);
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const configuredColumnColorMode = config.get<string>('columnColorMode', 'theme');
    const diffUseThemeForeground = config.get<boolean>('diffUseThemeForeground', true);
    const columnColorMode = CsvEditorController.resolveEffectiveColumnColorMode(
      configuredColumnColorMode,
      this.isDiffContext,
      diffUseThemeForeground
    );
    const columnColorPalette = config.get<string>('columnColorPalette', 'default');
    const showTrailingEmptyRow = config.get<boolean>('showTrailingEmptyRow', true);
    const mouseWheelZoomEnabled = config.get<boolean>('mouseWheelZoom', true);
    const mouseWheelZoomInvert = config.get<boolean>('mouseWheelZoomInvert', false);

    const { tableHtml, chunksJson, colorCss, nextChunkStart, hasRemoteChunks, chunkState } =
      this.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette,
        showTrailingEmptyRow,
        /* maxSerializedChunks */ 0
      );
    this.chunkRenderState = chunkState;

    const nonce = this.getNonce();

    this.currentWebviewPanel.webview.html = this.wrapHtml({
      webview,
      nonce,
      fontFamily,
      fontSize,
      cellPadding,
      separator,
      tableHtml,
      chunksJson,
      extraColumnColorCss: colorCss,
      nextChunkStart,
      hasRemoteChunks,
      mouseWheelZoomEnabled,
      mouseWheelZoomInvert,
      rowCount: data.length,
      columnCount
    });
  }

  private generateTableAndChunks(
    data: string[][],
    treatHeader: boolean,
    addSerialIndex: boolean,
    hiddenRows: number,
    clickableLinks: boolean,
    columnColorMode: string,
    columnColorPalette: string,
    showTrailingEmptyRow: boolean,
    maxSerializedChunks: number = Number.MAX_SAFE_INTEGER
  ): {
    tableHtml: string;
    chunksJson: string;
    colorCss: string;
    nextChunkStart: number;
    hasRemoteChunks: boolean;
    chunkState: ChunkRenderState | undefined;
  } {
    let headerFlag = treatHeader;
    const totalRows = data.length;
    const offset = Math.min(Math.max(0, hiddenRows), totalRows);

    const themePreference = (vscode as any).workspace?.getConfiguration?.('csvEdit')
      ?.get?.('theme', 'auto') as 'auto' | 'light' | 'dark' | undefined ?? 'auto';
    const isDark = themePreference === 'dark' || (
      themePreference === 'auto' &&
      (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast)
    );
    let headerRow: string[] = [];
    let bodyData: string[][] = [];
    if (totalRows === 0 || offset >= totalRows) {
      headerFlag = false;
      bodyData = [];
    } else if (headerFlag) {
      headerRow = data[offset];
      bodyData = data.slice(offset + 1);
    } else {
      bodyData = data.slice(offset);
    }
    // `allRows` is the same slice as `bodyData`; reuse it instead of copying
    // `data` a second time (matters for very large CSVs).
    const allRows = bodyData;
    const visibleForWidth = headerFlag ? [headerRow, ...bodyData] : bodyData;
    let numColumns = visibleForWidth.reduce((max, row) => Math.max(max, row.length), 0);
    if (numColumns === 0) {numColumns = 1;} // ensure at least 1 column for the virtual row

    const typeSample = this.sampleRows(bodyData, 5_000);
    const columnData = Array.from({ length: numColumns }, (_, i) => typeSample.map(row => row[i] || ''));
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const useThemeForeground = columnColorMode === 'theme';
    const palette = columnColorPalette === 'cool'
      ? 'cool'
      : (columnColorPalette === 'warm' ? 'warm' : 'default');
    const columnColors = useThemeForeground
      ? Array.from({ length: numColumns }, () => 'var(--vscode-editor-foreground)')
      : columnTypes.map((type, i) => this.getColumnColor(type, isDark, i, palette));
    const columnWidths = this.computeColumnWidths(visibleForWidth);

    const BASE_CHUNK_ROWS = 1000;
    const MAX_CELLS_PER_CHUNK = 20000;
    const MIN_CHUNK_ROWS = 10;
    const allRowsCount = allRows.length; // preserve total before any truncation
    const chunkRows = Math.max(
      MIN_CHUNK_ROWS,
      Math.min(BASE_CHUNK_ROWS, Math.floor(MAX_CELLS_PER_CHUNK / Math.max(1, numColumns)))
    );
    // Always keep one editable row for fully empty views; otherwise allow disabling the
    // trailing virtual row via settings.
    const includeTrailingEmptyRow = showTrailingEmptyRow || allRowsCount === 0;
    const serialIndexMaxDisplay = includeTrailingEmptyRow ? allRowsCount + 1 : allRowsCount;
    const serialIndexWidthCh = Math.max(4, String(Math.max(1, serialIndexMaxDisplay)).length + 1);
    const chunks: string[] = [];
    const chunked = allRowsCount > chunkRows;
    let nextChunkStart = -1;
    const safeMaxSerializedChunks = Number.isFinite(maxSerializedChunks)
      ? Math.max(0, Math.trunc(maxSerializedChunks))
      : 0;
    let serializedChunkCount = 0;

    if (chunked) {
      for (let i = chunkRows; i < allRowsCount; i += chunkRows) {
        if (serializedChunkCount >= safeMaxSerializedChunks) {
          nextChunkStart = i;
          break;
        }
        const htmlChunk = allRows.slice(i, i + chunkRows).map((row, localR) => {
          const startAbs = headerFlag ? offset + 1 : offset;
          const absRow = startAbs + i + localR;
          const displayIdx = i + localR + 1; // numbering relative to first visible data row
          let cells = '';
          for (let cIdx = 0; cIdx < numColumns; cIdx++) {
            const rawValue = row[cIdx] || '';
            const safe = this.formatCellContent(rawValue, clickableLinks);
            const titleAttr = this.getMultilineCellTitleAttr(rawValue);
            cells += `<td tabindex="0" style="min-width:${Math.min(columnWidths[cIdx]||0,100)}ch;max-width:100ch;border:1px solid ${isDark?'#555':'#ccc'};color:${columnColors[cIdx]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;"${titleAttr} data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
          }

          return `<tr>${
            addSerialIndex ? `<td tabindex="0" style="min-width:${serialIndexWidthCh}ch;max-width:${serialIndexWidthCh}ch;border:1px solid ${isDark?'#555':'#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>` : ''
          }${cells}</tr>`;
        }).join('');

        chunks.push(htmlChunk);
        serializedChunkCount++;
      }
    }

    const colorCss = useThemeForeground
      ? ''
      : columnColors.map((hex, i) => `td[data-col="${i}"], th[data-col="${i}"] { color: ${hex}; }`).join('');

    let tableHtml = `<table>`;
    if (headerFlag) {
      tableHtml += `<thead><tr>${
        addSerialIndex
          ? `<th tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: #888;"></th>`
          : ''
      }`;
      for (let i = 0; i < numColumns; i++) {
        const safe = this.formatCellContent(headerRow[i] || '', clickableLinks);
        tableHtml += `<th tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${offset}" data-col="${i}">${safe}</th>`;
      }
      tableHtml += `</tr></thead><tbody>`;
      const initialBodyRows = chunked ? allRows.slice(0, chunkRows) : allRows;
      initialBodyRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${offset + 1 + r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const rawValue = row[i] || '';
          const safe = this.formatCellContent(rawValue, clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;"${titleAttr} data-row="${offset + 1 + r}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked && includeTrailingEmptyRow) {
        const virtualAbs = offset + 1 + initialBodyRows.length;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${initialBodyRows.length + 1}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    } else {
      tableHtml += `<tbody>`;
      const nonHeaderRows = chunked ? allRows.slice(0, chunkRows) : allRows;
      nonHeaderRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${offset + r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const rawValue = row[i] || '';
          const safe = this.formatCellContent(rawValue, clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;"${titleAttr} data-row="${offset + r}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked && includeTrailingEmptyRow) {
        const virtualAbs = offset + nonHeaderRows.length;
        const displayIdx = nonHeaderRows.length + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    }
    tableHtml += `</table>`;
    // If chunked, append a final chunk with the virtual row so it appears at the end.
    if (chunked && includeTrailingEmptyRow) {
      if (nextChunkStart === -1 && serializedChunkCount < safeMaxSerializedChunks) {
        const startAbs = headerFlag ? offset + 1 : offset;
        const virtualAbs = startAbs + allRowsCount;
        const displayIdx = allRowsCount + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        const vrow = `<tr>${idxCell}${dataCells}</tr>`;
        chunks.push(vrow);
      } else if (nextChunkStart === -1) {
        nextChunkStart = allRowsCount;
      }
    }

    const hasRemoteChunks = nextChunkStart >= 0;
    const chunkState: ChunkRenderState | undefined = chunked
      ? {
          startAbs: headerFlag ? offset + 1 : offset,
          allRows,
          allRowsCount,
          chunkRows,
          includeTrailingEmptyRow,
          addSerialIndex,
          numColumns,
          columnWidths,
          columnColors,
          clickableLinks,
          isDark,
          serialIndexWidthCh
        }
      : undefined;

    return {
      tableHtml,
      chunksJson: JSON.stringify(chunks),
      colorCss,
      nextChunkStart,
      hasRemoteChunks,
      chunkState
    };
  }

  // Heuristic: If there is no explicit override for this file, compute default header as
  // true when the first visible row's per-column types differ from the body columns' types.
  // If they match identically across all columns, assume the first row is data (not header).
  private getEffectiveHeader(data: string[][], hiddenRows: number): boolean {
    // If user overrode per-file setting, honor it
    if (CsvEditorProvider.hasHeaderOverride(this.context, this.document.uri)) {
      return CsvEditorProvider.getHeaderForUri(this.context, this.document.uri);
    }

    const total = data.length;
    const offset = Math.min(Math.max(0, hiddenRows), total);
    if (total === 0 || offset >= total) {return false;} // nothing visible

    const headerRow = data[offset] || [];
    const body = data.slice(offset + 1);
    if (body.length === 0) {
      return true; // with only one row visible, lean toward header
    }

    const numColumns = body.reduce((max, r) => Math.max(max, r.length), Math.max(headerRow.length, 0));
    const bodyColData = Array.from({ length: numColumns }, (_, i) => body.map(r => r[i] || ''));
    const bodyTypes = bodyColData.map(col => this.estimateColumnDataType(col));
    const headerTypes = Array.from({ length: numColumns }, (_, i) => this.estimateColumnDataType([headerRow[i] || '']));

    const matches = headerTypes.every((t, i) => t === bodyTypes[i]);
    return !matches;
  }

  private wrapHtml(args: {
    webview: vscode.Webview;
    nonce: string;
    fontFamily: string;
    fontSize: number;
    cellPadding: number;
    separator: string;
    tableHtml: string;
    chunksJson: string;
    extraColumnColorCss: string;
    nextChunkStart: number;
    hasRemoteChunks: boolean;
    mouseWheelZoomEnabled: boolean;
    mouseWheelZoomInvert: boolean;
    rowCount: number;
    columnCount: number;
  }): string {
    const { webview, nonce, fontFamily, fontSize, cellPadding, separator, tableHtml, chunksJson, extraColumnColorCss, nextChunkStart, hasRemoteChunks, mouseWheelZoomEnabled, mouseWheelZoomInvert, rowCount, columnCount } = args;
    const themePreference = vscode.workspace.getConfiguration('csvEdit').get<'auto' | 'light' | 'dark'>('theme', 'auto');
    const isDark = themePreference === 'dark' || (
      themePreference === 'auto' &&
      (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast)
    );
    // Build script URI using file path for compatibility (older APIs may lack Uri.joinPath)
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js'))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'editor.css'))
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'codicon.ttf'))
    );

    // Safe separator transport (assumes single character; see assumptions)
    const sepCode = (separator && separator.length > 0) ? separator.codePointAt(0)! : ','.codePointAt(0)!;
    const documentName = path.basename(this.document.uri.fsPath || this.document.uri.path || 'Untitled.csv');

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CSV</title>
    <style nonce="${nonce}">
      @font-face {
        font-family: 'codicon';
        font-display: block;
        src: url('${codiconUri}') format('truetype');
      }
      :root {
        color-scheme: ${isDark ? 'dark' : 'light'};
        --csv-bg: var(--vscode-editor-background, ${isDark ? '#1e1e1e' : '#ffffff'});
        --csv-surface: var(--vscode-editorGroupHeader-tabsBackground, ${isDark ? '#181818' : '#f3f3f3'});
        --csv-border: var(--vscode-panel-border, ${isDark ? '#3c3c3c' : '#d4d4d4'});
        --csv-text: var(--vscode-editor-foreground, ${isDark ? '#d4d4d4' : '#333333'});
        --csv-muted: var(--vscode-descriptionForeground, ${isDark ? '#9d9d9d' : '#717171'});
        --csv-accent: var(--vscode-focusBorder, #007acc);
        --csv-cell-padding: ${cellPadding}px;
      }
      body { font-family: ${this.escapeCss(fontFamily)}; font-size: ${fontSize}px; margin: 0; padding: 0; user-select: none; background: var(--csv-bg); color: var(--csv-text); overflow: hidden; }
      /* NOTE: All layout/visual styling lives in media/editor.css (loaded via the
         <link> below). Only dynamic, build-time values that cannot be expressed as
         static CSS live here (theme tokens, font, cell padding, per-column colors). */
      .csv-link { color: ${isDark ? '#6cb6ff' : '#0066cc'}; text-decoration: underline; cursor: pointer; }
      .csv-link:hover { color: ${isDark ? '#8ecfff' : '#0044aa'}; }
      .highlight { background-color: ${isDark ? '#2a2a2a' : '#fefefe'} !important; }
      .active-match { background-color: ${isDark ? '#444444' : '#ffffcc'} !important; }

      /* Per-column computed colors */
      ${extraColumnColorCss}
    </style>
    <link rel="stylesheet" href="${styleUri}">
  </head>
  <body data-theme="${isDark ? 'dark' : 'light'}">
    <div class="csv-workbench">
      <header class="csv-commandbar" aria-label="CSV commands">
        <div class="command-primary">
          <button id="undoButton" class="command-button icon-only" type="button" title="Undo / 元に戻す" aria-label="Undo">↶</button>
          <button id="redoButton" class="command-button icon-only" type="button" title="Redo / やり直す" aria-label="Redo">↷</button>
          <span class="command-separator" aria-hidden="true"></span>
          <button id="ribbonAddRow" class="command-button" type="button" title="Insert row below / 下に行を追加"><span aria-hidden="true">＋</span> Row</button>
          <button id="ribbonAddColumn" class="command-button" type="button" title="Insert column right / 右に列を追加"><span aria-hidden="true">＋</span> Column</button>
          <span class="command-separator" aria-hidden="true"></span>
          <button id="toolbarFind" class="command-button" type="button" title="Find and replace / 検索と置換"><span class="codicon codicon-search" aria-hidden="true"></span> Find</button>
          <button id="toolbarFilter" class="command-button" type="button" title="Filter rows / 行をフィルター"><span aria-hidden="true">▽</span> Filter</button>
          <details id="commandOverflow" class="command-overflow">
            <summary title="More actions / その他の操作" aria-label="More actions">…</summary>
            <div class="command-menu" role="menu">
              <button id="ribbonCopy" type="button" role="menuitem">Copy selection</button>
              <button id="ribbonDeleteRow" type="button" role="menuitem">Delete row</button>
              <button id="ribbonDeleteColumn" type="button" role="menuitem">Delete column</button>
              <span class="menu-separator" aria-hidden="true"></span>
              <button id="toolbarTools" type="button" role="menuitem">Clean and transform…</button>
              <button id="toolbarValidate" type="button" role="menuitem">Validate data…</button>
              <span class="menu-separator" aria-hidden="true"></span>
              <button id="ribbonZoomOut" type="button" role="menuitem">Zoom out</button>
              <button id="ribbonZoomReset" type="button" role="menuitem">Reset zoom</button>
              <button id="ribbonZoomIn" type="button" role="menuitem">Zoom in</button>
              <span class="menu-separator" aria-hidden="true"></span>
              <button id="viewTextButton" type="button" role="menuitem">Open as text</button>
              <button id="toolbarTheme" type="button" role="menuitem">Theme: ${isDark ? 'Dark' : 'Light'}</button>
            </div>
          </details>
        </div>
        <span class="document-context" title="${this.escapeHtml(documentName)}">${this.escapeHtml(documentName)}</span>
      </header>

      <div class="cell-bar" role="group" aria-label="Selected cell value">
        <input id="formulaNameBox" class="cell-address" type="text" value="R1:C1" readonly aria-label="Active cell">
        <textarea id="formulaInput" class="cell-input" rows="1" spellcheck="false" aria-label="Cell value" placeholder="Select a cell to edit its value"></textarea>
        <button id="formulaCancel" class="cell-action" type="button" title="Cancel edit / 編集をキャンセル" aria-label="Cancel edit">×</button>
        <button id="formulaApply" class="cell-action" type="button" title="Apply edit / 編集を確定" aria-label="Apply edit">✓</button>
      </div>

      <div id="csv-root" class="table-container" data-sepcode="${sepCode}" data-fontsize="${fontSize}" data-rowcount="${rowCount}" data-columncount="${columnCount}" data-wheelzoomenabled="${mouseWheelZoomEnabled ? '1' : '0'}" data-wheelzoominvert="${mouseWheelZoomInvert ? '1' : '0'}" data-nextchunkstart="${nextChunkStart >= 0 ? nextChunkStart : ''}" data-hasmorechunks="${hasRemoteChunks ? '1' : '0'}">
        ${tableHtml}
      </div>

      <footer class="csv-status" role="status">
        <span id="selectionStatus">No selection</span>
        <span id="sizeStatus">${rowCount} rows · ${columnCount} columns</span>
        <span id="visibleStatus"></span>
        <span class="status-spacer"></span>
        <span title="Delimiter">${this.escapeHtml(separator === '\t' ? 'TAB' : separator)}</span>
        <span id="zoomStatus">100%</span>
      </footer>
    </div>

    <aside id="csvPanel" class="csv-panel" aria-label="CSV Edit tools">
      <div class="panel-heading">
        <h2 id="csvPanelTitle">Data tools</h2>
        <button id="csvPanelClose" class="panel-close" type="button" title="Close / 閉じる">×</button>
      </div>
      <div id="dataToolActions" class="panel-actions">
        <button data-tool="trim">Trim whitespace</button>
        <button data-tool="uppercase">UPPERCASE</button>
        <button data-tool="lowercase">lowercase</button>
        <button data-tool="fillEmpty">Fill empty</button>
        <button data-tool="removeEmptyRows">Remove empty rows</button>
        <button data-tool="removeDuplicates">Remove duplicates</button>
      </div>
      <div id="panelResults" aria-live="polite"></div>
    </aside>

    <script id="__csvChunks" type="application/json" nonce="${nonce}">${chunksJson}</script>

    <div id="findReplaceWidget" class="replace-collapsed" role="group" aria-label="Find and Replace">
      <div id="replaceToggleGutter" class="fr-gutter">
        <button id="replaceToggle" class="fr-caret-btn" type="button" aria-label="Toggle Replace" aria-expanded="false"><span class="codicon codicon-chevron-right"></span></button>
      </div>
      <div class="fr-content">
        <div class="fr-row fr-row-find">
          <div class="fr-input-wrap">
            <input id="findInput" class="fr-input" type="text" placeholder="Find" aria-label="Find">
            <div class="fr-inline-toggles">
              <button id="findCaseToggle" class="fr-toggle-btn" type="button" aria-label="Match Case" aria-pressed="false" title="Match Case">Aa</button>
              <button id="findWordToggle" class="fr-toggle-btn" type="button" aria-label="Match Whole Word" aria-pressed="false" title="Match Whole Word">ab</button>
              <button id="findRegexToggle" class="fr-toggle-btn" type="button" aria-label="Use Regular Expression" aria-pressed="false" title="Use Regular Expression">.*</button>
            </div>
          </div>
          <div id="findStatus" class="fr-status">No results</div>
          <div class="fr-divider" aria-hidden="true"></div>
          <button id="findPrev" class="fr-icon-btn" type="button" aria-label="Previous Match" title="Previous Match" disabled><span class="codicon codicon-chevron-up"></span></button>
          <button id="findNext" class="fr-icon-btn" type="button" aria-label="Next Match" title="Next Match" disabled><span class="codicon codicon-chevron-down"></span></button>
          <button id="findMenuButton" class="fr-icon-btn" type="button" aria-label="More Find Options" title="More Find Options"><span class="codicon codicon-ellipsis"></span></button>
          <button id="findClose" class="fr-icon-btn fr-close-btn" type="button" aria-label="Close Find and Replace" title="Close"><span class="codicon codicon-close"></span></button>
        </div>
        <div class="fr-row fr-row-replace">
          <div class="fr-input-wrap">
            <input id="replaceInput" class="fr-input" type="text" placeholder="Replace" aria-label="Replace">
            <div class="fr-inline-toggles">
              <button id="replaceCaseToggle" class="fr-toggle-btn" type="button" aria-label="Preserve Case" aria-pressed="false" title="Preserve Case">AB</button>
            </div>
          </div>
          <div class="fr-actions">
            <button id="replaceOne" class="fr-action-btn" type="button" aria-label="Replace" title="Replace" disabled><span class="codicon codicon-replace"></span></button>
            <button id="replaceAll" class="fr-action-btn" type="button" aria-label="Replace All" title="Replace All" disabled><span class="codicon codicon-replace-all"></span></button>
          </div>
        </div>
        <div id="findOverflowMenu" class="fr-overflow-menu" role="menu" aria-label="Find Options">
          <button id="findOverflowSelection" class="fr-overflow-item" type="button" role="menuitem">Find in selection</button>
          <button id="findOverflowDiacritics" class="fr-overflow-item" type="button" role="menuitem">Match diacritics</button>
          <button id="findOverflowPreserveCase" class="fr-overflow-item" type="button" role="menuitem">Toggle preserve case</button>
        </div>
      </div>
    </div>
    <div id="contextMenu"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  // ───────────── Utilities ─────────────

  private computeColumnWidths(data: string[][]): number[] {
    const numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
    const widths = Array(numColumns).fill(0);
    for (const row of this.sampleRows(data, 10_000)) {
      for (let i = 0; i < numColumns; i++){
        widths[i] = Math.max(widths[i], (row[i] || '').length);
      }
    }
    return widths;
  }

  private sampleRows(rows: string[][], limit: number): string[][] {
    if (rows.length <= limit) {return rows;}
    const sample: string[][] = [];
    const step = (rows.length - 1) / (limit - 1);
    for (let i = 0; i < limit; i++) {
      sample.push(rows[Math.round(i * step)]);
    }
    return sample;
  }

  private getSeparator(): string {
    const stored = CsvEditorProvider.getSeparatorForUri(this.context, this.document.uri);
    if (stored && stored.length) {return stored;}

    const settings = CsvEditorProvider.getSeparatorSettings(this.document.uri);
    const configKey = CsvEditorProvider.serializeSeparatorSettings(settings);
    const version = this.document.version;
    if (
      this.separatorCache &&
      this.separatorCache.version === version &&
      this.separatorCache.configKey === configKey
    ) {
      return this.separatorCache.separator;
    }

    const filePath = this.document?.uri.fsPath || this.document?.uri.path || '';
    const text = this.document.getText();
    const separator = CsvEditorProvider.resolveInheritedSeparator(filePath, text, settings);
    this.separatorCache = { version, configKey, separator };
    return separator;
  }

  private getHiddenRows(): number {
    return CsvEditorProvider.getHiddenRowsForUri(this.context, this.document.uri);
  }

  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m] as string);
  }

  private isAllowedExternalScheme(scheme: string): boolean {
    const normalized = scheme.toLowerCase();
    return normalized === 'http' || normalized === 'https' || normalized === 'ftp' || normalized === 'mailto';
  }

  private isAllowedExternalUrl(rawUrl: unknown): rawUrl is string {
    if (typeof rawUrl !== 'string') {return false;}
    const value = rawUrl.trim();
    if (!value) {return false;}
    try {
      const parsed = new URL(value);
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      return this.isAllowedExternalScheme(scheme);
    } catch {
      return false;
    }
  }

  private async openLinkExternally(rawUrl: unknown): Promise<void> {
    if (!this.isAllowedExternalUrl(rawUrl)) {
      return;
    }
    const value = rawUrl.trim();
    try {
      await vscode.env.openExternal(vscode.Uri.parse(value));
    } catch (err) {
      console.warn(`CSV: Failed to open external link: ${value}`, err);
    }
  }

  private linkifyUrls(escapedText: string): string {
    // Match URLs in already-escaped text (handles &amp; in query strings).
    // Supports http, https, ftp, mailto, and www.*.* (Google Sheets-like behavior).
    const urlPattern = /\b(?:(?:https?:\/\/|ftp:\/\/|mailto:)[^\s<>&"']+(?:&amp;[^\s<>&"']+)*|www\.[^\s<>&"']+\.[^\s<>&"']+)/gi;
    return escapedText.replace(urlPattern, (rawMatch) => {
      let matched = rawMatch;
      let trailing = '';
      const trailingMatch = matched.match(/[.,!?;:)\]]+$/);
      if (trailingMatch) {
        trailing = trailingMatch[0];
        matched = matched.slice(0, -trailing.length);
      }
      if (!matched) {
        return rawMatch;
      }

      // Decode &amp; back to & for URL parsing and opening.
      let href = matched.replace(/&amp;/g, '&');
      if (/^www\./i.test(href)) {
        href = `https://${href}`;
      }
      if (!this.isAllowedExternalUrl(href)) {
        return rawMatch;
      }

      return `<span class="csv-link" data-href="${this.escapeHtml(href)}" title="Ctrl/Cmd+click to open">${matched}</span>${trailing}`;
    });
  }

  private formatCellContent(text: string, linkify: boolean): string {
    const escaped = this.escapeHtml(text);
    return linkify ? this.linkifyUrls(escaped) : escaped;
  }

  private getMultilineCellTitleAttr(text: string): string {
    if (!text || (text.indexOf('\n') === -1 && text.indexOf('\r') === -1)) {
      return '';
    }
    return ` title="${this.escapeHtml(text)}"`;
  }

  private escapeCss(text: string): string {
    // Defense-in-depth for a value injected into a <style> block (font-family).
    // Keep only characters that are valid/expected inside a CSS font-family list:
    // Unicode letters, digits, spaces, single/double quotes, commas, periods and
    // hyphens. Stripping everything else prevents CSS-injection via a crafted
    // `csv.fontFamily` setting (e.g. `; background:url(...)` or `/* */`).
    return String(text).replace(/[^A-Za-z0-9 _,\.\-'"’“”]/g, '');
  }

  private isDate(value: string): boolean {
    if (!value) {return false;}
    const v = value.trim();
    // Strictly match ISO-like date formats to avoid misclassifying plain numbers as dates.
    const isoDate = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
    const isoSlash = /^\d{4}\/\d{2}\/\d{2}$/;
    if (!(isoDate.test(v) || isoSlash.test(v))) {return false;}
    return !isNaN(Date.parse(v));
  }

  private isBooleanish(value: string): boolean {
    const v = (value ?? '').trim().toLowerCase();
    if (!v) {return false;}
    if (v === 'true' || v === 'false') {return true;}
    if (v === 't' || v === 'f') {return true;}
    if (v === 'yes' || v === 'no') {return true;}
    if (v === 'y' || v === 'n') {return true;}
    if (v === 'on' || v === 'off') {return true;}
    if (v === '1' || v === '0') {return true;}
    return false;
  }

  private estimateColumnDataType(column: string[]): string {
    let allBoolean = true, allDate = true, allInteger = true, allFloat = true, allEmpty = true;
    for (const cell of column) {
      const items = cell.split(',').map(item => item.trim());
      for (const item of items){
        if (item === '') {continue;}
        allEmpty = false;
        if (!this.isBooleanish(item)) {allBoolean = false;}
        if (!this.isDate(item)) {allDate = false;}
        const num = Number(item);
        if (!Number.isInteger(num)) {allInteger = false;}
        if (isNaN(num)) {allFloat = false;}
      }
    }
    if (allEmpty) {return "empty";}
    if (allBoolean) {return "boolean";}
    if (allDate) {return "date";}
    if (allInteger) {return "integer";}
    if (allFloat) {return "float";}
    return "string";
  }

  private getColumnColor(type: string, isDark: boolean, columnIndex: number, palette: 'default' | 'cool' | 'warm' = 'default'): string {
    let hueRange = 0, isDefault = false;
    if (palette === 'cool') {
      switch (type){
        case "boolean": hueRange = 160; break;
        case "date": hueRange = 210; break;
        case "float": hueRange = isDark ? 195 : 205; break;
        case "integer": hueRange = 130; break;
        case "string": hueRange = 190; break;
        case "empty": isDefault = true; break;
      }
    } else if (palette === 'warm') {
      switch (type){
        case "boolean": hueRange = 55; break;
        case "date": hueRange = 28; break;
        case "float": hueRange = isDark ? 18 : 24; break;
        case "integer": hueRange = 42; break;
        case "string": hueRange = 8; break;
        case "empty": isDefault = true; break;
      }
    } else {
      switch (type){
        case "boolean": hueRange = 30; break;
        case "date": hueRange = 210; break;
        case "float": hueRange = isDark ? 60 : 270; break;
        case "integer": hueRange = 120; break;
        case "string": hueRange = 0; break;
        case "empty": isDefault = true; break;
      }
    }
    if (isDefault) {return isDark ? "#BBB" : "#444";}
    const saturationOffset = ((columnIndex * 7) % 31) - 15;
    const saturation = saturationOffset + (isDark ? 60 : 80);
    const lightnessOffset = ((columnIndex * 13) % 31) - 15;
    const lightness = lightnessOffset + (isDark ? 70 : 30);
    const hueOffset = ((columnIndex * 17) % 31) - 15;
    const finalHue = (hueRange + hueOffset + 360) % 360;
    return this.hslToHex(finalHue, saturation, lightness);
  }

  private hslToHex(h: number, s: number, l: number): string {
    s /= 100; l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const r = Math.round(255 * f(0));
    const g = Math.round(255 * f(8));
    const b = Math.round(255 * f(4));
    return "#" + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++){
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private trimTrailingEmptyRows(rows: string[][]): string[][] {
    const isEmpty = (r: string[] | undefined) => {
      if (!r || r.length === 0) {return true;}
      for (let i = 0; i < r.length; i++) {
        if ((r[i] ?? '') !== '') {return false;}
      }
      return true;
    };
    let end = rows.length;
    while (end > 0 && isEmpty(rows[end - 1])) {
      end--;
    }
    return rows.slice(0, end);
  }
}

// Wrapper provider: one instance registered with VS Code.
export class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'csv.editor';
  public static editors: CsvEditorController[] = [];
  public static currentActive: CsvEditorController | undefined;
  public static readonly hiddenRowsKey = 'csv.hiddenRows';
  public static readonly headerKey     = 'csv.headerByUri';
  public static readonly serialKey     = 'csv.serialIndexByUri';
  public static readonly sepKey        = 'csv.separatorByUri';
  private static readonly DEFAULT_SEPARATOR = ',';
  private static readonly DEFAULT_SEPARATOR_MODE: SeparatorMode = 'extension';
  private static readonly BUILTIN_SEPARATORS_BY_EXTENSION: Record<string, string> = {
    '.csv': ',',
    '.tsv': '\t',
    '.tab': '\t',
    '.psv': '|'
  };
  private static readonly AUTO_SEPARATOR_CANDIDATES = [',', ';', '\t', '|'];

  private static normalizeExtension(rawExt: string): string {
    const trimmed = (rawExt ?? '').trim().toLowerCase();
    if (!trimmed) {return '';}
    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  }

  private static normalizeSeparator(rawSep: unknown): string | undefined {
    if (typeof rawSep !== 'string') {return undefined;}
    if (rawSep.length === 0) {return undefined;}
    if (rawSep === '\\t') {return '\t';}
    return rawSep;
  }

  public static getSeparatorSettings(uri: vscode.Uri): SeparatorSettings {
    const fallback: SeparatorSettings = {
      mode: CsvEditorProvider.DEFAULT_SEPARATOR_MODE,
      defaultSeparator: CsvEditorProvider.DEFAULT_SEPARATOR,
      byExtension: { ...CsvEditorProvider.BUILTIN_SEPARATORS_BY_EXTENSION }
    };

    const workspaceAny = (vscode as any).workspace;
    if (!workspaceAny || typeof workspaceAny.getConfiguration !== 'function') {
      return fallback;
    }

    const cfg = workspaceAny.getConfiguration('csv', uri) as vscode.WorkspaceConfiguration;
    const rawMode = cfg.get<string>('separatorMode', CsvEditorProvider.DEFAULT_SEPARATOR_MODE);
    const mode: SeparatorMode =
      rawMode === 'auto' || rawMode === 'default' || rawMode === 'extension'
        ? rawMode
        : CsvEditorProvider.DEFAULT_SEPARATOR_MODE;

    const defaultSeparator =
      CsvEditorProvider.normalizeSeparator(cfg.get<string>('defaultSeparator', CsvEditorProvider.DEFAULT_SEPARATOR)) ??
      CsvEditorProvider.DEFAULT_SEPARATOR;

    const byExtension: Record<string, string> = {
      ...CsvEditorProvider.BUILTIN_SEPARATORS_BY_EXTENSION
    };
    const rawMap = cfg.get<Record<string, unknown>>('separatorByExtension', {});
    if (rawMap && typeof rawMap === 'object') {
      for (const [rawExt, rawSep] of Object.entries(rawMap)) {
        const ext = CsvEditorProvider.normalizeExtension(rawExt);
        const sep = CsvEditorProvider.normalizeSeparator(rawSep);
        if (!ext || !sep) {continue;}
        byExtension[ext] = sep;
      }
    }

    return { mode, defaultSeparator, byExtension };
  }

  public static serializeSeparatorSettings(settings: SeparatorSettings): string {
    const sortedMapEntries = Object.entries(settings.byExtension)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ext, sep]) => `${ext}:${sep}`)
      .join('|');
    return `${settings.mode}::${settings.defaultSeparator}::${sortedMapEntries}`;
  }

  private static resolveSeparatorFromExtension(filePath: string, settings: SeparatorSettings): string {
    const ext = CsvEditorProvider.normalizeExtension(path.extname((filePath ?? '').toLowerCase()));
    if (!ext) {return settings.defaultSeparator;}
    return settings.byExtension[ext] ?? settings.defaultSeparator;
  }

  private static countDelimiterOutsideQuotes(line: string, delimiter: string): number {
    if (!delimiter) {return 0;}
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && line.startsWith(delimiter, i)) {
        count++;
        i += delimiter.length - 1;
      }
    }
    return count;
  }

  private static detectSeparatorFromText(text: string, candidates: string[]): string | undefined {
    if (!text) {return undefined;}
    const sampleText = text.length > 300000 ? text.slice(0, 300000) : text;
    const allLines = sampleText.split(/\r\n|\n|\r/);
    const lines: string[] = [];
    for (const line of allLines) {
      if (line.trim().length === 0) {continue;}
      lines.push(line);
      if (lines.length >= 200) {break;}
    }
    if (lines.length === 0) {return undefined;}

    const minRowsWithDelimiter = lines.length === 1 ? 1 : 2;
    let best:
      | {
          separator: string;
          rowsWithDelimiter: number;
          consistency: number;
          avgDelimiterCount: number;
          score: number;
        }
      | undefined;

    for (const separator of candidates) {
      if (!separator) {continue;}
      const counts = lines.map(line => CsvEditorProvider.countDelimiterOutsideQuotes(line, separator));
      const withDelimiter = counts.filter(count => count > 0);
      if (withDelimiter.length < minRowsWithDelimiter) {continue;}

      const frequencies = new Map<number, number>();
      for (const count of withDelimiter) {
        frequencies.set(count, (frequencies.get(count) ?? 0) + 1);
      }
      let modeRowCount = 0;
      for (const freq of frequencies.values()) {
        if (freq > modeRowCount) {modeRowCount = freq;}
      }

      const consistency = withDelimiter.length > 0 ? modeRowCount / withDelimiter.length : 0;
      const avgDelimiterCount = withDelimiter.reduce((sum, count) => sum + count, 0) / withDelimiter.length;
      const firstLineBonus = (counts[0] ?? 0) > 0 ? 25 : -25;
      const score = withDelimiter.length * 10 + consistency * 100 + avgDelimiterCount + firstLineBonus;
      const candidate = { separator, rowsWithDelimiter: withDelimiter.length, consistency, avgDelimiterCount, score };

      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.score > best.score) {
        best = candidate;
        continue;
      }
      if (candidate.score === best.score && candidate.rowsWithDelimiter > best.rowsWithDelimiter) {
        best = candidate;
      }
    }

    return best?.separator;
  }

  public static resolveInheritedSeparator(filePath: string, text: string, settings: SeparatorSettings): string {
    const extensionSeparator = CsvEditorProvider.resolveSeparatorFromExtension(filePath, settings);
    if (settings.mode === 'default') {
      return settings.defaultSeparator;
    }
    if (settings.mode === 'auto') {
      const candidates: string[] = [];
      const seen = new Set<string>();
      const push = (value: string | undefined) => {
        if (!value || seen.has(value)) {return;}
        seen.add(value);
        candidates.push(value);
      };
      push(extensionSeparator);
      push(settings.defaultSeparator);
      CsvEditorProvider.AUTO_SEPARATOR_CANDIDATES.forEach(push);
      Object.values(settings.byExtension).forEach(push);
      return CsvEditorProvider.detectSeparatorFromText(text, candidates) ?? extensionSeparator;
    }
    return extensionSeparator;
  }

  private static parseCsvFieldSpans(text: string, delimiter: string): CsvFieldSpan[][] {
    const sep = delimiter && delimiter.length ? delimiter : CsvEditorProvider.DEFAULT_SEPARATOR;
    const rows: CsvFieldSpan[][] = [];
    let row: CsvFieldSpan[] = [];
    let fieldStart = 0;
    let i = 0;
    let inQuotes = false;
    let quoted = false;

    const pushField = (end: number) => {
      row.push({ start: fieldStart, end, quoted });
      quoted = false;
    };
    const pushRow = () => {
      rows.push(row);
      row = [];
    };

    while (i < text.length) {
      if (!inQuotes) {
        if (text.startsWith(sep, i)) {
          pushField(i);
          i += sep.length;
          fieldStart = i;
          continue;
        }
        const ch = text[i];
        if (ch === '"' && i === fieldStart) {
          inQuotes = true;
          quoted = true;
          i++;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          pushField(i);
          pushRow();
          if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
            i += 2;
          } else {
            i++;
          }
          fieldStart = i;
          continue;
        }
        i++;
        continue;
      }

      if (text[i] === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      i++;
    }

    pushField(text.length);
    pushRow();
    return rows;
  }

  private static encodeCsvField(value: string, delimiter: string, preferQuoted: boolean): string {
    const mustQuote =
      preferQuoted ||
      value.includes('"') ||
      value.includes('\n') ||
      value.includes('\r') ||
      (!!delimiter && value.includes(delimiter));
    if (!mustQuote) {
      return value;
    }
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  public static applyFieldUpdatesPreservingFormat(
    text: string,
    delimiter: string,
    updates: Array<{ row: number; col: number; value: string }>
  ): string | undefined {
    if (!Array.isArray(updates) || updates.length === 0) {
      return text;
    }

    const deduped = new Map<string, { row: number; col: number; value: string }>();
    for (const update of updates) {
      if (!Number.isInteger(update.row) || update.row < 0 || !Number.isInteger(update.col) || update.col < 0) {
        continue;
      }
      deduped.set(`${update.row}:${update.col}`, update);
    }
    if (deduped.size === 0) {
      return text;
    }

    const spans = CsvEditorProvider.parseCsvFieldSpans(text, delimiter);
    const edits: Array<{ start: number; end: number; replacement: string }> = [];

    for (const update of deduped.values()) {
      const span = spans[update.row]?.[update.col];
      if (!span) {
        return undefined;
      }
      const replacement = CsvEditorProvider.encodeCsvField(update.value, delimiter, span.quoted);
      if (text.slice(span.start, span.end) !== replacement) {
        edits.push({ start: span.start, end: span.end, replacement });
      }
    }

    if (edits.length === 0) {
      return text;
    }

    edits.sort((a, b) => b.start - a.start);
    let output = text;
    for (const edit of edits) {
      output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
    }
    return output;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    console.log(`CSV(reg): creating controller for ${document.uri.toString()}`);
    const controller = new CsvEditorController(this.context);
    // Track active controller
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        CsvEditorProvider.currentActive = controller;
      }
    });
    await controller.resolveCustomTextEditor(document, webviewPanel, _token);
  }

  public static getActiveProvider(): CsvEditorController | undefined {
    return CsvEditorProvider.currentActive || CsvEditorProvider.editors.find(ed => ed.isActive());
  }

  public static getHiddenRowsForUri(context: vscode.ExtensionContext, uri: vscode.Uri): number {
    const map = context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {});
    const n = map[uri.toString()] ?? 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  public static async setHiddenRowsForUri(context: vscode.ExtensionContext, uri: vscode.Uri, n: number): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {})) };
    if (!Number.isFinite(n) || n <= 0) {
      delete map[uri.toString()];
    } else {
      map[uri.toString()] = Math.floor(n);
    }
    await context.workspaceState.update(CsvEditorProvider.hiddenRowsKey, map);
  }

  public static getHeaderForUri(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.headerKey, {});
    return map[uri.toString()] ?? true; // fallback default true
  }

  public static hasHeaderOverride(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.headerKey, {});
    return Object.prototype.hasOwnProperty.call(map, uri.toString());
  }

  public static async setHeaderForUri(context: vscode.ExtensionContext, uri: vscode.Uri, val: boolean): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.headerKey, {})) };
    map[uri.toString()] = !!val; // always persist explicit override
    await context.workspaceState.update(CsvEditorProvider.headerKey, map);
  }

  public static getSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.serialKey, {});
    return map[uri.toString()] ?? true; // default true
  }

  public static async setSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri, val: boolean): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.serialKey, {})) };
    map[uri.toString()] = !!val; // always persist explicit override
    await context.workspaceState.update(CsvEditorProvider.serialKey, map);
  }

  public static getSeparatorForUri(context: vscode.ExtensionContext, uri: vscode.Uri): string | undefined {
    const map = context.workspaceState.get<Record<string, string>>(CsvEditorProvider.sepKey, {});
    return map[uri.toString()];
  }

  public static async setSeparatorForUri(context: vscode.ExtensionContext, uri: vscode.Uri, sep: string | undefined): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, string>>(CsvEditorProvider.sepKey, {})) };
    if (!sep || sep.length === 0) { delete map[uri.toString()]; } else { map[uri.toString()] = sep; }
    await context.workspaceState.update(CsvEditorProvider.sepKey, map);
  }

  // Test helpers to access internal utilities without VS Code runtime
  public static __test = {
    // Pure helper mirroring sort behavior; returns combined rows after sort.
    sortByColumn(rows: string[][], index: number, ascending: boolean, treatHeader: boolean, hiddenRows: number): string[][] {
      // Trim trailing empty rows like runtime before sorting
      const isEmpty = (r: string[] | undefined) => {
        if (!r || r.length === 0) {return true;}
        for (let i = 0; i < r.length; i++) { if ((r[i] ?? '') !== '') {return false;} }
        return true;
      };
      let end = rows.length;
      while (end > 0 && isEmpty(rows[end - 1])) { end--; }
      const trimmed = rows.slice(0, end);

      const offset = Math.min(Math.max(0, hiddenRows), trimmed.length);
      let header: string[] = [];
      let body:   string[][] = [];
      if (treatHeader && offset < trimmed.length) {
        header = trimmed[offset];
        body   = trimmed.slice(offset + 1);
      } else {
        body   = trimmed.slice(offset);
      }
      const isDateStr = (v: string) => {
        const s = (v ?? '').trim();
        if (!s) {return false;}
        const isoDate = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
        const isoSlash = /^\d{4}\/\d{2}\/\d{2}$/;
        return isoDate.test(s) || isoSlash.test(s);
      };
      const cmp = (a: string, b: string) => {
        const sa = (a ?? '').trim();
        const sb = (b ?? '').trim();
        const aEmpty = sa === '';
        const bEmpty = sb === '';
        if (aEmpty && bEmpty) {return 0;}
        if (aEmpty) {return 1;} // empty sorts last
        if (bEmpty) {return -1;}
        if (isDateStr(sa) && isDateStr(sb)) {
          const da = Date.parse(sa);
          const db = Date.parse(sb);
          if (!isNaN(da) && !isNaN(db)) {return da - db;}
        }
        const na = parseFloat(sa), nb = parseFloat(sb);
        if (!isNaN(na) && !isNaN(nb)) {return na - nb;}
        return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
      };
      body.sort((r1, r2) => {
        const left = r1[index] ?? '';
        const right = r2[index] ?? '';
        const diff = cmp(left, right);
        if (left.trim() === '' || right.trim() === '') {return diff;}
        return ascending ? diff : -diff;
      });
      const prefix = trimmed.slice(0, offset);

      // Apply same sanitation used before unparse in runtime path
      const combined = (treatHeader ? [...prefix, header, ...body] : [...prefix, ...body]).map(r => r.map((v: any) => {
        if (v === undefined || v === null) {return '';}
        const t = typeof v;
        if (t === 'number') {return Number.isNaN(v) ? '' : String(v);}
        const s = String(v);
        return s.toLowerCase() === 'nan' ? '' : s;
      }));
      return combined;
    },
    computeColumnWidths(data: string[][]): number[] {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.computeColumnWidths(data);
    },
    reorderIndexOrder(length: number, indices: number[], beforeIndex: number): number[] {
      const c: any = new (CsvEditorController as any)({} as any);
      const n = Number.isFinite(length) ? Math.max(0, Math.trunc(length)) : 0;
      const base = Array.from({ length: n }, (_, i) => i);
      const result = c.reorderByIndices(base, indices, beforeIndex);
      return result.reordered;
    },
    normalizeIndices(indices: unknown, maxExclusive: number): number[] {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.normalizeIndices(indices, maxExclusive);
    },
    reorderRows(rows: string[][], indices: number[], beforeIndex: number): string[][] {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.reorderByIndices(rows, indices, beforeIndex);
      return result.reordered;
    },
    reorderColumns(rows: string[][], indices: number[], beforeIndex: number): string[][] {
      const c: any = new (CsvEditorController as any)({} as any);
      const numColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const sourceOrder = Array.from({ length: numColumns }, (_, i) => i);
      const orderResult = c.reorderByIndices(sourceOrder, indices, beforeIndex);
      return rows.map((row: string[]) => {
        const normalized = Array.from({ length: numColumns }, (_, i) => row[i] ?? '');
        const next = orderResult.reordered.map((colIdx: number) => normalized[colIdx] ?? '');
        while (next.length > 0 && next[next.length - 1] === '') {
          next.pop();
        }
        return next;
      });
    },
    mutateDataForEdit(data: string[][], row: number, col: number, value: string): { data: string[][]; trimmed: boolean; createdRow: boolean; createdCol: boolean } {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.mutateDataForEdit(data, row, col, value);
    },
    isDate(v: string): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.isDate(v);
    },
    estimateColumnDataType(col: string[]): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.estimateColumnDataType(col);
    },
    getColumnColor(t: string, dark: boolean, i: number, palette: 'default' | 'cool' | 'warm' = 'default'): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.getColumnColor(t, dark, i, palette);
    },
    resolveEffectiveColumnColorMode(baseMode: string, isDiffContext: boolean, diffUseThemeForeground: boolean): 'type' | 'theme' {
      return (CsvEditorController as any).resolveEffectiveColumnColorMode(baseMode, isDiffContext, diffUseThemeForeground);
    },
    resolveEffectiveFontSize(csvFontSize: unknown, editorFontSize: unknown): number {
      return (CsvEditorController as any).resolveEffectiveFontSize(csvFontSize, editorFontSize);
    },
    hslToHex(h: number, s: number, l: number): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.hslToHex(h, s, l);
    },
    formatCellContent(text: string, linkify: boolean): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.formatCellContent(text, linkify);
    },
    isAllowedExternalUrl(url: unknown): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.isAllowedExternalUrl(url);
    },
    shouldPromptForLargeFile(fileSizeBytes: number, maxFileSizeMB: number): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.shouldPromptForLargeFile(fileSizeBytes, maxFileSizeMB);
    },
    // Expose header heuristic for tests. Allows specifying hiddenRows and
    // optionally an override value through a mock workspaceState.
    getEffectiveHeader(data: string[][], hiddenRows: number, override: undefined | boolean = undefined): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      // Minimal fake URI and context to satisfy header-override checks
      const fakeUri = { toString: () => 'vscode-test://csv/fixture', fsPath: '/csv/fixture.csv' } as any;
      const state: Record<string, any> = {};
      if (override !== undefined) {
        state[CsvEditorProvider.headerKey] = { [fakeUri.toString()]: override };
      }
      c.context = {
        workspaceState: {
          get: (key: string, def: any) => (key in state ? state[key] : def),
          update: async (key: string, val: any) => { state[key] = val; }
        }
      } as any;
      c.document = { uri: fakeUri } as any;
      return c.getEffectiveHeader(data, hiddenRows);
    },
    // Compute the effective separator used for a given file path with optional override.
    getEffectiveSeparator(
      filePath: string,
      override: string | undefined,
      options?: {
        mode?: SeparatorMode;
        defaultSeparator?: string;
        byExtension?: Record<string, string>;
        text?: string;
      }
    ): string {
      if (override && override.length) {
        return override;
      }
      const mode = options?.mode ?? 'extension';
      const defaultSeparator =
        CsvEditorProvider.normalizeSeparator(options?.defaultSeparator) ?? CsvEditorProvider.DEFAULT_SEPARATOR;
      const byExtension: Record<string, string> = { ...CsvEditorProvider.BUILTIN_SEPARATORS_BY_EXTENSION };
      if (options?.byExtension) {
        for (const [rawExt, rawSep] of Object.entries(options.byExtension)) {
          const ext = CsvEditorProvider.normalizeExtension(rawExt);
          const sep = CsvEditorProvider.normalizeSeparator(rawSep);
          if (!ext || !sep) {continue;}
          byExtension[ext] = sep;
        }
      }
      const text = options?.text ?? '';
      return CsvEditorProvider.resolveInheritedSeparator(filePath, text, {
        mode,
        defaultSeparator,
        byExtension
      });
    },
    applyFieldUpdatesPreservingFormat(
      text: string,
      delimiter: string,
      updates: Array<{ row: number; col: number; value: string }>
    ): string | undefined {
      return CsvEditorProvider.applyFieldUpdatesPreservingFormat(text, delimiter, updates);
    },
    escapeCss(text: string): string {
      return new (CsvEditorController as any)({} as any).escapeCss(text);
    },
    computePastePlan(
      matrix: string[][],
      anchorRow: number,
      anchorCol: number,
      selection?: { minRow: number; maxRow: number; minCol: number; maxCol: number; rectangular: boolean }
    ): { startRow: number; startCol: number; endRow: number; endCol: number; fillSelection: boolean } | undefined {
      return (CsvEditorController as any).computePastePlan(matrix, anchorRow, anchorCol, selection);
    },
    applyPasteMatrixToData(
      data: string[][],
      matrix: string[][],
      anchorRow: number,
      anchorCol: number,
      selection?: { minRow: number; maxRow: number; minCol: number; maxCol: number; rectangular: boolean }
    ): {
      changed: boolean;
      structuralChange: boolean;
      updates: Array<{ row: number; col: number; value: string }>;
      plan: { startRow: number; startCol: number; endRow: number; endCol: number; fillSelection: boolean };
    } {
      return (CsvEditorController as any).applyPasteMatrixToData(data, matrix, anchorRow, anchorCol, selection);
    },
    // Expose chunking/table generation for large-data tests. Returns parsed chunk count.
    generateTableChunksMeta(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      clickableLinks: boolean = true,
      columnColorMode: 'type' | 'theme' = 'type',
      columnColorPalette: 'default' | 'cool' | 'warm' = 'default',
      showTrailingEmptyRow: boolean = true
    ): { chunkCount: number; hasTable: boolean } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette,
        showTrailingEmptyRow
      );
      try {
        const chunks = JSON.parse(result.chunksJson);
        return { chunkCount: Array.isArray(chunks) ? chunks.length : 0, hasTable: typeof result.tableHtml === 'string' && result.tableHtml.includes('<table') };
      } catch {
        return { chunkCount: 0, hasTable: false };
      }
    },
    generateTableAndChunksRaw(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      clickableLinks: boolean = true,
      columnColorMode: 'type' | 'theme' = 'type',
      columnColorPalette: 'default' | 'cool' | 'warm' = 'default',
      showTrailingEmptyRow: boolean = true
    ): { tableHtml: string; chunks: string[] } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette,
        showTrailingEmptyRow
      );
      let chunks: string[] = [];
      try { chunks = JSON.parse(result.chunksJson); } catch {}
      return { tableHtml: result.tableHtml, chunks };
    },
    generateRuntimeChunkTransport(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      start: number | undefined = undefined
    ): {
      serializedChunkCount: number;
      nextChunkStart: number;
      hasRemoteChunks: boolean;
      hasChunkState: boolean;
      response?: { html: string; nextStart: number; done: boolean };
    } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        /* clickableLinks */ true,
        /* columnColorMode */ 'type',
        /* columnColorPalette */ 'default',
        /* showTrailingEmptyRow */ true,
        /* maxSerializedChunks */ 0
      );
      let chunks: string[] = [];
      try { chunks = JSON.parse(result.chunksJson); } catch {}
      const out: {
        serializedChunkCount: number;
        nextChunkStart: number;
        hasRemoteChunks: boolean;
        hasChunkState: boolean;
        response?: { html: string; nextStart: number; done: boolean };
      } = {
        serializedChunkCount: chunks.length,
        nextChunkStart: result.nextChunkStart,
        hasRemoteChunks: result.hasRemoteChunks,
        hasChunkState: !!result.chunkState
      };
      if (typeof start === 'number' && result.chunkState) {
        const response = c.renderChunkFromState(result.chunkState, start);
        out.response = {
          html: response.html,
          nextStart: response.nextStart,
          done: response.done
        };
      }
      return out;
    }
  };
}
