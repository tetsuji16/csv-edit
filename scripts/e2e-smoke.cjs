// End-to-end smoke test: start the harness, drive headless Chrome/Edge with
// real input and check the document text after each interaction.
//   npm run compile && node scripts/e2e-smoke.cjs
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, sleep } = require('./cdp.cjs');

const PORT = 5399;
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-e2e-'));
const file = path.join(dir, 'orders.csv');
fs.writeFileSync(file, [
  'name,city,qty,note',
  'Alice,Tokyo,1,hello',
  'Bob,Osaka,2,"multi',
  'line"',
  'Carol,Kyoto,3, padded ',
  'Dave,Nagoya,4,'
].join('\n') + '\n');

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
};

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'webview-harness.cjs'), file, '--port', String(PORT), '--lang', 'en'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => server.stdout.once('data', resolve));
  const doc = async () => (await fetch(`http://localhost:${PORT}/doc`)).text();
  const clip = async () => (await fetch(`http://localhost:${PORT}/clipboard`)).text();
  const page = await launch(`http://localhost:${PORT}/`);
  const cell = (r, c) => `td[data-row="${r}"][data-col="${c}"], th[data-row="${r}"][data-col="${c}"]`;
  const selected = () => page.evalFrame(`anchorCell ? anchorCell.dataset.row + ',' + anchorCell.dataset.col : null`);
  const settle = () => sleep(700);

  try {
    await check('header detected for all-text CSV', async () => {
      assert.equal(await page.evalFrame(`!!document.querySelector('thead')`), true);
    });

    await check('typing replaces the active cell and Enter moves down', async () => {
      await page.clickEl(cell(1, 0));
      await page.type('Z');
      await page.key('Enter');
      await settle();
      assert.match(await doc(), /^name,city,qty,note\nZ,Tokyo/);
      assert.equal(await selected(), '2,0');
    });

    await check('IME composition goes into the cell', async () => {
      await page.clickEl(cell(1, 1));
      await page.key('Process');
      await page.ime('とうきょう', '東京');
      await page.key('Enter');
      await settle();
      assert.match(await doc(), /Z,東京,1/);
    });

    await check('Escape cancels an edit (even with find open)', async () => {
      await page.key('f', ['ctrl']);
      await page.clickEl(cell(4, 0));
      await page.key('F2');
      await page.type('XX');
      await page.key('Escape');
      await settle();
      assert.match(await doc(), /\nCarol,Kyoto/);
      assert.equal(await page.evalFrame(`findReplaceState.open`), true);
      await page.key('Escape');
      assert.equal(await page.evalFrame(`findReplaceState.open`), false);
    });

    await check('Delete clears a range in one undo step', async () => {
      const before = await doc();
      const [x1, y1] = await page.center(cell(1, 2));
      const [x2, y2] = await page.center(cell(4, 2));
      await page.drag(x1, y1, x2, y2);
      await page.key('Delete');
      await settle();
      assert.match(await doc(), /Z,東京,,hello/);
      await page.clickEl('#undoButton');
      await settle();
      assert.equal(await doc(), before);
    });

    await check('status shows sum/average/count', async () => {
      const [x1, y1] = await page.center(cell(1, 2));
      const [x2, y2] = await page.center(cell(4, 2));
      await page.drag(x1, y1, x2, y2);
      await sleep(100);
      const text = await page.evalFrame(`(updateModernStatus(), document.getElementById('aggregateStatus').textContent)`);
      assert.match(text, /10/);
      assert.match(text, /2\.5/);
    });

    await check('copy and cut use TSV; cut clears in one edit', async () => {
      await page.clickEl(cell(1, 3));
      await page.key('c', ['ctrl']);
      await sleep(300);
      assert.equal(await clip(), 'hello');
      await page.key('x', ['ctrl']);
      await settle();
      assert.match(await doc(), /Z,東京,1,\n/);
    });

    await check('context menu paste uses the extension clipboard', async () => {
      await page.clickEl(cell(4, 3), { button: 'right' });
      const labels = await page.evalFrame(`Array.from(document.querySelectorAll('#contextMenu .menu-item')).map(n => n.firstChild.textContent)`);
      assert.ok(labels.includes('Paste'), labels.join('|'));
      await page.evalFrame(`Array.from(document.querySelectorAll('#contextMenu .menu-item')).find(n => n.firstChild.textContent === 'Paste').click()`);
      await settle();
      assert.match(await doc(), /Dave,Nagoya,4,hello/);
    });

    await check('filter panel is visible and survives a structural edit', async () => {
      await page.clickEl('#toolbarFilter');
      await page.type('kyo');
      await sleep(400);
      const visible = await page.evalFrame(`Array.from(document.querySelectorAll('tbody tr')).filter(r => r.style.display !== 'none').length`);
      assert.equal(visible, 1); // only the Kyoto row
      const rect = await page.evalFrame(`document.getElementById('csvPanel').getBoundingClientRect().width`);
      assert.ok(rect > 200);
      await page.clickEl(cell(3, 0), { button: 'right' });
      await page.evalFrame(`Array.from(document.querySelectorAll('#contextMenu .menu-item')).find(n => /below/.test(n.firstChild.textContent)).click()`);
      await sleep(1500);
      assert.equal(await page.evalFrame(`document.getElementById('quickFilterInput')?.value`), 'kyo');
      await page.evalFrame(`(setQuickFilter(''), closePanel())`);
      await page.clickEl('#undoButton');
      await sleep(1500);
    });

    await check('clean & transform previews then applies without touching the header', async () => {
      await page.evalFrame(`document.getElementById('toolbarTools').click()`);
      await page.evalFrame(`document.querySelector('[data-tool="uppercase"]').click()`);
      await sleep(600);
      const preview = await page.evalFrame(`document.getElementById('toolResult').innerText`);
      assert.match(preview, /cells will change/);
      await page.evalFrame(`document.querySelector('#toolResult .primary-button').click()`);
      await sleep(1500);
      const text = await doc();
      assert.match(text, /^name,city,qty,note\n/);
      assert.match(text, /CAROL,KYOTO/);
      assert.match(await page.evalFrame(`document.getElementById('toolResult')?.innerText || ''`), /Applied/);
      await page.clickEl('#undoButton');
      await sleep(1500);
    });

    await check('fill empty uses an inline value field', async () => {
      await page.evalFrame(`document.querySelector('[data-tool="fillEmpty"]').click()`);
      await page.type('N/A');
      await page.key('Enter');
      await sleep(600);
      assert.match(await page.evalFrame(`document.getElementById('toolResult').innerText`), /1 cells will change/);
      await page.evalFrame(`closePanel()`);
    });

    await check('validation lists issues and jumps to the cell', async () => {
      await page.evalFrame(`document.getElementById('toolbarValidate').click()`);
      await sleep(600);
      const text = await page.evalFrame(`document.getElementById('panelBody').innerText`);
      assert.match(text, /No issues|issue/);
      await page.evalFrame(`closePanel()`);
    });

    await check('name box jumps to a row (and optional column)', async () => {
      await page.clickEl(cell(1, 2));
      await page.clickEl('#formulaNameBox');
      await page.type('3');
      await page.key('Enter');
      assert.equal(await selected(), '3,2'); // keeps the current column
      await page.clickEl('#formulaNameBox');
      await page.type('2,4');
      await page.key('Enter');
      assert.equal(await selected(), '2,3');
    });

    await check('narrow layout keeps toolbar buttons from overlapping', async () => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 700, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const overlaps = await page.evalFrame(`(() => {
        const rects = Array.from(document.querySelectorAll('.command-primary > button, .command-primary > details > summary')).map(b => b.getBoundingClientRect());
        return rects.some((r, i) => i > 0 && r.left < rects[i - 1].right - 0.5);
      })()`);
      assert.equal(overlaps, false);
      await page.send('Emulation.clearDeviceMetricsOverride');
    });

    await check('no runtime exceptions', async () => {
      const errors = page.consoleLines.filter(line => /EXCEPTION|error/i.test(line));
      assert.deepEqual(errors, []);
    });

    await page.screenshot(path.join(dir, 'final.png'));
  } finally {
    await page.close();
    server.kill();
  }
  console.log(results.join('\n'));
  console.log(`screenshot: ${path.join(dir, 'final.png')}`);
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
