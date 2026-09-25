/*
 * Tests for src/Code.gs against the synthetic workbook in synthetic-fixture.js.
 *
 * Run:  TZ=Asia/Kolkata node --test test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, assertSerializable } = require('./gas-mock');

const TZ_OK = process.env.TZ === 'Asia/Kolkata';
const { buildFixture, key, day, TODAY } = require('./synthetic-fixture');

function fresh() {
  const env = load(buildFixture());
  env.ss.setActive('Asha', 3, 2);
  return env;
}
// Round-trip through JSON like google.script.run does (also avoids cross-realm arrays from the vm sandbox).
const call = (env, fn, ...args) => { const r = env.ctx[fn](...args); assertSerializable(r, fn); return JSON.parse(JSON.stringify(r)); };
function ptpRow(env, inv) {
  const sh = env.ss.getSheetByName('PTP Tracker');
  const hdr = sh.data[0];
  const r = sh.data.find((row) => row[0] === inv);
  if (!r) return null;
  const o = {};
  hdr.forEach((h, i) => { o[h] = r[i]; });
  return o;
}
function dailyCell(env, sheet, pan) {
  const sh = env.ss.getSheetByName(sheet);
  const col = sh.data[1].findIndex((v) => v instanceof Date && key(v) === TODAY);
  const row = sh.data.find((r) => r[0] === pan);
  return row[col];
}
function remarkCell(env, sheet, pan) {
  const sh = env.ss.getSheetByName(sheet);
  const col = sh.data[1].findIndex((v) => v === 'Associate Remarks' || v === 'Remarks');
  return sh.data.find((r) => r[0] === pan)[col];
}

test('runs in the spreadsheet time zone', () => {
  assert.ok(TZ_OK, 'run with TZ=Asia/Kolkata');
});

test('wbInit finds associate tabs and picks the active one', () => {
  const env = fresh();
  const init = call(env, 'wbInit');
  assert.deepEqual(init.associates, ['Asha', 'Ravi']);
  assert.equal(init.me, 'Asha');
  assert.equal(init.today, TODAY);
  env.ss.setActive('Summary', 1, 1);
  env.ctx.wbSetMe('Ravi');
  assert.equal(call(env, 'wbInit').me, 'Ravi');
});

test('wbGetBook returns every PAN with follow-up history and PTP roll-up', () => {
  const env = fresh();
  const book = call(env, 'wbGetBook', 'Asha');
  assert.equal(book.rows.length, 4);
  const a = book.rows.find((r) => r.pan === 'AAAPA1111A');
  assert.equal(a.total, 75000);
  assert.equal(a.overdue, 70000);
  assert.equal(a.gt60, 50000);
  assert.equal(a.lastTouch, key(day(-1)));
  assert.equal(a.daysSince, 1);
  assert.equal(a.recent.length, 7);
  assert.equal(a.recent[1], 'PTP');
  assert.equal(a.daily, undefined, 'daily map is stripped from the payload');
  const b = book.rows.find((r) => r.pan === 'BBBPB2222B');
  assert.equal(b.daysSince, 10);
  assert.equal(b.ptpBroken, 1, 'INV-B1 PTP was 2 days ago and is unpaid (PAN resolved via invoice for legacy rows)');
  assert.equal(b.netPayable, 25000);
  assert.equal(b.possibleArAp, 25000);
  const e = book.rows.find((r) => r.pan === 'EEEPE5555E');
  assert.equal(e.daysSince, null);
});

test('wbGetSelection resolves the PAN from associate tab, Consolidated and PTP Tracker', () => {
  const env = fresh();
  env.ss.setActive('Asha', 4, 30);
  assert.equal(call(env, 'wbGetSelection').pan, 'BBBPB2222B');
  env.ss.setActive('Asha', 2, 1);
  assert.equal(call(env, 'wbGetSelection').pan, '', 'header row is ignored');
  env.ss.setActive('Consolidated', 7, 2);
  assert.equal(call(env, 'wbGetSelection').pan, 'DDDPD4444D');
  env.ss.setActive('PTP Tracker', 4, 5);
  assert.equal(call(env, 'wbGetSelection').pan, 'BBBPB2222B', 'legacy PTP rows map invoice -> PAN');
});

test('wbGetPan drills down to invoices that reconcile with the PAN total', () => {
  const env = fresh();
  const d = call(env, 'wbGetPan', 'Asha', 'AAAPA1111A');
  assert.equal(d.owner, 'Asha');
  assert.equal(d.customer, 'Alpha Foods Pvt Ltd');
  assert.deepEqual(d.invoices.map((i) => i.inv), ['INV-A1', 'INV-A2', 'INV-A3'], 'oldest first');
  assert.equal(d.invoices.reduce((s, i) => s + i.net, 0), d.header.total);
  assert.equal(d.invoices[0].bucket, 'g.>151');
  assert.equal(d.invoices[0].overdue, true);
  assert.equal(d.invoices[2].overdue, false, 'not-due invoice');
  assert.equal(d.invoices[0].ptpStatus, 'PTP Pending');
  assert.deepEqual(d.paid.map((p) => p.inv), ['INV-A0']);
  assert.equal(d.header.recentDates.length, 14);
});

test('wbGetPan on another associate\'s PAN finds the owner', () => {
  const env = fresh();
  const d = call(env, 'wbGetPan', 'Asha', 'DDDPD4444D');
  assert.equal(d.owner, 'Ravi');
  assert.equal(d.header.remarks, 'old remark', 'reads the "Remarks" header alias');
  assert.equal(d.invoices.length, 2);
});

test('wbSavePtp updates existing tracker rows, appends new ones and marks the day', () => {
  const env = fresh();
  const ptpDate = key(day(3));
  const r = call(env, 'wbSavePtp', {
    assoc: 'Asha', pan: 'AAAPA1111A', customer: 'Alpha Foods Pvt Ltd', invoices: ['INV-A1', 'INV-A3'],
    ptpDate, amounts: { 'INV-A1': 30000 }, mode: 'NEFT / RTGS', contact: 'Mr. Rao', remarks: 'Finance approved'
  });
  assert.equal(r.count, 2);
  assert.equal(r.amount, 35000);
  const a1 = ptpRow(env, 'INV-A1');
  assert.equal(key(a1['PTP Date']), ptpDate);
  assert.equal(a1['PTP Amount'], 30000);
  assert.equal(a1.Status, 'PTP Given');
  assert.equal(a1['Contact Person'], 'Mr. Rao');
  assert.equal(a1.PAN, 'AAAPA1111A');
  const a3 = ptpRow(env, 'INV-A3');
  assert.ok(a3, 'INV-A3 was not in the tracker and gets appended');
  assert.equal(a3.Associate, 'Asha');
  assert.equal(a3['Outstanding When Added'], 5000);
  assert.equal(a3['PTP Amount'], 5000, 'defaults to the outstanding amount');
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), 'PTP');
  assert.match(remarkCell(env, 'Asha', 'AAAPA1111A'), /PTP .* for 2 inv .*Finance approved/);
  const log = env.ss.getSheetByName('WB Activity Log').data;
  assert.equal(log.length, 2);
  assert.equal(log[1][5], 'PTP');
  // shows up everywhere
  const book = call(env, 'wbGetBook', 'Asha');
  const a = book.rows.find((x) => x.pan === 'AAAPA1111A');
  assert.equal(a.ptpOpen, 2);
  assert.equal(a.ptpNext, ptpDate);
  assert.equal(a.today, 'PTP');
  const d = call(env, 'wbGetPan', 'Asha', 'AAAPA1111A');
  assert.equal(d.invoices.find((i) => i.inv === 'INV-A1').ptpDate, ptpDate);
  assert.equal(d.history[0].type, 'PTP');
});

test('wbSavePtp validates input', () => {
  const env = fresh();
  assert.throws(() => env.ctx.wbSavePtp({ assoc: 'Asha', pan: 'AAAPA1111A', invoices: [], ptpDate: TODAY }), /at least one/);
  assert.throws(() => env.ctx.wbSavePtp({ assoc: 'Asha', pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: '' }), /PTP date/);
});

test('wbLogFollowUp logs, sets remark + next follow-up, and never downgrades PTP to Yes', () => {
  const env = fresh();
  call(env, 'wbSavePtp', { assoc: 'Asha', pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(2)) });
  call(env, 'wbLogFollowUp', {
    assoc: 'Asha', pan: 'AAAPA1111A', customer: 'Alpha', channel: 'Call', outcome: 'Callback requested',
    remarks: 'CFO travelling', nextDate: key(day(1)), daily: 'Yes'
  });
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), 'PTP');
  assert.match(remarkCell(env, 'Asha', 'AAAPA1111A'), /Callback requested - CFO travelling \| next f\/u/);
  call(env, 'wbLogFollowUp', { assoc: 'Asha', pan: 'BBBPB2222B', channel: 'WhatsApp', outcome: 'Other', nextDate: TODAY });
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), 'Yes');
  const book = call(env, 'wbGetBook', 'Asha');
  assert.equal(book.rows.find((r) => r.pan === 'AAAPA1111A').nextFollowUp, key(day(1)));
  assert.equal(book.rows.find((r) => r.pan === 'BBBPB2222B').nextFollowUp, TODAY);
});

test('wbTagInvoices tags invoices and can clear a PTP', () => {
  const env = fresh();
  call(env, 'wbTagInvoices', { assoc: 'Asha', pan: 'BBBPB2222B', invoices: ['INV-B1'], tag: 'Disputed', remarks: 'short supply' });
  assert.equal(ptpRow(env, 'INV-B1')['Invoice Tag'], 'Disputed');
  call(env, 'wbTagInvoices', { assoc: 'Asha', pan: 'BBBPB2222B', invoices: ['INV-B1'], clearPtp: true });
  const r = ptpRow(env, 'INV-B1');
  assert.equal(r['PTP Date'], '');
  assert.equal(r.Status, 'PTP Pending');
  assert.equal(r['Invoice Tag'], 'Disputed', 'clearing the PTP keeps the tag');
  call(env, 'wbTagInvoices', { assoc: 'Asha', pan: 'BBBPB2222B', invoices: ['INV-B1'], tag: 'Expected Payment' });
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), 'Expected Payment');
});

test('wbBulkDaily marks many PANs and rejects values outside the sheet validation list', () => {
  const env = fresh();
  const r = call(env, 'wbBulkDaily', 'Asha', ['BBBPB2222B', 'CCCPC3333C'], 'Leave');
  assert.equal(r.count, 2);
  assert.equal(dailyCell(env, 'Asha', 'CCCPC3333C'), 'Leave');
  assert.throws(() => env.ctx.wbBulkDaily('Asha', ['BBBPB2222B'], 'Maybe'), /Invalid status/);
});

test('wbCreateEmailDraft builds a statement and counts as a follow-up', () => {
  const env = fresh();
  const r = call(env, 'wbCreateEmailDraft', { assoc: 'Asha', pan: 'AAAPA1111A', invoices: ['INV-A1', 'INV-A2'], to: 'ap@alpha.test', contact: 'Priya' });
  assert.equal(r.count, 2);
  assert.equal(r.total, 70000);
  assert.equal(env.drafts.length, 1);
  assert.match(env.drafts[0].o.htmlBody, /INV-A1/);
  assert.match(env.drafts[0].o.htmlBody, /₹70,000/);
  assert.match(env.drafts[0].o.htmlBody, /Dear Priya/);
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), 'Yes');
  const log = env.ss.getSheetByName('WB Activity Log').data;
  assert.equal(log[1][5], 'Email');
});

test('WB_refreshPtpStatuses computes live statuses and converts free-text dates', () => {
  const env = fresh();
  env.ctx.WB_refreshPtpStatuses();
  const a2 = ptpRow(env, 'INV-A2');
  assert.equal(key(a2['PTP Date']), TODAY, '"25th sep"-style status becomes a real PTP date');
  assert.equal(a2.Status, 'PTP Due Today');
  assert.equal(a2.PAN, 'AAAPA1111A');
  assert.match(a2['PTP Remarks'], /th /, 'the free text is kept in PTP Remarks');
  assert.equal(a2['Days vs PTP'], 0);
  const b1 = ptpRow(env, 'INV-B1');
  assert.equal(b1.Status, 'PTP Broken');
  assert.equal(b1['Days vs PTP'], 2);
  const b2 = ptpRow(env, 'INV-B2');
  assert.equal(b2['Current Outstanding'], 0);
  assert.equal(key(b2['Settlement Date']), key(day(-1)));
  assert.equal(b2.Status, 'Paid (PTP Kept)');
  assert.equal(ptpRow(env, 'INV-A1').Status, 'PTP Pending');
  assert.equal(b2['Days vs PTP'], -1, 'paid a day before the promise');
});

test('future PTPs leave "Days vs PTP" blank and custom statuses survive in remarks', () => {
  const env = fresh();
  const sh = env.ss.getSheetByName('PTP Tracker');
  sh.data.find((r) => r[0] === 'INV-D1')[11] = 'Ar-ap recvd';
  call(env, 'wbSavePtp', { assoc: 'Asha', pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(5)) });
  env.ctx.WB_refreshPtpStatuses();
  assert.equal(ptpRow(env, 'INV-A1')['Days vs PTP'], '');
  assert.equal(ptpRow(env, 'INV-A1').Status, 'PTP Given');
  assert.equal(ptpRow(env, 'INV-D1').Status, 'Ar-ap recvd', 'unknown status without a PTP date is left alone');
  const inv = env.ss.getSheetByName('Imported_Data').data.find((r) => r[6] === 'INV-D1');
  inv[15] = 0; // paid
  env.ctx.WB_refreshPtpStatuses();
  assert.equal(ptpRow(env, 'INV-D1').Status, 'Paid');
  assert.equal(ptpRow(env, 'INV-D1')['PTP Remarks'], 'Ar-ap recvd');
});

test('WB_dailyMaintenance adds new overdue invoices and auto-marks "Invoice Not Due"', () => {
  const env = fresh();
  env.ctx.WB_dailyMaintenance();
  assert.ok(ptpRow(env, 'INV-D2'), 'overdue invoice missing from tracker is added');
  assert.equal(ptpRow(env, 'INV-D2').Associate, 'Ravi');
  assert.equal(ptpRow(env, 'INV-C1'), null, 'not-due invoices are not added');
  assert.equal(dailyCell(env, 'Asha', 'CCCPC3333C'), 'Invoice Not Due');
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), '', 'overdue PANs are left for the associate');
  assert.equal(dailyCell(env, 'Ravi', 'DDDPD4444D'), 'Yes', 'existing entries are untouched');
  const before = env.ss.getSheetByName('PTP Tracker').getLastRow();
  env.ctx.WB_dailyMaintenance();
  assert.equal(env.ss.getSheetByName('PTP Tracker').getLastRow(), before, 'idempotent');
});

test('wbGetPtps and wbGetProductivity roll up correctly', () => {
  const env = fresh();
  env.ctx.WB_refreshPtpStatuses();
  call(env, 'wbSavePtp', { assoc: 'Asha', pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(4)) });
  const ptps = call(env, 'wbGetPtps', 'Asha');
  const live = Object.fromEntries(ptps.rows.map((p) => [p.invoice, p.live]));
  assert.equal(live['INV-A1'], 'PTP Given');
  assert.equal(live['INV-B1'], 'PTP Broken');
  assert.equal(live['INV-B2'], 'Paid (PTP Kept)');
  const prod = call(env, 'wbGetProductivity', 'Asha');
  assert.equal(prod.mine.active, 3, 'zero-balance PAN excluded');
  assert.equal(prod.mine.touchedToday, 1);
  assert.equal(prod.ptp.kept, 1);
  assert.equal(prod.ptp.broken, 1);
  assert.equal(prod.ptp.keptRate, 0.5);
  assert.equal(prod.acts.today.PTP, 1);
  assert.deepEqual(prod.team.map((t) => t.assoc).sort(), ['Asha', 'Ravi']);
  assert.ok(prod.mine.trend.length > 10);
});

test('WB_setup is idempotent and adds the extra PTP columns once', () => {
  const env = fresh();
  env.ctx.WB_setup();
  env.ctx.WB_setup();
  assert.deepEqual(env.triggers.sort(), ['WB_dailyMaintenance', 'WB_onOpen', 'WB_refreshPtpStatuses']);
  const hdr = env.ss.getSheetByName('PTP Tracker').data[0].filter(Boolean);
  assert.equal(hdr.length, 12 + 8);
  assert.equal(hdr[12], 'PAN');
  assert.ok(env.ss.getSheetByName('WB Activity Log'));
});

test('open-invoice cache is reused and rebuilt when Imported_Data grows', () => {
  const env = fresh();
  const first = env.ctx.wbOpenInvoices_(false);
  assert.equal(first.count, 7);
  const again = env.ctx.wbOpenInvoices_(false);
  assert.equal(again.builtAt, first.builtAt, 'served from cache');
  const inv = env.ss.getSheetByName('Imported_Data');
  const row = inv.data[5].slice();
  row[6] = 'INV-NEW'; row[15] = 1234;
  inv.data.push(row);
  const rebuilt = env.ctx.wbOpenInvoices_(false);
  assert.equal(rebuilt.count, 8);
  assert.ok(rebuilt.byInv['INV-NEW']);
});

test('wbGoToRow selects the PAN row in the owner tab', () => {
  const env = fresh();
  assert.equal(call(env, 'wbGoToRow', 'Ravi', 'DDDPD4444D'), true);
  const sel = call(env, 'wbGetSelection');
  assert.equal(sel.sheet, 'Ravi');
  assert.equal(sel.pan, 'DDDPD4444D');
  assert.equal(call(env, 'wbGoToRow', 'Ravi', 'NOPE000000'), false);
});
