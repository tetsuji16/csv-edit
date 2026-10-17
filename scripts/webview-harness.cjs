// Development harness: runs the real compiled provider (out/) against a mocked
// VS Code API and serves the webview in a sandboxed iframe that mirrors the
// VS Code webview sandbox (no `allow-modals`, so alert/confirm/prompt are
// blocked exactly as they are inside VS Code).
//
//   npm run compile && node scripts/webview-harness.cjs [file.csv] [--port 5317] [--lang ja]
//
// Debug endpoints: GET /doc (document text), GET /clipboard, GET /log.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(flag('--port', '5317'));
const LANG = flag('--lang', 'en');
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const filePath = path.resolve(positional[0] || path.join(__dirname, '..', 'sample', 'harness.csv'));
const root = path.join(__dirname, '..');

const log = [];
const record = (...parts) => {
  const line = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  log.push(line);
  if (log.length > 500) {log.shift();}
};

// ───────── mocked vscode ─────────
class Uri {
  constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
  static file(p) { return new Uri('file', p); }
  static parse(s) { return new Uri(s.split(':')[0], s); }
  toString() { return `${this.scheme}://${this.path}`; }
}
class Range { constructor(a, b, c, d) { this.args = [a, b, c, d]; } }
class WorkspaceEdit {
  constructor() { this.ops = []; }
  replace(uri, range, text) { this.ops.push({ uri, range, text }); }
}
const emitter = () => {
  const listeners = new Set();
  const event = cb => { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; };
  event.fire = value => listeners.forEach(cb => cb(value));
  return event;
};

const config = {
  'csv.enabled': true,
  'csv.maxFileSizeMB': 10,
  'csvEdit.defaultView': 'grid',
  'csvEdit.theme': flag('--theme', 'auto'),
  'editor.fontFamily': 'Consolas, monospace',
  'editor.fontSize': 14
};
const workspaceState = new Map();
const clipboard = { text: '' };

const docText = fs.existsSync(filePath)
  ? fs.readFileSync(filePath, 'utf8')
  : 'name,city,note\nAlice,Tokyo,hello\nBob,Osaka,"multi\nline"\n';
const document = {
  uri: Uri.file(filePath),
  version: 1,
  text: docText,
  undo: [],
  redo: [],
  getText() { return this.text; },
  get lineCount() { return this.text.split(/\r\n|\r|\n/).length; },
  lineAt(i) { return { text: this.text.split(/\r\n|\r|\n/)[i] ?? '' }; },
  async save() { record('save'); return true; }
};
const onDidChangeTextDocument = emitter();
const setDocText = (text, pushUndo = true) => {
  if (pushUndo) { document.undo.push(document.text); document.redo = []; }
  document.text = text;
  document.version += 1;
  onDidChangeTextDocument.fire({ document });
};

const vscode = {
  Uri, Range, WorkspaceEdit,
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ViewColumn: { One: 1 },
  env: {
    language: LANG,
    clipboard: {
      writeText: async t => { clipboard.text = t; record('clipboard.write', t.length); },
      readText: async () => clipboard.text
    },
    openExternal: async u => { record('openExternal', String(u)); return true; }
  },
  window: {
    activeColorTheme: { kind: flag('--theme', 'auto') === 'light' ? 1 : 2 },
    showInformationMessage: async (...m) => { record('info', m[0]); return undefined; },
    showWarningMessage: async (...m) => { record('warning', m[0]); return undefined; },
    showErrorMessage: async (...m) => { record('error', m[0]); return undefined; },
    showInputBox: async o => { record('inputBox', o?.prompt); return undefined; },
    showQuickPick: async () => undefined,
    tabGroups: { all: [], activeTabGroup: { activeTab: undefined } },
    registerCustomEditorProvider: () => ({ dispose() {} })
  },
  workspace: {
    getConfiguration(section) {
      return {
        get: (key, def) => {
          const v = config[`${section}.${key}`];
          return v === undefined ? def : v;
        },
        update: async (key, value) => { config[`${section}.${key}`] = value; record('config', `${section}.${key}`, value); }
      };
    },
    onDidChangeTextDocument,
    onDidChangeConfiguration: emitter(),
    async applyEdit(edit) {
      const op = edit.ops[edit.ops.length - 1];
      if (op) { setDocText(op.text); record('applyEdit', op.text.length); }
      return true;
    },
    fs: { stat: async () => ({ size: Buffer.byteLength(document.text) }) }
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    async executeCommand(id, ...rest) {
      record('command', id);
      if (id === 'undo' && document.undo.length) {
        document.redo.push(document.text);
        setDocText(document.undo.pop(), false);
      } else if (id === 'redo' && document.redo.length) {
        document.undo.push(document.text);
        setDocText(document.redo.pop(), false);
      }
      return undefined;
    }
  }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {return vscode;}
  return originalLoad.call(this, request, ...rest);
};

