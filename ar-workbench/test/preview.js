/*
 * Renders src/Workbench.html in headless Chromium with google.script.run bridged to Code.gs running
 * on the mock (see gas-mock.js). Takes screenshots for an associate, a team lead and management.
 *
 *   TZ=Asia/Kolkata node test/preview.js <fixture.json|--synthetic> <outDir> [associate] [pan]
 *
 * The team roster (roles / e-mails) is written into WB Settings by this script, so any workbook works.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, assertSerializable } = require('./gas-mock');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

function setRoster(env, rows) {
  const sh = env.ss.getSheetByName('WB Settings');
  rows.forEach((r) => {
    let i = sh.data.findIndex((x, k) => k >= 3 && x[0] === r[0]);
    if (i < 0) { i = Math.max(sh.getLastRow(), 3); }
    sh.set(i + 1, 1, r[0]); sh.set(i + 1, 2, r[1]); sh.set(i + 1, 3, r[2]); sh.set(i + 1, 4, r[3]); sh.set(i + 1, 5, 'Yes');
  });
}

async function main() {
  const [fixtureArg, outDir = 'preview-out', assocArg, panArg] = process.argv.slice(2);
  const fixture = fixtureArg && fixtureArg !== '--synthetic'
    ? JSON.parse(fs.readFileSync(fixtureArg, 'utf8'))
    : require('./synthetic-fixture').buildFixture();
  const env = load(fixture, { email: '' });
  env.ss.setActive(env.run('wbInit').associates[0], 3, 1);
  env.run('WB_setup');
  const associates = env.run('wbInit').associates;
  const me = assocArg || associates[0];
  const team = associates.filter((a) => a !== me).slice(0, 3).concat([me]);
  setRoster(env, [
    [me, 'Associate', 'Tara', 'me@example.com'],
    ...team.filter((a) => a !== me).map((a) => [a, 'Associate', 'Tara', '']),
    ['Tara', 'Team Lead', '', 'lead@example.com'],
    ['Maya', 'Management', '', 'boss@example.com']
  ]);
  env.run('WB_dailyMaintenance');
  env.run('WB_nightlySnapshot');
  env.ss.setActive(me, 3, 1);
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Workbench.html'), 'utf8');
  const errors = [];
  const book = env.run('wbGetBook', { assoc: me });
  const firstPan = panArg || book.rows.filter((r) => r.overdue > 0).sort((a, b) => b.overdue - a.overdue)[0].pan;
  const panData = env.run('wbGetPan', firstPan);
  const noPtpInv = (panData.invoices.find((i) => i.overdue && !i.ptpDate) || panData.invoices[0]).inv;
  const ptpDate = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);

  const browser = await chromium.launch();
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const shots = async (persona, email, mode, width, height, steps) => {
    if (only && !only.includes(persona + '-' + mode)) return;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => errors.push(persona + '/' + mode + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(persona + '/' + mode + ' console: ' + m.text()); });
    page.on('dialog', (d) => d.accept());
    await page.exposeFunction('__gas', (fn, argsJson) => {
      env.setEmail(email);
      const args = JSON.parse(argsJson);
      if (fn === 'WB_openFullScreen' || fn === 'WB_openWindow') return JSON.stringify({ ok: true });
      if (typeof env.ctx[fn] !== 'function') throw new Error('No server function ' + fn);
      const r = env.run(fn, ...args);
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
    const pageHtml = html.replace('<?= mode ?>', mode).replace('<?= startPan ?>', '').replace('<head>', '<head>' + shim);
    await page.setContent(pageHtml, { waitUntil: 'load' });
    for (const [name, fn] of steps) {
      await fn(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, `${persona}-${mode}-${name}.png`), fullPage: false });
    }
    await page.close();
  };
  const idle = (page) => page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 120000 });
  const openFirst = async (p) => { await p.click('[data-tab=pans]'); await idle(p); await p.click(`[data-pan="${firstPan}"]`); await idle(p); };

  await shots('associate', 'me@example.com', 'sidebar', 320, 820, [
    ['1-today', async (p) => { await idle(p); }],
    ['2-pans', async (p) => { await p.click('[data-tab=pans]'); await idle(p); }],
    ['3-pan', async (p) => { await p.click(`.item[data-pan="${firstPan}"]`); await idle(p); }],
    ['4-invoices', async (p) => { await p.evaluate(() => document.querySelector('.bulkptp').scrollIntoView()); }],
    ['5-inline-ptp', async (p) => {
      await p.fill(`input.ptp-in[data-i="${noPtpInv}"]`, ptpDate);
      await p.waitForFunction(() => document.querySelector('.toast'), null, { timeout: 30000 });
      await p.evaluate((inv) => document.querySelector(`input.ptp-in[data-i="${inv}"]`).scrollIntoView({ block: 'center' }), noPtpInv);
    }],
    ['6-sections', async (p) => { await p.evaluate(() => { document.querySelectorAll('details.sec').forEach((d, i) => { if (i < 3) d.open = true; }); document.querySelector('details.sec').scrollIntoView(); }); }],
    ['7-copy', async (p) => { await p.evaluate(() => window.scrollTo(0, 0)); await p.click('#aCopy'); }],
    ['8-io', async (p) => { await p.keyboard.press('Escape'); await p.click('#aIo'); }],
    ['9-iotab', async (p) => { await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.click('[data-tab=io]'); await idle(p); }],
    ['10-stats', async (p) => { await p.click('[data-tab=stats]'); await idle(p); }]
  ]);
  await shots('associate', 'me@example.com', 'full', 1360, 860, [
    ['1-today', async (p) => { await idle(p); }],
    ['2-pans', async (p) => { await p.click('[data-tab=pans]'); await idle(p); }],
    ['3-pan', async (p) => { await p.click(`tr[data-pan="${firstPan}"]`); await idle(p); }],
    ['4-copy', async (p) => { await p.click('#aCopy'); }],
    ['5-ptps', async (p) => { await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.click('[data-tab=ptps]'); await idle(p); }],
    ['6-search', async (p) => { await p.keyboard.press('Control+k'); await p.fill('#gq', panData.customer.slice(0, 5)); await p.waitForTimeout(900); }]
  ]);
  await shots('teamlead', 'lead@example.com', 'full', 1360, 860, [
    ['1-team', async (p) => { await idle(p); await p.click('[data-tab=team]'); await idle(p); }],
    ['2-queues', async (p) => { await p.evaluate(() => document.querySelector('.cols3').scrollIntoView()); }],
    ['3-pans', async (p) => { await p.evaluate(() => window.scrollTo(0, 0)); await p.click('[data-tab=pans]'); await idle(p); }]
  ]);
  await shots('mgmt', 'boss@example.com', 'full', 1360, 860, [
    ['1-overview', async (p) => { await idle(p); await p.click('[data-tab=overview]'); await idle(p); }],
    ['2-overview-mid', async (p) => { await p.evaluate(() => window.scrollTo(0, 900)); }],
    ['3-health', async (p) => { await p.evaluate(() => { document.querySelectorAll('.health details').forEach((d) => { d.open = true; }); document.getElementById('health').scrollIntoView(); }); }]
  ]);
  await shots('mgmt', 'boss@example.com', 'sidebar', 320, 820, [
    ['1-today-everyone', async (p) => { await idle(p); }],
    ['2-overview', async (p) => { await p.click('[data-tab=overview]'); await idle(p); }]
  ]);
  // Click through every form end to end (as a team lead, so team lead actions are available too).
  const waitToast = (p, re) => p.waitForFunction((src) => Array.from(document.querySelectorAll('.toast')).some((t) => new RegExp(src).test(t.textContent)), re, { timeout: 60000 });
  const clickText = (p, sel, text) => p.evaluate(([sl, tx]) => Array.from(document.querySelectorAll(sl)).find((b) => b.textContent.indexOf(tx) >= 0).click(), [sel, text]);
  await shots('flows', 'lead@example.com', 'full', 1360, 860, [
    ['1-ptp-form', async (p) => { await idle(p); await p.selectOption('#scope', 'a:' + me); await openFirst(p); await p.click('#aPtp'); await p.fill('#fContact', 'Mr. Rao'); }],
    ['2-ptp-saved', async (p) => { await p.click('#fSave'); await waitToast(p, 'PTP saved'); await idle(p); }],
    ['3-log', async (p) => { await p.click('#aLog'); await p.fill('#fRem', 'Asked for SOA'); await p.click('#fSave'); await waitToast(p, 'Follow-up logged'); await idle(p); }],
    ['4-confidence', async (p) => { await p.click('#aMore'); await p.click('#mConf'); await p.click('[data-all="green"]'); await p.click('#fSave'); await waitToast(p, 'Confidence saved'); await idle(p); }],
    ['5-remark', async (p) => { await p.click('#aMore'); await p.click('#mRemark'); await p.click('[data-q]'); await p.click('#fSave'); await waitToast(p, 'Remark saved'); }],
    ['6-tl-remark', async (p) => { await p.click('#aMore'); await p.click('#mTl'); await p.fill('#fRem', 'Call CFO today'); await p.click('#fSave'); await waitToast(p, 'Team lead remark saved'); }],
    ['7-tag', async (p) => { await p.click('.isel'); await p.click('#bTag'); await p.selectOption('#fTag', 'Disputed'); await p.click('#fSave'); await waitToast(p, 'Invoices tagged'); await idle(p); }],
    ['8-bulk-ptp', async (p) => { await p.selectOption('#bpScope', 'all'); await p.click('#bpApply'); await waitToast(p, 'saved on'); await idle(p); }],
    ['9-copy', async (p) => { await p.click('#aCopy'); await p.click('#mFmt [data-v="table"]'); await p.click('#mCopy'); await waitToast(p, 'Copied|blocked'); }],
    ['10-draft', async (p) => { await p.click('#mToDraft'); await p.fill('#mTo', 'ap@customer.test'); await clickText(p, '#modal .btn.primary', 'Create Gmail draft'); await p.waitForFunction(() => /Draft ready/.test(document.getElementById('modal').textContent), null, { timeout: 60000 }); }],
    ['11-io', async (p) => { await p.keyboard.press('Escape'); await p.click('#aIo'); await p.click('#fSt [data-v="1"]'); await p.fill('#fLink', 'https://drive.example/io'); await p.click('#fSave'); await waitToast(p, 'IO sign-off saved'); await idle(p); }],
    ['12-reassign', async (p) => { await p.click('#aMore'); await p.click('#mReassign'); await p.click('#fSave'); await waitToast(p, '^1 PAN\\(s\\) moved to'); await idle(p); }],
    ['13-bulk-daily', async (p) => { await p.click('#back'); await p.click('[data-tab=pans]'); await idle(p); await p.click('.bsel'); await p.click('[data-bulk="Yes"]'); await waitToast(p, 'marked'); }],
    ['14-io-tab', async (p) => { await p.click('[data-tab=io]'); await idle(p); await p.click('[data-io="all"]'); await p.click('[data-iopan]'); await p.fill('#fRem', 'Chased brand'); await p.click('#fSave'); await waitToast(p, 'IO'); await idle(p); }],
    ['14b-settled', async (p) => { await p.click('[data-tab=pans]'); await idle(p); await p.click('tr[data-pan]'); await idle(p); await p.evaluate(() => { document.querySelector('details.sec[data-sec="paid"]').open = true; }); await p.waitForFunction(() => !document.getElementById('paidBody'), null, { timeout: 60000 }); }],
    ['15-team', async (p) => { await p.click('[data-tab=team]'); await idle(p); await p.click('[data-assoc]'); await idle(p); }]
  ]);
  const log = env.ss.getSheetByName('WB Activity Log');
  if (!only || only.includes('flows-full')) console.log('Activity log rows written by the flows: ' + (log.getLastRow() - 1));
  await browser.close();
  if (errors.length) { console.error('Page errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('Screenshots written to ' + outDir + ' for ' + me + ' / ' + firstPan);
}
main().catch((e) => { console.error(e); process.exit(1); });
