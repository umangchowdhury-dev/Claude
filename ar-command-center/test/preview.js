/*
 * Render src/Workbench.html in headless Chromium with google.script.run bridged to the .gs code on the mock.
 *
 *   TZ=Asia/Kolkata node test/preview.js <live-fixture.json|--synthetic> <outDir>
 *
 * Runs CC_setup (first sync) against the fixture, then takes screenshots as an associate, a team lead
 * and management.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, assertSerializable } = require('./gas-mock');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

async function main() {
  const [fixtureArg, outDir = 'preview-out'] = process.argv.slice(2);
  const live = fixtureArg && fixtureArg !== '--synthetic' ? JSON.parse(fs.readFileSync(fixtureArg, 'utf8')) : require('./synthetic-fixture').buildLive();
  const env = load({ live, promptAnswer: 'LIVE' });
  env.ctx.CC_setup();
  // Demo roster: first associate is "me", two team leads, one manager.
  const team = env.ss.getSheetByName('Team');
  const names = team.data.slice(1).map((r) => r[0]).filter(Boolean);
  team.data.slice(1).forEach((r, i) => { if (r[0]) { r[2] = i < names.length / 2 ? 'Team Lead A' : 'Team Lead B'; if (i === 0) r[4] = 'associate@example.com'; } });
  team.data.push(['Team Lead A', 'Team Lead', '', 'Collections', 'tl@example.com', 'Yes', '', '']);
  team.data.push(['Head of AR', 'Management', '', 'Management', 'mgmt@example.com', 'Yes', '', '']);
  env.ctx.ccRebuild_();
  env.ctx.ccWriteSnapshot_(env.ctx.ccRebuild_().model);
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Workbench.html'), 'utf8');
  const errors = [];
  const browser = await chromium.launch();
  const waitIdle = (page) => page.waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 120000 });

  const session = async (label, email, mode, width, height, steps) => {
    env.setEmail(email);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => errors.push(label + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(label + ' console: ' + m.text()); });
    await page.exposeFunction('__gas', (fn, argsJson) => {
      if (fn === 'CC_openFullScreen') return JSON.stringify(null);
      if (typeof env.ctx[fn] !== 'function') throw new Error('No server function ' + fn);
      const r = env.ctx[fn](...JSON.parse(argsJson));
      assertSerializable(r, fn);
      return JSON.stringify(r === undefined ? null : r);
    });
    const shim = `<script>window.google={script:{run:(function mk(ok,fail){return new Proxy({},{get:function(_,n){
      if(n==='withSuccessHandler')return function(f){return mk(f,fail)};if(n==='withFailureHandler')return function(f){return mk(ok,f)};
      return function(){var a=Array.prototype.slice.call(arguments);window.__gas(n,JSON.stringify(a)).then(function(r){ok&&ok(JSON.parse(r))},function(e){fail&&fail(e)})}}})})()}};</script>`;
    await page.setContent(html.replace('<?= mode ?>', mode).replace('<?= startPan ?>', '').replace('<head>', '<head>' + shim), { waitUntil: 'load' });
    for (const [name, fn] of steps) {
      await fn(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, `${label}-${name}.png`) });
    }
    await page.close();
  };

  const firstOverduePan = (p) => p.locator('[data-pan]').first().click();
  await session('associate', 'associate@example.com', 'full', 1320, 840, [
    ['1-today', waitIdle],
    ['2-pans', async (p) => { await p.click('[data-tab=pans]'); await waitIdle(p); }],
    ['3-pan', async (p) => { await p.locator('tr[data-pan]').first().click(); await waitIdle(p); }],
    ['4-confidence', async (p) => { await p.click('#aConf'); await p.click('[data-all=amber]'); }],
    ['5-saved', async (p) => { await p.click('#fSave'); await waitIdle(p); await p.click('#aPtp'); await p.fill('#fContact', 'Mr. Rao'); await p.click('#fSave'); await waitIdle(p); }],
    ['6-stats', async (p) => { await p.click('[data-tab=stats]'); await waitIdle(p); }]
  ]);
  await session('sidebar', 'associate@example.com', 'sidebar', 300, 760, [
    ['1-today', waitIdle],
    ['2-pan', async (p) => { await firstOverduePan(p); await waitIdle(p); }]
  ]);
  await session('teamlead', 'tl@example.com', 'full', 1320, 840, [
    ['1-review', async (p) => { await waitIdle(p); await p.click('[data-tab=team]'); await waitIdle(p); }],
    ['2-queue', async (p) => { await p.click('[data-q=gt60NoPtp]'); }]
  ]);
  await session('mgmt', 'mgmt@example.com', 'full', 1320, 840, [
    ['1-overview', waitIdle],
    ['2-overview-scroll', async (p) => { await p.mouse.wheel(0, 900); }]
  ]);
  await browser.close();
  if (errors.length) { console.error('Page errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('Screenshots in ' + outDir);
}
main().catch((e) => { console.error(e); process.exit(1); });