// ───────── webview panel + bridge ─────────
const sseClients = new Set();
const send = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
};
let currentHtml = '';
const messageListener = { cb: null };
const panel = {
  active: true,
  viewColumn: 1,
  title: path.basename(filePath),
  webview: {
    options: {},
    cspSource: `http://localhost:${PORT}`,
    asWebviewUri: uri => `/ext/${path.relative(root, uri.fsPath).split(path.sep).join('/')}`,
    get html() { return currentHtml; },
    set html(value) { currentHtml = value; send('reload', {}); },
    postMessage: async message => { send('message', message); return true; },
    onDidReceiveMessage: cb => { messageListener.cb = cb; return { dispose() {} }; }
  },
  onDidChangeViewState: () => ({ dispose() {} }),
  onDidDispose: () => ({ dispose() {} }),
  dispose() { record('panel.dispose'); }
};

const { CsvEditorProvider } = require(path.join(root, 'out', 'CsvEditorProvider.js'));
const context = {
  extensionPath: root,
  workspaceState: {
    get: (k, d) => (workspaceState.has(k) ? workspaceState.get(k) : d),
    update: async (k, v) => { workspaceState.set(k, v); }
  },
  globalState: { get: (k, d) => d, update: async () => {} },
  subscriptions: []
};
const provider = new CsvEditorProvider(context);
provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false });

const bridge = nonce => `<script nonce="${nonce}">
(() => {
  let state;
  try { state = JSON.parse(sessionStorage.getItem('vscode-state') || 'null'); } catch { state = null; }
  // The webview CSP forbids fetch/EventSource, so the parent page relays
  // messages (as VS Code does) via window.postMessage.
  window.acquireVsCodeApi = () => ({
    postMessage: m => parent.postMessage({ __csvEditToExtension: m }, '*'),
    getState: () => state,
    setState: s => { state = s; try { sessionStorage.setItem('vscode-state', JSON.stringify(s)); } catch {} }
  });
})();
</script>`;

const outer = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CSV Edit harness</title>
<style>html,body{margin:0;height:100%;background:#1e1e1e}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="wv" src="/webview" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"></iframe>
<script>
const frame = document.getElementById('wv');
window.addEventListener('message', e => {
  if (e.data && e.data.__csvEditToExtension) {
    fetch('/msg', { method: 'POST', body: JSON.stringify(e.data.__csvEditToExtension) });
  }
});
const es = new EventSource('/events');
es.addEventListener('message', e => frame.contentWindow.postMessage(JSON.parse(e.data), '*'));
// html is often assigned twice in a row (blank, then content); coalesce.
let reloadTimer = null;
es.addEventListener('reload', () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { frame.src = '/webview?' + Date.now(); }, 60);
});
</script></body></html>`;

const vscodeVars = `<style>:root{--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-panel-border:#2b2b2b;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-selectionBackground:#264f78;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-statusBar-background:#181818;--vscode-statusBar-foreground:#cccccc;--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#cccccc;--vscode-menu-selectionBackground:#0078d4;--vscode-sideBar-background:#181818;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700}</style>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(outer); return; }
  if (url.pathname === '/webview') {
    const nonce = (currentHtml.match(/nonce-([A-Za-z0-9]+)/) || [])[1] || '';
    const themed = config['csvEdit.theme'] === 'light' ? '' : vscodeVars;
    const html = currentHtml.replace('<head>', `<head>${themed}${bridge(nonce)}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/msg' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        record('webview→ext', msg.type);
        await messageListener.cb?.(msg);
      } catch (err) { record('error', String(err && err.stack || err)); }
      res.end('ok');
    });
    return;
  }
  if (url.pathname === '/doc') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(document.text); return; }
  if (url.pathname === '/clipboard') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { clipboard.text = body; res.end('ok'); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(clipboard.text); return;
  }
  if (url.pathname === '/log') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(log.join('\n')); return; }
  if (url.pathname.startsWith('/ext/')) {
    const rel = decodeURIComponent(url.pathname.slice(5));
    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
    const type = full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : 'font/ttf';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, () => console.log(`CSV Edit harness: http://localhost:${PORT}/  (${filePath})`));
