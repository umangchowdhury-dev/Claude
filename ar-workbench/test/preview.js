/*
 * Renders src/Workbench.html in headless Chromium with google.script.run bridged to Code.gs running
 * on the mock (see gas-mock.js). Useful for UI checks and screenshots without deploying.
 *
 *   TZ=Asia/Kolkata node test/preview.js <fixture.json|--synthetic> <outDir> [associate] [pan]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, assertSerializable } = require('./gas-mock');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

async function main() {
  const [fixtureArg, outDir = 'preview-out', assoc, pan] = process.argv.slice(2);
  const fixture = fixtureArg && fixtureArg !== '--synthetic'
    ? JSON.parse(fs.readFileSync(fixtureArg, 'utf8'))
    : require('./synthetic-fixture').buildFixture();
  const env = load(fixture);
  const me = assoc || env.ctx.wbInit().associates[0];
  env.ss.setActive(me, 3, 1);
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Workbench.html'), 'utf8');
  const errors = [];

  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
  const shots = async (mode, width, height, steps) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => errors.push(mode + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(mode + ' console: ' + m.text()); });
    await page.exposeFunction('__gas', (fn, argsJson) => {
      const args = JSON.parse(argsJson);
      if (fn === 'WB_openFullScreen') return JSON.stringify({ ok: true });
      if (typeof env.ctx[fn] !== 'function') throw new Error('No server function ' + fn);
      const r = env.ctx[fn](...args);
      assertSerializable(r, fn);
      return JSON.stringify(r === undefined ? null : r);
    });
    const shim = `<script>
      window.google = { script: { run: (function mk(ok, fail) {
        return new Proxy({}, { get: function (_, name) {
          if (name === 'withSuccessHandler') return function (f) { return mk(f, fail); };
          if (name === 'withFailureHandler') return function (f) { return mk(ok, f); };
          return function () {
            var args = Array.prototype.slice.call(arguments);
            window.__gas(name, JSON.stringify(args)).then(function (r) { ok && ok(JSON.parse(r)); }, function (e) { fail && fail(e); });
          };
        } });
      })() } };
    </script>`;
    const page_html = html.replace('<?= mode ?>', mode).replace('<?= startPan ?>', '').replace('<head>', '<head>' + shim);
    await page.setContent(page_html, { waitUntil: 'load' });
    for (const [name, fn] of steps) {
      await fn(page);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(outDir, `${mode}-${name}.png`), fullPage: false });
    }
    await page.close();
  };
  const waitIdle = (page) => page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 60000 });
  const firstPan = pan || env.ctx.wbGetBook(me).rows.filter((r) => r.overdue > 0).sort((a, b) => b.overdue - a.overdue)[0].pan;

  await shots('sidebar', 300, 760, [
    ['1-today', async (p) => { await waitIdle(p); }],
    ['2-pans', async (p) => { await p.click('[data-tab=pans]'); await waitIdle(p); }],
    ['3-pan', async (p) => { await p.click(`.item[data-pan="${firstPan}"]`); await waitIdle(p); }],
    ['4-pan-selected', async (p) => { await p.click('#sOver'); await p.evaluate(() => window.scrollTo(0, 600)); }],
    ['5-ptp-form', async (p) => { await p.click('#bPtp'); }],
    ['6-stats', async (p) => { await p.keyboard.press('Escape'); await p.click('[data-tab=stats]'); await waitIdle(p); }]
  ]);
  await shots('full', 1280, 820, [
    ['1-today', async (p) => { await waitIdle(p); }],
    ['2-pans', async (p) => { await p.click('[data-tab=pans]'); await waitIdle(p); }],
    ['3-pan', async (p) => { await p.click(`tr[data-pan="${firstPan}"]`); await waitIdle(p); }],
    ['4-followup', async (p) => { await p.click('#aLog'); }],
    ['5-save-ptp', async (p) => {
      await p.keyboard.press('Escape');
      await p.click('#aPtp');
      await p.fill('#fContact', 'Mr. Rao (AP)');
      await p.fill('#fRem', 'Finance approved, payment run on Friday');
      await p.click('#fSave');
      await waitIdle(p);
    }],
    ['6-ptps', async (p) => { await p.click('[data-tab=ptps]'); await waitIdle(p); }],
    ['7-stats', async (p) => { await p.click('[data-tab=stats]'); await waitIdle(p); }]
  ]);
  await browser.close();
  if (errors.length) { console.error('Page errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('Screenshots written to ' + outDir + ' for ' + me + ' / ' + firstPan);
}
main().catch((e) => { console.error(e); process.exit(1); });
