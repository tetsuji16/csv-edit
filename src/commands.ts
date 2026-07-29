import { getFonts } from 'font-list';
import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';

function displaySeparator(separator: string): string {
  return separator === '\t' ? '\\t' : separator;
}

function parseSeparatorInput(raw: string): string {
  return raw === '\\t' ? '\t' : raw;
}

async function toggleBooleanConfig(key: string, defaultVal: boolean, messagePrefix: string) {
  const config = vscode.workspace.getConfiguration('csv');
  const currentVal = config.get<boolean>(key, defaultVal);
  const newVal = !currentVal;
  await config.update(key, newVal, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${messagePrefix} ${newVal ? 'enabled' : 'disabled'}.`);
  CsvEditorProvider.editors.forEach(ed => ed.refresh());
}

export function registerCsvCommands(context: vscode.ExtensionContext) {
  const getCsvUri = (): vscode.Uri | undefined => {
    const active = CsvEditorProvider.getActiveProvider();
    if (active) return active.getDocumentUri();
    const input: any = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input?.uri instanceof vscode.Uri ? input.uri : vscode.window.activeTextEditor?.document.uri;
  };
  const setView = async (view: 'grid' | 'text') => {
    const uri = getCsvUri();
    if (!uri) {
      vscode.window.showInformationMessage('CSV Edit: Open a CSV-like file first.');
      return;
    }
    await vscode.workspace.getConfiguration('csvEdit').update(
      'defaultView',
      view,
      vscode.ConfigurationTarget.Global
    );
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      view === 'grid' ? CsvEditorProvider.viewType : 'default',
      { preview: false, preserveFocus: false }
    );
  };
  const post = (command: string) => CsvEditorProvider.getActiveProvider()?.postUiCommand(command);

  context.subscriptions.push(
    vscode.commands.registerCommand('csvEdit.openGrid', () => setView('grid')),
    vscode.commands.registerCommand('csvEdit.openText', () => setView('text')),
    vscode.commands.registerCommand('csvEdit.toggleView', async () => {
      const input: any = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const isGrid = input?.viewType === CsvEditorProvider.viewType || !!CsvEditorProvider.getActiveProvider()?.isActive();
      await setView(isGrid ? 'text' : 'grid');
    }),
    vscode.commands.registerCommand('csvEdit.setTheme', async () => {
      const current = vscode.workspace.getConfiguration('csvEdit').get<string>('theme', 'auto');
      const labels: Record<string, string> = { auto: 'Auto / 自動', light: 'Light / ライト', dark: 'Dark / ダーク' };
      const picked = await vscode.window.showQuickPick(
        ['auto', 'light', 'dark'].map(value => ({ label: labels[value], value, picked: value === current })),
        { placeHolder: 'CSV Edit theme / テーマ' }
      );
      if (!picked) return;
      await vscode.workspace.getConfiguration('csvEdit').update('theme', picked.value, vscode.ConfigurationTarget.Global);
      CsvEditorProvider.editors.forEach(editor => editor.refresh());
    }),
    vscode.commands.registerCommand('csvEdit.find', () => post('find')),
    vscode.commands.registerCommand('csvEdit.replace', () => post('replace')),
    vscode.commands.registerCommand('csvEdit.toggleFilter', () => post('filter')),
    vscode.commands.registerCommand('csvEdit.openDataTools', () => post('dataTools')),
    vscode.commands.registerCommand('csvEdit.validate', () => post('validate')),
    vscode.commands.registerCommand('csv.toggleExtension', () =>
      toggleBooleanConfig('enabled', true, 'CSV extension')
    ),
    vscode.commands.registerCommand('csv.toggleClickableLinks', () =>
      toggleBooleanConfig('clickableLinks', true, 'CSV clickable links')
    ),
    vscode.commands.registerCommand('csv.toggleHeader', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const cur = CsvEditorProvider.getHeaderForUri(context, uri);
      await CsvEditorProvider.setHeaderForUri(context, uri, !cur);
      CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: First row as header ${!cur ? 'enabled' : 'disabled'} for this file.`);
    }),
    vscode.commands.registerCommand('csv.toggleSerialIndex', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const cur = CsvEditorProvider.getSerialIndexForUri(context, uri);
      await CsvEditorProvider.setSerialIndexForUri(context, uri, !cur);
      CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: Serial index ${!cur ? 'enabled' : 'disabled'} for this file.`);
    }),
    vscode.commands.registerCommand('csv.changeSeparator', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const currentOverride = CsvEditorProvider.getSeparatorForUri(context, uri);
      const currentSep = currentOverride ?? active.getCurrentSeparator();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter new CSV separator for this file (empty to inherit configured rules; use \\t for tab)',
        value: displaySeparator(currentSep)
      });
      if (input !== undefined) {
        const sep = input.length ? parseSeparatorInput(input) : undefined;
        await CsvEditorProvider.setSeparatorForUri(context, uri, sep);
        vscode.window.showInformationMessage(
          sep && sep.length
            ? `CSV separator set to "${displaySeparator(sep)}" for this file.`
            : 'CSV separator now inherits from configured separator settings.'
        );
        CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      }
    }),
    vscode.commands.registerCommand('csv.resetSeparator', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      await CsvEditorProvider.setSeparatorForUri(context, uri, undefined);
      vscode.window.showInformationMessage('CSV separator override cleared for this file.');
      CsvEditorProvider.editors
        .filter(ed => ed.getDocumentUri().toString() === uri.toString())
        .forEach(ed => ed.refresh());
    }),
    vscode.commands.registerCommand('csv.changeFontFamily', async () => {
      const csvCfg     = vscode.workspace.getConfiguration('csv');
      const editorCfg  = vscode.workspace.getConfiguration('editor');

      const currentCsvFont   = csvCfg.get<string>('fontFamily', '');
      const inheritedFont    = editorCfg.get<string>('fontFamily', 'Menlo');
      const currentEffective = currentCsvFont || inheritedFont;

      let fonts: string[] = [];
      try {
        fonts = (await getFonts()).map((f: string) => f.replace(/^"(.*)"$/, '$1')).sort();
      } catch (e) {
        console.error('CSV: unable to enumerate system fonts', e);
      }
      const picks = ['(inherit editor setting)', ...fonts];

      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder: `Current: ${currentEffective}`
      });
      if (choice === undefined) { return; }

      const newVal = choice === '(inherit editor setting)' ? '' : choice;
      await csvCfg.update('fontFamily', newVal, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        newVal ? `CSV font set to “${newVal}”.` : 'CSV font now inherits editor.fontFamily.'
      );
      CsvEditorProvider.editors.forEach(ed => ed.refresh());
    }),
    vscode.commands.registerCommand('csv.changeIgnoreRows', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) {
        vscode.window.showInformationMessage('Open a CSV/TSV/PSV file with the CSV editor to change hidden rows.');
        return;
      }
      const uri = active.getDocumentUri();
      const current = CsvEditorProvider.getHiddenRowsForUri(context, uri);
      const input = await vscode.window.showInputBox({
        prompt: 'Hide first N rows (per file)',
        value: String(current),
        validateInput: (val: string) => (/^\d+$/.test(val) ? undefined : 'Enter a non-negative integer')
      });
      if (input === undefined) { return; }
      const n = parseInt(input, 10);
      await CsvEditorProvider.setHiddenRowsForUri(context, uri, n);
      // Refresh only editors showing this URI
      CsvEditorProvider.editors
        .filter(ed => ed.getDocumentUri().toString() === uri.toString())
        .forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: Hiding first ${n} row(s) for this file.`);
    }),
    vscode.commands.registerCommand('csv.changeEncoding', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();

      // Close any existing tabs for this URI so we can reuse the slot cleanly
      try {
        const toClose: vscode.Tab[] = [];
        vscode.window.tabGroups.all.forEach(g => {
          g.tabs.forEach(t => {
            const inp: any = (t as any).input;
            const u: vscode.Uri | undefined = inp?.uri instanceof vscode.Uri ? (inp.uri as vscode.Uri) : undefined;
            if (u && u.toString() === uri.toString()) toClose.push(t);
          });
        });
        if (toClose.length) {
          console.log(`[CSV(encoding)]: closing ${toClose.length} tab(s) for ${uri.fsPath}`);
          await vscode.window.tabGroups.close(toClose);
        }
      } catch (e) {
        console.warn('[CSV(encoding)]: failed to close existing tabs', e);
      }

      // Open the default text editor in-place and invoke the built-in encoding picker
      try {
        console.log(`[CSV(encoding)]: opening default text editor for ${uri.fsPath}`);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: true, preserveFocus: false });

        console.log('[CSV(encoding)]: invoking workbench.action.editor.changeEncoding');
        await vscode.commands.executeCommand('workbench.action.editor.changeEncoding');

        // Switch back to our custom editor
        console.log(`[CSV(encoding)]: reopening with custom editor for ${uri.fsPath}`);
        await vscode.commands.executeCommand('vscode.openWith', uri, CsvEditorProvider.viewType, { preview: false, preserveFocus: false });

        // Best-effort: ensure no duplicate default tab remains
        try {
          const stale: vscode.Tab[] = [];
          vscode.window.tabGroups.all.forEach(g => g.tabs.forEach(t => {
            const inp: any = (t as any).input;
            const vt = inp?.viewType;
            const u: vscode.Uri | undefined = inp?.uri instanceof vscode.Uri ? (inp.uri as vscode.Uri) : undefined;
            if (u && u.toString() === uri.toString() && vt !== CsvEditorProvider.viewType) stale.push(t);
          }));
          if (stale.length) {
            console.log(`[CSV(encoding)]: closing ${stale.length} stale text tab(s)`);
            await vscode.window.tabGroups.close(stale);
          }
        } catch {}
      } catch (e) {
        console.error('CSV: encoding change flow failed', e);
        vscode.window.showWarningMessage('CSV: Could not invoke the built-in encoding picker. Please use File → Reopen with Encoding, then re-open the CSV view.');
      }
    })
  );
}
