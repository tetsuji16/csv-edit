// Minimal Chrome DevTools Protocol driver for exercising the webview harness
// with real input (keyboard, mouse, IME composition) in headless Chrome/Edge.
//
//   const { launch } = require('./cdp.cjs');
//   const page = await launch('http://localhost:5317/');
//   await page.key('ArrowDown'); await page.evalFrame('anchorCell.dataset.row');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BROWSERS = [
  process.env.CDP_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(url, { port = 9333, width = 1200, height = 760 } = {}) {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) {throw new Error('No Chrome/Edge found; set CDP_BROWSER');}
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-cdp-'));
  const proc = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', url
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find(t => t.type === 'page');
    } catch {}
  }
  if (!target) {throw new Error('browser did not start');}
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const consoleLines = [];
  const contexts = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params.context;
      if (ctx.auxData && ctx.auxData.isDefault) {contexts.set(ctx.id, ctx.auxData.frameId);}
    } else if (msg.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(msg.params.executionContextId);
    } else if (msg.method === 'Runtime.executionContextsCleared') {
      contexts.clear();
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push('EXCEPTION ' + JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(msg.params.type + ' ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1500);
  const { frameTree } = await send('Page.getFrameTree');
  const topFrame = frameTree.frame.id;

  // Evaluate in the webview iframe's own execution context (CDP evaluation is
  // not subject to the page CSP, and sees the script's top-level bindings).
  const evalFrame = async expression => {
    let contextId;
    for (let i = 0; i < 50 && contextId === undefined; i++) {
      contextId = [...contexts.entries()].filter(([, frameId]) => frameId !== topFrame).map(([id]) => id).pop();
      if (contextId === undefined) {await sleep(100);}
    }
    const res = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, contextId, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);}
    return res.result.value;
  };
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Delete: 46, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, F2: 113, F3: 114 };
  const key = async (name, mods = []) => {
    const modifiers = mods.reduce((m, k) => m | MODS[k], 0);
    const isChar = name.length === 1;
    const code = KEYCODES[name] ?? (isChar ? name.toUpperCase().charCodeAt(0) : 0);
    const base = { modifiers, key: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await send('Input.dispatchKeyEvent', { type: isChar && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, text: isChar && !(modifiers & 6) ? name : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(60);
  };
  // Real key events per character (keydown → keypress → input), like a user.
  const type = async text => {
    for (const ch of text) {
      if (ch.charCodeAt(0) > 127) {
        await send('Input.insertText', { text: ch });
      } else {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
      }
    }
    await sleep(60);
  };
  const click = async (x, y, { button = 'left', clickCount = 1, mods = [] } = {}) => {
    const modifiers = mods.reduce((m, k) => m | MODS[k], 0);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers });
    await sleep(80);
  };
  const drag = async (x1, y1, x2, y2) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + (x2 - x1) * i / 5, y: y1 + (y2 - y1) * i / 5, button: 'left' });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    await sleep(80);
  };
  // Center of an element inside the iframe (iframe sits at 0,0 full size).
  const center = async selector => evalFrame(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const clickEl = async (selector, opts) => { const [x, y] = await center(selector); await click(x, y, opts); };
  const ime = async (composition, commit) => {
    await send('Input.imeSetComposition', { text: composition, selectionStart: composition.length, selectionEnd: composition.length });
    await sleep(60);
    await send('Input.insertText', { text: commit });
    await sleep(60);
  };
  const screenshot = async file => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  };
  const reload = async () => { await send('Page.reload'); await sleep(1500); };
  const close = async () => { try { await send('Browser.close'); } catch {} proc.kill(); };
  return { send, evalFrame, key, type, click, drag, clickEl, center, ime, screenshot, reload, close, consoleLines, sleep };
}

module.exports = { launch, sleep };
