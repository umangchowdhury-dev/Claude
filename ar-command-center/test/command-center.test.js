/*
 * Tests for src/*.gs against the synthetic live workbook (test/synthetic-fixture.js).
 * Run: TZ=Asia/Kolkata node --test test/*.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, assertSerializable, table } = require('./gas-mock');
const { buildLive, key, day, TODAY } = require('./synthetic-fixture');

function fresh(opts = {}) {
  const env = load({ live: buildLive(), promptAnswer: 'https://docs.google.com/spreadsheets/d/LIVE/edit#gid=0', ...opts });
  env.ctx.CC_setup();
  return env;
}
// Round-trip like google.script.run (also avoids cross-realm objects from the vm sandbox).
const call = (env, fn, ...args) => { const r = env.ctx[fn](...args); assertSerializable(r, fn); return JSON.parse(JSON.stringify(r === undefined ? null : r)); };
const pan = (env, p) => table(env.ss, 'PAN Master').find((r) => r.PAN === p);
const ptp = (env, inv) => table(env.ss, 'PTP Tracker').find((r) => r['Invoice No'] === inv);
const fu = (env, p, k) => table(env.ss, 'Follow-ups').find((r) => r.PAN === p && key(r.Date) === k);
const liveSheet = (env, name) => env.live.getSheetByName(name);
function setTeam(env, rows) {
  const t = env.ss.getSheetByName('Team');
  rows.forEach((r) => {
    const i = t.data.findIndex((x) => x[0] === r[0]);
    if (i >= 0) t.data[i] = r; else t.data.push(r);
  });
}

test('runs in the spreadsheet time zone', () => assert.equal(process.env.TZ, 'Asia/Kolkata'));

test('setup creates every tab in order, stores the live ID and installs triggers', () => {
  const env = fresh();
  const names = env.ss.getSheets().map((s) => s.getName());
  assert.deepEqual(names, ['Home', 'Dashboard', 'PAN Master', 'PTP Tracker', 'Follow-ups', 'Activity Log', 'IO Sign-off', 'Snapshots',
    'Team', 'Config', 'Invoices', 'Payables', 'Map: Category', 'Map: Brand', 'List: Exposure PANs', 'List: Historic AR-AP PANs', 'PAN Inputs', 'Sync Log']);
  assert.equal(env.ctx.ccConfig_().LIVE_SHEET_ID, 'LIVE');
  assert.deepEqual(env.triggers.slice().sort(), ['CC_dailyMaintenance', 'CC_nightlySnapshot', 'CC_scheduledSync']);
  env.ctx.CC_setup();
  assert.equal(env.triggers.length, 3, 'idempotent');
  assert.match(table(env.ss, 'Sync Log')[0].Result, /OK/);
});

test('raw data is mirrored and skipped when unchanged', () => {
  const env = fresh();
  assert.equal(table(env.ss, 'Invoices').length, 10);
  assert.equal(table(env.ss, 'Payables').length, 2);
  assert.equal(table(env.ss, 'List: Exposure PANs').length, 1);
  const r = env.ctx.ccSync_();
  assert.match(r.summary, /Invoices unchanged/);
  liveSheet(env, 'Imported_Data').data[4][15] = 51000; // INV-A1 part-paid in the source
  assert.match(env.ctx.ccSync_().summary, /Invoices 10 rows/);
  assert.equal(pan(env, 'AAAPA1111A')['g.>151'], 51000);
});

test('team roster is created from the live tabs, with the "Legal" label from the old Summary', () => {
  const env = fresh();
  const t = table(env.ss, 'Team');
  assert.deepEqual(t.map((r) => [r.Name, r.Role, r.Group]), [['Asha', 'Associate', 'Collections'], ['Ravi', 'Associate', 'Legal']]);
});

test('PAN Master reproduces the old Consolidated / associate-tab columns', () => {
  const env = fresh();
  const a = pan(env, 'AAAPA1111A');
  assert.equal(a['Customer Name'], 'Alpha Foods Pvt Ltd');
  assert.equal(a.Associate, 'Asha');
  assert.equal(a['Brand Names'], 'Alpha, Alpha Kids', 'unique + trimmed');
  assert.equal(a.KAMs, 'kam.one, kam.two');
  assert.equal(a['Due Activity Months'], "P.Aug'2026", 'only months with an open balance');
  assert.equal(a['BU Head'], 'BU Boss, Other Boss');
  assert.equal(a['Business Model'], 'SOR');
  assert.equal(a['Exposure / Defaulting PAN?'], 'Yes');
  assert.equal(a['Historically AR AP Done?'], 'No');
  assert.equal(a['IO Sign Off Incentive'], 500);
  assert.equal(a['IO Signed?'], 'Yes');
  assert.equal(a['a.Not Due'], 5000);
  assert.equal(a['c.31-60'], 20000);
  assert.equal(a['g.>151'], 50000);
  assert.equal(a['Total Receivables'], 75000);
  assert.equal(a['Total Overdue Receivables'], 70000);
  assert.equal(a['>60 days receivables'], 50000);
  assert.equal(a['Net Payable Balance'], 100000);
  assert.equal(a['Possible AR AP'], 70000, 'MIN(overdue, net payable)');
  assert.equal(a['Possible AR AP (on total)'], 75000);
  assert.equal(a['Possible AR AP > 60 days'], 50000);
  assert.equal(a['Open Invoices'], 3);
  assert.equal(a['Oldest (days)'], 200);
  // inputs from the live tab
  assert.equal(a['Associate Remarks'], 'waiting for update');
  assert.equal(a['Team Lead Remarks'], 'push hard');
  assert.equal(a['POE Required?'], 'Yes');
  assert.equal(a.Red, 30000);
  assert.equal(a.Green, 40000);
  assert.equal(a['Collection Confidence'], 'Green', 'largest colour wins');
  const c = pan(env, 'CCCPC3333C');
  assert.equal(c['Business Model'], 'Vendor Does not Exist');
  assert.equal(c['Net Payable Balance'], 0);
  assert.equal(c['Possible AR AP'], 0);
  const d = pan(env, 'DDDPD4444D');
  assert.equal(d.Associate, 'Ravi');
  assert.equal(d.Group, 'Legal');
  assert.equal(d['Historically AR AP Done?'], 'Yes');
  assert.equal(d['IO Sign Off Incentive'], 'NA', 'rate 0 -> NA like the old formula');
  assert.equal(d['Associate Remarks'], 'legal notice sent', 'reads the "Remarks" header alias');
  assert.equal(d['Amber (Yellow)'], 50000);
  const orphan = pan(env, 'FFFPF6666F');
  assert.equal(orphan.Associate, '', 'open PAN on no tab shows up unassigned instead of disappearing');
  assert.equal(pan(env, 'EEEPE5555E')['Total Receivables'], 0);
});

test('follow-up grid becomes the Follow-ups log', () => {
  const env = fresh();
  const rows = table(env.ss, 'Follow-ups');
  assert.equal(rows.length, 5);
  assert.equal(fu(env, 'AAAPA1111A', key(day(-1))).Status, 'PTP');
  assert.equal(fu(env, 'AAAPA1111A', key(day(-1))).Source, 'Live');
  const a = pan(env, 'AAAPA1111A');
  assert.equal(key(a['Last Follow-up']), key(day(-1)));
  assert.equal(a['Days Since F/U'], 1);
});

test('PTP Tracker is imported and refreshed (free-text dates, broken, kept, PAN)', () => {
  const env = fresh();
  const a2 = ptp(env, 'INV-A2');
  assert.equal(key(a2['PTP Date']), TODAY, '"26th sep" typed into Status becomes a PTP date');
  assert.equal(a2.Status, 'PTP Due Today');
  assert.match(a2['PTP Remarks'], /th /);
  assert.equal(a2.PAN, 'AAAPA1111A');
  assert.equal(ptp(env, 'INV-B1').Status, 'PTP Broken');
  const b2 = ptp(env, 'INV-B2');
  assert.equal(b2.Status, 'Paid (PTP Kept)');
  assert.equal(key(b2['Settlement Date']), key(day(-1)));
  assert.equal(pan(env, 'BBBPB2222B')['Broken PTPs'], 1);
});

test('merge rule: edits made here survive syncs until the live value itself changes', () => {
  const env = fresh();
  call(env, 'ccSaveRemark', 'AAAPA1111A', 'new sheet remark', 'remarks');
  env.ctx.ccSync_();
  assert.equal(pan(env, 'AAAPA1111A')['Associate Remarks'], 'new sheet remark', 'unchanged live value does not overwrite');
  liveSheet(env, 'Asha').data[2][28] = 'changed in live sheet';
  env.ctx.ccSync_();
  assert.equal(pan(env, 'AAAPA1111A')['Associate Remarks'], 'changed in live sheet', 'a newer live change wins');
});

test('merge rule: follow-ups entered here win; cleared live cells disappear', () => {
  const env = fresh();
  call(env, 'ccBulkDaily', ['BBBPB2222B'], 'Expected Payment');
  const col = 33 + 20; // today's column in the live tab (dates start at -20 in column 34)
  liveSheet(env, 'Asha').data[3][col] = 'No';
  env.ctx.ccSync_();
  assert.equal(fu(env, 'BBBPB2222B', TODAY).Status, 'Expected Payment');
  liveSheet(env, 'Asha').data[2][33 + 17] = ''; // clear AAAPA1111A day -3
  env.ctx.ccSync_();
  assert.equal(fu(env, 'AAAPA1111A', key(day(-3))), undefined);
});

test('merge rule: PTP rows updated here keep their PTP on resync', () => {
  const env = fresh();
  call(env, 'ccSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(4)) });
  env.ctx.ccSync_();
  assert.equal(key(ptp(env, 'INV-A1')['PTP Date']), key(day(4)));
  assert.equal(ptp(env, 'INV-A1').Status, 'PTP Given');
});

test('Dashboard: old Summary columns per associate, checks reconcile', () => {
  const env = fresh();
  const m = env.ctx.ccLightModel_({ withInvoiceTotal: true });
  const sum = JSON.parse(JSON.stringify(env.ctx.ccSummaryByAssociate_(m)));
  const asha = sum.find((s) => s.name === 'Asha');
  assert.equal(asha.totalAccounts, 4);
  assert.equal(asha.nonZero, 3);
  assert.equal(asha.total, 113000);
  assert.equal(asha.remarksFilled, 1);
  assert.equal(asha.exposureAccts, 1);
  assert.equal(asha.possibleArAp, 70000 + 25000);
  assert.equal(asha.red, 30000);
  assert.equal(asha.green, 40000);
  assert.equal(asha.ioDone, 1);
  assert.equal(asha.ioIncentive, 500);
  const legal = sum.find((s) => s.name === 'Ravi');
  assert.equal(legal.group, 'Legal');
  assert.equal(legal.possibleArApHist, 0);
  assert.equal(sum.find((s) => s.name === 'Unassigned').total, 7000);
  const tot = sum[sum.length - 1];
  assert.equal(tot.total, m.inv.total, 'Overall check = 0');
  const dash = env.ss.getSheetByName('Dashboard').data.map((r) => r[0]);
  ['Associate summary', 'Daily follow-ups done per associate', 'Team leads', 'Ageing by business model', 'Top 25 overdue PANs',
    '>60 days with no open PTP (top 25)', 'Improvement points (from the old Summary tab)'].forEach((t) => assert.ok(dash.includes(t), t));
  assert.ok(dash.some((v) => String(v).indexOf('✓') === 0 || v === 'Total receivables'));
});

test('grid edits: yellow columns are saved to PAN Inputs and survive a rebuild', () => {
  const env = fresh();
  const pm = env.ss.getSheetByName('PAN Master');
  const H = env.ctx.ccPanColIndex_();
  const row = pm.data.findIndex((r) => r[0] === 'CCCPC3333C') + 1;
  pm.data[row - 1][H.remarks] = 'typed in grid';
  pm.data[row - 1][H.todayStatus] = 'Yes';
  const rangeOf = (c) => pm.getRange(row, c + 1, 1, 1);
  env.ctx.onEdit({ range: rangeOf(H.remarks) });
  env.ctx.onEdit({ range: rangeOf(H.todayStatus) });
  env.ctx.ccRebuild_();
  const c = pan(env, 'CCCPC3333C');
  assert.equal(c['Associate Remarks'], 'typed in grid');
  assert.equal(c["Today's Status"], 'Yes');
  assert.equal(fu(env, 'CCCPC3333C', TODAY).Source, 'Sheet');
  assert.ok(c['Last Updated On']);
});

test('workbench: book scopes, PAN drill-down, actions', () => {
  const env = fresh();
  setTeam(env, [['Asha', 'Associate', 'Tina', 'Collections', 'asha@x.com', 'Yes', 'Asha', ''], ['Ravi', 'Associate', 'Tina', 'Legal', '', 'Yes', 'Ravi', ''],
    ['Tina', 'Team Lead', '', 'Collections', 'tina@x.com', 'Yes', '', '']]);
  env.setEmail('asha@x.com');
  const init = call(env, 'ccInit');
  assert.equal(init.me, 'Asha');
  assert.equal(init.role, 'Associate');
  assert.deepEqual(init.teamLeads, ['Tina']);
  assert.equal(call(env, 'ccGetBook', { assoc: 'Asha' }).rows.length, 4);
  assert.equal(call(env, 'ccGetBook', { teamLead: 'Tina' }).rows.length, 5);
  assert.equal(call(env, 'ccGetBook', { all: true }).rows.length, 6);

  const d = call(env, 'ccGetPan', 'AAAPA1111A');
  assert.deepEqual(d.invoices.map((i) => i.inv), ['INV-A1', 'INV-A2', 'INV-A3']);
  assert.equal(d.invoices.reduce((s, i) => s + i.net, 0), d.header.total);
  assert.equal(d.invoices[1].ptpStatus, 'PTP Due Today');
  assert.deepEqual(d.paid.map((p) => p.inv), ['INV-A0']);
  assert.equal(d.header.recentDates.length, 14);

  const r = call(env, 'ccSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1', 'INV-A3'], ptpDate: key(day(3)), amounts: { 'INV-A1': 30000 }, contact: 'Rao' });
  assert.equal(r.amount, 35000);
  assert.equal(ptp(env, 'INV-A3')['PTP Amount'], 5000, 'new tracker row for an invoice not in the tracker');
  assert.equal(fu(env, 'AAAPA1111A', TODAY).Status, 'PTP');
  assert.equal(pan(env, 'AAAPA1111A')['Open PTPs'], 3, 'roll-up patched immediately');
  call(env, 'ccLogFollowUp', { pan: 'AAAPA1111A', channel: 'Call', outcome: 'Callback requested', nextDate: key(day(1)), daily: 'Yes' });
  assert.equal(fu(env, 'AAAPA1111A', TODAY).Status, 'PTP', 'not downgraded to Yes');
  assert.equal(key(pan(env, 'AAAPA1111A')['Next Follow-up']), key(day(1)));
  call(env, 'ccTagInvoices', { pan: 'BBBPB2222B', invoices: ['INV-B1'], tag: 'Disputed' });
  assert.equal(ptp(env, 'INV-B1')['Invoice Tag'], 'Disputed');
  call(env, 'ccSetConfidence', 'BBBPB2222B', { redAmt: 30000 }, 'No');
  assert.equal(pan(env, 'BBBPB2222B')['Collection Confidence'], 'Red');
  call(env, 'ccReassign', ['FFFPF6666F'], 'Ravi');
  env.ctx.ccSync_();
  assert.equal(pan(env, 'FFFPF6666F').Associate, 'Ravi', 'reassignment survives sync');
  const mail = call(env, 'ccCreateEmailDraft', { pan: 'AAAPA1111A', invoices: ['INV-A1', 'INV-A2'], to: 'ap@alpha.test' });
  assert.equal(mail.total, 70000);
  assert.match(env.drafts[0].o.htmlBody, /INV-A2/);
  const log = table(env.ss, 'Activity Log').map((l) => l.Type);
  ['PTP', 'Call', 'Status', 'Reassigned', 'Email'].forEach((t) => assert.ok(log.includes(t), t));
});

test('team review, overview and productivity', () => {
  const env = fresh();
  setTeam(env, [['Asha', 'Associate', 'Tina', 'Collections', '', 'Yes', 'Asha', ''], ['Ravi', 'Associate', 'Tina', 'Legal', '', 'Yes', 'Ravi', '']]);
  const rev = call(env, 'ccGetTeamReview', 'Tina');
  assert.deepEqual(rev.associates.map((a) => a.name), ['Asha', 'Ravi']);
  assert.deepEqual(rev.queues.broken.map((r) => r.pan), ['BBBPB2222B']);
  assert.ok(rev.queues.gt60NoPtp.some((r) => r.pan === 'DDDPD4444D'));
  const ov = call(env, 'ccGetOverview');
  assert.equal(ov.recon.diff, 0);
  assert.equal(ov.total.total, 170000);
  const pr = call(env, 'ccGetProductivity', 'Asha');
  assert.equal(pr.mine.active, 3);
  assert.equal(pr.ptp.kept, 1);
  assert.equal(pr.ptp.broken, 1);
  assert.equal(pr.mine.trend.length, 21);
});

test('selection follow resolves PANs from PAN Master, PTP Tracker and Follow-ups', () => {
  const env = fresh();
  const row = env.ss.getSheetByName('PAN Master').data.findIndex((r) => r[0] === 'DDDPD4444D') + 1;
  env.ss.setActive('PAN Master', row, 5);
  assert.equal(call(env, 'ccGetSelection').pan, 'DDDPD4444D');
  env.ss.setActive('PTP Tracker', 2, 3);
  assert.equal(call(env, 'ccGetSelection').pan, 'AAAPA1111A');
  env.ss.setActive('Follow-ups', 2, 1);
  assert.ok(call(env, 'ccGetSelection').pan);
  env.ss.setActive('PAN Master', 1, 1);
  assert.equal(call(env, 'ccGetSelection').pan, '');
});

test('daily maintenance: auto "Invoice Not Due", new overdue invoices into PTP Tracker; nightly snapshot', () => {
  const env = fresh();
  env.ctx.CC_dailyMaintenance();
  assert.equal(fu(env, 'CCCPC3333C', TODAY).Status, 'Invoice Not Due');
  assert.equal(fu(env, 'CCCPC3333C', TODAY).Source, 'Auto');
  assert.equal(fu(env, 'BBBPB2222B', TODAY), undefined, 'PANs with overdue are left to the associate');
  assert.ok(ptp(env, 'INV-D1'));
  assert.equal(ptp(env, 'INV-D1').Associate, 'Ravi');
  assert.equal(ptp(env, 'INV-C1'), undefined, 'not-due invoices are not added');
  const n = table(env.ss, 'PTP Tracker').length;
  env.ctx.CC_dailyMaintenance();
  assert.equal(table(env.ss, 'PTP Tracker').length, n, 'idempotent');
  env.ctx.CC_nightlySnapshot();
  env.ctx.CC_nightlySnapshot();
  const snaps = table(env.ss, 'Snapshots');
  assert.equal(snaps.filter((s) => s.Associate === 'Asha').length, 1, 'one row per associate per day');
});

test('RESTRICT_VIEWS keeps associates to their own PANs', () => {
  const env = fresh();
  setTeam(env, [['Asha', 'Associate', '', 'Collections', 'asha@x.com', 'Yes', 'Asha', '']]);
  env.ctx.ccSetConfig_('RESTRICT_VIEWS', 'Yes');
  env.setEmail('asha@x.com');
  assert.ok(call(env, 'ccGetPan', 'AAAPA1111A').header);
  assert.throws(() => env.ctx.ccGetPan('DDDPD4444D'), /own/);
  assert.throws(() => env.ctx.ccGetBook({ all: true }), /own/);
});

test('LIVE mode stops pulling associate inputs but keeps raw data flowing', () => {
  const env = fresh();
  env.ctx.ccSetConfig_('MODE', 'LIVE');
  liveSheet(env, 'Asha').data[2][28] = 'should be ignored';
  liveSheet(env, 'Imported_Data').data[4][15] = 45000;
  env.ctx.ccSync_();
  const a = pan(env, 'AAAPA1111A');
  assert.equal(a['Associate Remarks'], 'waiting for update');
  assert.equal(a['g.>151'], 45000);
});

test('sync pauses before Google\'s 6-minute limit and resumes by itself', () => {
  const env = fresh();
  env.live.getSheetByName('Imported_Data').data[4][15] = 52000;
  env.live.getSheetByName('Asha').data[2][28] = 'remark during a long sync';
  const r = env.ctx.ccSync_({ budgetMs: 0 }); // no time left after the first stage
  assert.equal(r.pending, true);
  assert.equal(env.scriptProps.getProperty('cc_sync_stage'), '1');
  assert.ok(env.triggers.includes('CC_resumeSync'));
  assert.equal(pan(env, 'AAAPA1111A')['Associate Remarks'], 'waiting for update', 'later stages not run yet');
  env.ctx.CC_scheduledSync(); // a scheduled run while paused must not restart from scratch
  assert.equal(env.scriptProps.getProperty('cc_sync_stage'), '1');
  env.ctx.CC_resumeSync();
  assert.equal(env.scriptProps.getProperty('cc_sync_stage'), null);
  assert.ok(!env.triggers.includes('CC_resumeSync'), 'one-off trigger removed');
  const a = pan(env, 'AAAPA1111A');
  assert.equal(a['g.>151'], 52000);
  assert.equal(a['Associate Remarks'], 'remark during a long sync');
  const log = table(env.ss, 'Sync Log');
  assert.match(log[log.length - 2].Result, /PAUSED/);
  assert.equal(log[log.length - 1].Result, 'OK');
});

test('invoice copy runs in batches and resumes where it stopped', () => {
  const env = fresh();
  env.live.getSheetByName('Imported_Data').data[4][15] = 53000;
  env.ctx.CC_INV_BATCH = 3; // 10 invoices -> 4 batches
  const r = env.ctx.ccSync_({ budgetMs: 44000 }); // deadline passes right after the first batch
  assert.equal(r.pending, true);
  assert.match(table(env.ss, 'Sync Log').pop().Result, /PAUSED while copying invoices \(3\/10\)/);
  assert.equal(JSON.parse(env.scriptProps.getProperty('cc_inv_progress')).next, 3);
  env.ctx.CC_resumeSync(); // normal budget: finishes the rest and all later stages
  assert.equal(env.scriptProps.getProperty('cc_inv_progress'), null);
  assert.equal(table(env.ss, 'Invoices').length, 10);
  assert.equal(pan(env, 'AAAPA1111A')['g.>151'], 53000);
  assert.equal(table(env.ss, 'Sync Log').pop().Result, 'OK');
});
