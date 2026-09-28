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

function fresh(opts) {
  const env = load(buildFixture(), Object.assign({ email: 'asha@example.com' }, opts || {}));
  env.ss.setActive('Asha', 3, 2);
  return env;
}
// Each call is a fresh execution (like google.script.run) and round-trips through JSON.
const call = (env, fn, ...args) => { const r = env.run(fn, ...args); assertSerializable(r, fn); return JSON.parse(JSON.stringify(r === undefined ? null : r)); };
/** WB Settings roster: Asha + Ravi in Tara's team, Maya in management. */
function withRoles(env) {
  env.run('WB_setup');
  const sh = env.ss.getSheetByName('WB Settings');
  const rows = [['Asha', 'Associate', 'Tara', 'asha@example.com', 'Yes'], ['Ravi', 'Associate', 'Tara', 'ravi@example.com', 'Yes'],
    ['Tara', 'Team Lead', '', 'tara@example.com', 'Yes'], ['Maya', 'Management', '', 'maya@example.com', 'Yes']];
  rows.forEach((r, i) => r.forEach((v, j) => sh.set(4 + i, 1 + j, v)));
  return env;
}
function setSetting(env, k, v) {
  const sh = env.ss.getSheetByName('WB Settings') || (env.run('WB_setup'), env.ss.getSheetByName('WB Settings'));
  const i = sh.data.findIndex((r) => r[6] === k);
  sh.set(i + 1, 8, v);
}
function ptpRow(env, inv) {
  const sh = env.ss.getSheetByName('PTP Tracker');
  const hdr = sh.data[0];
  const r = sh.data.find((row) => row[0] === inv);
  if (!r) return null;
  const o = {};
  hdr.forEach((h, i) => { o[h] = r[i]; });
  return o;
}
function tabCell(env, sheet, pan, header) {
  const sh = env.ss.getSheetByName(sheet);
  const col = typeof header === 'string' ? sh.data[1].indexOf(header) : sh.data[1].findIndex((v) => v instanceof Date && key(v) === TODAY);
  const row = sh.data.find((r) => r[0] === pan);
  return row ? row[col] : undefined;
}
const dailyCell = (env, sheet, pan) => tabCell(env, sheet, pan, null);
const remarkCell = (env, sheet, pan) => tabCell(env, sheet, pan, sheet === 'Ravi' ? 'Remarks' : 'Associate Remarks');
function ioRow(env, pan) {
  const sh = env.ss.getSheetByName('IO Sign Off Rate Card');
  const hdr = sh.data[0];
  const r = sh.data.find((row) => row[0] === pan);
  const o = {};
  hdr.forEach((h, i) => { if (h) o[h] = r[i]; });
  return o;
}

test('runs in the spreadsheet time zone', () => {
  assert.ok(TZ_OK, 'run with TZ=Asia/Kolkata');
});

// ---------------------------------------------------------------------------
// Identity, roles, scopes
// ---------------------------------------------------------------------------

test('wbInit: set-up mode gives everyone every view until roles are filled in', () => {
  const env = fresh({ email: '' });
  const init = call(env, 'wbInit');
  assert.deepEqual(init.associates, ['Asha', 'Ravi']);
  assert.equal(init.me, 'Asha', 'picked from the active tab');
  assert.equal(init.role, 'Admin');
  assert.equal(init.rolesConfigured, false);
  assert.equal(init.today, TODAY);
  env.ss.setActive('Summary', 1, 1);
  env.run('wbSetMe', 'Ravi');
  assert.equal(call(env, 'wbInit').me, 'Ravi', 'remembered choice when not on an associate tab');
});

test('wbInit: roles and team come from WB Settings by e-mail', () => {
  const env = withRoles(fresh());
  env.ss.setActive('Summary', 1, 1);
  let init = call(env, 'wbInit');
  assert.equal(init.role, 'Associate');
  assert.equal(init.me, 'Asha');
  assert.equal(init.identified, true);
  env.setEmail('tara@example.com');
  init = call(env, 'wbInit');
  assert.equal(init.role, 'Team Lead');
  assert.equal(init.me, 'Tara');
  assert.deepEqual(init.myTeam, ['Asha', 'Ravi']);
  assert.deepEqual(init.teamLeads, ['Tara']);
  env.setEmail('maya@example.com');
  assert.equal(call(env, 'wbInit').role, 'Management');
});

test('RESTRICT_VIEWS keeps associates to their own book', () => {
  const env = withRoles(fresh());
  setSetting(env, 'RESTRICT_VIEWS', 'Yes');
  assert.throws(() => env.run('wbGetBook', { assoc: 'Ravi' }), /only open your own/);
  assert.throws(() => env.run('wbGetPan', 'DDDPD4444D'), /only open your own/);
  assert.equal(call(env, 'wbGetBook', { assoc: 'Asha' }).rows.length, 4);
  env.setEmail('tara@example.com');
  assert.equal(call(env, 'wbGetBook', { teamLead: 'Tara' }).names.length, 2, 'team lead sees the team');
});

// ---------------------------------------------------------------------------
// Book, selection, PAN detail, search
// ---------------------------------------------------------------------------

test('wbGetBook returns every PAN with follow-up history, PTP roll-up and IO status', () => {
  const env = fresh();
  const book = call(env, 'wbGetBook', { assoc: 'Asha' });
  assert.equal(book.rows.length, 4, 'formula rows without a PAN are skipped');
  assert.equal(book.live, true);
  const a = book.rows.find((r) => r.pan === 'AAAPA1111A');
  assert.equal(a.total, 75000);
  assert.equal(a.overdue, 70000);
  assert.equal(a.gt60, 50000);
  assert.equal(a.lastTouch, key(day(-1)));
  assert.equal(a.daysSince, 1);
  assert.equal(a.recent.length, 7);
  assert.equal(a.recent[1], 'PTP');
  assert.equal(a.io, 'Pending');
  assert.equal(a.ioRate, 500);
  assert.equal(a.daily, undefined, 'daily map is not sent');
  const b = book.rows.find((r) => r.pan === 'BBBPB2222B');
  assert.equal(b.daysSince, 10);
  assert.equal(b.stale, true, 'overdue and not followed up for 3+ working days');
  assert.equal(b.ptpBroken, 1, 'INV-B1 PTP was 2 days ago and is unpaid (PAN resolved via invoice for legacy rows)');
  assert.equal(b.netPayable, 25000);
  assert.equal(b.possibleArAp, 25000);
  assert.equal(b.io, 'Signed');
  assert.equal(book.rows.find((r) => r.pan === 'EEEPE5555E').daysSince, null);
  assert.equal(book.rows.find((r) => r.pan === 'CCCPC3333C').stale, false, 'nothing overdue: never stale');
});

test('wbGetBook for several associates leaves out zero-balance PANs and tags the owner', () => {
  const env = fresh();
  const book = call(env, 'wbGetBook', { all: true });
  assert.deepEqual(book.names, ['Asha', 'Ravi']);
  assert.equal(book.rows.length, 4);
  assert.equal(book.zeroRows, 1);
  assert.equal(book.rows.find((r) => r.pan === 'DDDPD4444D').owner, 'Ravi');
});

test('wbGetSelection resolves the PAN from every tab the associate may click in', () => {
  const env = fresh();
  env.ss.setActive('Asha', 4, 30);
  assert.equal(call(env, 'wbGetSelection').pan, 'BBBPB2222B');
  env.ss.setActive('Asha', 2, 1);
  assert.equal(call(env, 'wbGetSelection').pan, '', 'header row is ignored');
  env.ss.setActive('Asha', 7, 1);
  assert.equal(call(env, 'wbGetSelection').pan, '', 'empty formula row is ignored');
  env.ss.setActive('Consolidated', 7, 2);
  assert.equal(call(env, 'wbGetSelection').pan, 'DDDPD4444D');
  env.ss.setActive('PTP Tracker', 4, 5);
  assert.equal(call(env, 'wbGetSelection').pan, 'BBBPB2222B', 'legacy PTP rows map invoice -> PAN');
  env.ss.setActive('IO Sign Off Rate Card', 2, 3);
  assert.equal(call(env, 'wbGetSelection').pan, 'AAAPA1111A');
  env.ss.setActive('Payable Data - Daily', 4, 13);
  assert.equal(call(env, 'wbGetSelection').pan, 'CCCPC3333C', 'vendor block resolves through its PAN Number column');
});

test('wbGetPan drills down to invoices, IO, payables and history', () => {
  const env = fresh();
  const d = call(env, 'wbGetPan', 'AAAPA1111A');
  assert.equal(d.owner, 'Asha');
  assert.equal(d.customer, 'Alpha Foods Pvt Ltd');
  assert.deepEqual(d.invoices.map((i) => i.inv), ['INV-A1', 'INV-A2', 'INV-A3'], 'oldest first');
  assert.equal(d.invoices.reduce((s, i) => s + i.net, 0), d.header.total);
  assert.equal(d.invoices[0].bucket, 'g.>151');
  assert.equal(d.invoices[0].overdue, true);
  assert.equal(d.invoices[2].overdue, false, 'not-due invoice');
  assert.equal(d.invoices[0].ptpStatus, 'PTP Pending');
  assert.equal(d.paid, null, 'settled invoices load only when their section is opened');
  assert.deepEqual(call(env, 'wbGetPaid', 'AAAPA1111A').paid.map((p) => p.inv), ['INV-A0']);
  assert.equal(d.header.daily14.length, 14);
  assert.equal(d.io.rate, 500);
  assert.equal(d.io.done, false);
  assert.equal(d.io.remarks, 'Sent to brand');
  assert.deepEqual(d.kams, ['kam.one']);
  const b = call(env, 'wbGetPan', 'BBBPB2222B');
  assert.equal(b.payables.net, 25000);
  assert.deepEqual(b.payables.vendors.map((v) => v.code), ['KK-2', 'KK-1'], 'largest payable first');
  assert.equal(b.io.done, true);
});

test('wbGetPan finds the owner of another associate\'s PAN and handles unassigned PANs', () => {
  const env = fresh();
  const d = call(env, 'wbGetPan', 'DDDPD4444D');
  assert.equal(d.owner, 'Ravi');
  assert.equal(d.header.remarks, 'old remark', 'reads the "Remarks" header alias');
  assert.equal(d.invoices.length, 2);
  const f = call(env, 'wbGetPan', 'FFFPF6666F');
  assert.equal(f.owner, '');
  assert.equal(f.header, null);
  assert.equal(f.customer, 'Foxtrot Foods');
  assert.equal(f.invoices.length, 1);
});

test('wbSearch finds PANs by customer, brand, PAN and invoice number', () => {
  const env = fresh();
  assert.equal(call(env, 'wbSearch', 'beta').results[0].pan, 'BBBPB2222B');
  assert.equal(call(env, 'wbSearch', 'INV-D2').results[0].pan, 'DDDPD4444D');
  assert.equal(call(env, 'wbSearch', 'fffpf6666f').results[0].owner, '', 'unassigned PAN is found');
  const settled = call(env, 'wbSearch', 'INV-A0').results;
  assert.equal(settled[0].pan, 'AAAPA1111A', 'settled invoices are found too');
  assert.equal(call(env, 'wbSearch', 'x').results.length, 0);
});

// ---------------------------------------------------------------------------
// PTPs
// ---------------------------------------------------------------------------

test('wbSavePtp updates existing tracker rows, appends new ones and marks the day', () => {
  const env = fresh();
  const ptpDate = key(day(3));
  const r = call(env, 'wbSavePtp', {
    pan: 'AAAPA1111A', customer: 'Alpha Foods Pvt Ltd', invoices: ['INV-A1', 'INV-A3'],
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
  const a = call(env, 'wbGetBook', { assoc: 'Asha' }).rows.find((x) => x.pan === 'AAAPA1111A');
  assert.equal(a.ptpOpen, 2);
  assert.equal(a.ptpNext, ptpDate);
  assert.equal(a.today, 'PTP');
  const d = call(env, 'wbGetPan', 'AAAPA1111A');
  assert.equal(d.invoices.find((i) => i.inv === 'INV-A1').ptpDate, ptpDate);
  assert.equal(d.invoices.find((i) => i.inv === 'INV-A1').ptpStatus, 'PTP Given');
  assert.equal(d.history[0].type, 'PTP');
});

test('wbSavePtp takes a different date per invoice (inline PTP) without touching the remark', () => {
  const env = fresh();
  const r = call(env, 'wbSavePtp', {
    pan: 'AAAPA1111A', invoices: ['INV-A1', 'INV-A2'], dates: { 'INV-A1': key(day(5)), 'INV-A2': key(day(2)) }, updateRemark: false
  });
  assert.equal(r.date, key(day(2)), 'earliest promise is reported');
  assert.equal(key(ptpRow(env, 'INV-A1')['PTP Date']), key(day(5)));
  assert.equal(key(ptpRow(env, 'INV-A2')['PTP Date']), key(day(2)));
  assert.equal(ptpRow(env, 'INV-A1')['Contact Person'], '', 'contact untouched when not given');
  assert.equal(remarkCell(env, 'Asha', 'AAAPA1111A'), 'old remark');
  assert.match(env.ss.getSheetByName('WB Activity Log').data[1][6], /^PTP from /);
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), 'PTP');
});

test('wbSavePtp validates input', () => {
  const env = fresh();
  assert.throws(() => env.run('wbSavePtp', { pan: 'AAAPA1111A', invoices: [], ptpDate: TODAY }), /at least one/);
  assert.throws(() => env.run('wbSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: '' }), /PTP date/);
  assert.throws(() => env.run('wbSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1'], dates: { 'INV-A1': '30/09' } }), /PTP date/);
});

test('wbTagInvoices tags invoices and can clear a PTP', () => {
  const env = fresh();
  call(env, 'wbTagInvoices', { pan: 'BBBPB2222B', invoices: ['INV-B1'], tag: 'Disputed', remarks: 'short supply' });
  assert.equal(ptpRow(env, 'INV-B1')['Invoice Tag'], 'Disputed');
  call(env, 'wbTagInvoices', { pan: 'BBBPB2222B', invoices: ['INV-B1'], clearPtp: true });
  const r = ptpRow(env, 'INV-B1');
  assert.equal(r['PTP Date'], '');
  assert.equal(r.Status, 'PTP Pending');
  assert.equal(r['Invoice Tag'], 'Disputed', 'clearing the PTP keeps the tag');
  call(env, 'wbTagInvoices', { pan: 'BBBPB2222B', invoices: ['INV-B1'], tag: 'Expected Payment' });
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), 'Expected Payment');
});

test('WB_refreshPtpStatuses computes live statuses and converts free-text dates', () => {
  const env = fresh();
  env.run('WB_refreshPtpStatuses');
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
  call(env, 'wbSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(5)) });
  env.run('WB_refreshPtpStatuses');
  assert.equal(ptpRow(env, 'INV-A1')['Days vs PTP'], '');
  assert.equal(ptpRow(env, 'INV-A1').Status, 'PTP Given');
  assert.equal(ptpRow(env, 'INV-D1').Status, 'Ar-ap recvd', 'unknown status without a PTP date is left alone');
  const inv = env.ss.getSheetByName('Imported_Data').data.find((r) => r[6] === 'INV-D1');
  inv[15] = 0; // paid
  env.run('WB_refreshPtpStatuses');
  assert.equal(ptpRow(env, 'INV-D1').Status, 'Paid');
  assert.equal(ptpRow(env, 'INV-D1')['PTP Remarks'], 'Ar-ap recvd');
});

// ---------------------------------------------------------------------------
// Follow-ups, remarks, confidence, IO, reassign, mail
// ---------------------------------------------------------------------------

test('wbLogFollowUp logs, sets remark + next follow-up, and never downgrades PTP to Yes', () => {
  const env = fresh();
  call(env, 'wbSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(2)) });
  call(env, 'wbLogFollowUp', {
    pan: 'AAAPA1111A', customer: 'Alpha', channel: 'Call', outcome: 'Callback requested',
    remarks: 'CFO travelling', nextDate: key(day(1)), daily: 'Yes'
  });
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), 'PTP');
  assert.match(remarkCell(env, 'Asha', 'AAAPA1111A'), /Callback requested - CFO travelling \| next f\/u/);
  call(env, 'wbLogFollowUp', { pan: 'BBBPB2222B', channel: 'WhatsApp', outcome: 'Other', nextDate: TODAY });
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), 'Yes');
  const book = call(env, 'wbGetBook', { assoc: 'Asha' });
  assert.equal(book.rows.find((r) => r.pan === 'AAAPA1111A').nextFollowUp, key(day(1)));
  assert.equal(book.rows.find((r) => r.pan === 'BBBPB2222B').nextFollowUp, TODAY);
});

test('wbBulkDaily marks PANs across tabs and rejects values outside the sheet validation list', () => {
  const env = fresh();
  const r = call(env, 'wbBulkDaily', ['BBBPB2222B', 'CCCPC3333C', 'DDDPD4444D'], 'Leave');
  assert.equal(r.count, 3);
  assert.equal(dailyCell(env, 'Asha', 'CCCPC3333C'), 'Leave');
  assert.equal(dailyCell(env, 'Ravi', 'DDDPD4444D'), 'Leave');
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), '', 'other rows untouched');
  assert.throws(() => env.run('wbBulkDaily', ['BBBPB2222B'], 'Maybe'), /Invalid status/);
});

test('wbSaveRemark writes the remark; team lead remarks need a team lead', () => {
  const env = withRoles(fresh());
  call(env, 'wbSaveRemark', 'BBBPB2222B', 'Mail sent to AP', 'remarks');
  assert.equal(remarkCell(env, 'Asha', 'BBBPB2222B'), 'Mail sent to AP');
  assert.throws(() => env.run('wbSaveRemark', 'BBBPB2222B', 'Call today', 'tlRemarks'), /team leads/);
  env.setEmail('tara@example.com');
  call(env, 'wbSaveRemark', 'BBBPB2222B', 'Call today', 'tlRemarks');
  assert.equal(tabCell(env, 'Asha', 'BBBPB2222B', 'Team Lead Remarks'), 'Call today');
  assert.equal(call(env, 'wbGetPan', 'BBBPB2222B').history[0].type, 'TL review');
});

test('wbSetConfidence writes Red / Yellow / Green and POE to the tab', () => {
  const env = fresh();
  call(env, 'wbSetConfidence', 'AAAPA1111A', { red: 50000, yellow: '', green: 20000 }, 'Yes');
  assert.equal(tabCell(env, 'Asha', 'AAAPA1111A', 'Red'), 50000);
  assert.equal(tabCell(env, 'Asha', 'AAAPA1111A', 'Yellow'), '');
  assert.equal(tabCell(env, 'Asha', 'AAAPA1111A', 'Green'), 20000);
  assert.equal(tabCell(env, 'Asha', 'AAAPA1111A', 'POE Required ?'), 'Yes');
  const a = call(env, 'wbGetBook', { assoc: 'Asha' }).rows.find((r) => r.pan === 'AAAPA1111A');
  assert.equal(a.confidence, 'Red');
});

test('wbSaveIo records the sign-off on the rate card without touching its summary block', () => {
  const env = fresh();
  assert.throws(() => env.run('wbSaveIo', { pan: 'AAAPA1111A', signed: true, link: '' }), /link/);
  call(env, 'wbSaveIo', { pan: 'AAAPA1111A', signed: true, link: 'https://drive.example/io-alpha', pdf: 'https://drive.example/pdf', remarks: 'Signed by CFO', signedOn: key(day(-1)) });
  const r = ioRow(env, 'AAAPA1111A');
  assert.equal(r['IO Sign off Link'], 'https://drive.example/io-alpha');
  assert.equal(r['IO Signed Brand PDF'], 'https://drive.example/pdf');
  assert.equal(r.Remarks, 'Signed by CFO');
  assert.equal(key(r['IO Signed On']), key(day(-1)));
  assert.match(r['IO Updated By'], /asha@example.com/);
  const sh = env.ss.getSheetByName('IO Sign Off Rate Card');
  assert.equal(sh.data[0][12], 'IO Signed On', 'new columns go right after the existing headers');
  assert.equal(sh.data[1][18], 'Sign offs Done', 'summary block untouched');
  assert.equal(call(env, 'wbGetBook', { assoc: 'Asha' }).rows.find((x) => x.pan === 'AAAPA1111A').io, 'Signed');
  const io = call(env, 'wbGetIo', { assoc: 'Asha' });
  assert.equal(io.stats.done, 2);
  assert.equal(io.stats.earned, 800);
  assert.equal(io.stats.earnedMonth, key(day(-1)).slice(0, 7) === TODAY.slice(0, 7) ? 500 : 0);
  call(env, 'wbSaveIo', { pan: 'AAAPA1111A', signed: false, remarks: 'Wrong file, re-sent' });
  assert.equal(ioRow(env, 'AAAPA1111A')['IO Sign off Link'], '');
  assert.equal(ioRow(env, 'AAAPA1111A')['IO Signed On'], '');
  call(env, 'wbSaveIo', { pan: 'CCCPC3333C', customer: 'Gamma Snacks', signed: true, link: 'https://drive.example/io-gamma' });
  assert.equal(ioRow(env, 'CCCPC3333C')['IO Sign off Link'], 'https://drive.example/io-gamma', 'PAN not on the card is appended');
});

test('wbReassign moves the PAN into the new owner\'s free formula row with its inputs', () => {
  const env = withRoles(fresh());
  assert.throws(() => env.run('wbReassign', ['CCCPC3333C'], 'Ravi'), /team leads/);
  env.setEmail('tara@example.com');
  call(env, 'wbSaveRemark', 'CCCPC3333C', 'Gamma remark', 'remarks');
  call(env, 'wbSetConfidence', 'CCCPC3333C', { green: 8000 });
  const r = call(env, 'wbReassign', ['CCCPC3333C'], 'Ravi');
  assert.equal(r.count, 1);
  const ravi = env.ss.getSheetByName('Ravi').data;
  assert.equal(ravi[3][0], 'CCCPC3333C', 'first free row after the last PAN');
  assert.equal(ravi[3][ravi[1].indexOf('Remarks')], 'Gamma remark');
  assert.equal(ravi[3][ravi[1].indexOf('Green')], 8000);
  const asha = env.ss.getSheetByName('Asha').data;
  assert.equal(asha[4][0], '', 'old row cleared');
  assert.equal(asha[4][asha[1].indexOf('Associate Remarks')], '');
  assert.ok(asha[4].some((v) => v === 'Invoice Not Due'), 'old daily history stays for the Summary');
  assert.equal(env.ss.getSheetByName('Consolidated').data.find((x) => x[0] === 'CCCPC3333C')[2], 'Ravi');
  assert.equal(call(env, 'wbGetPan', 'CCCPC3333C').owner, 'Ravi');
  // Unassigned PAN: assign straight from the health check
  call(env, 'wbReassign', ['FFFPF6666F'], 'Asha');
  assert.equal(asha[6][0], 'FFFPF6666F');
  assert.ok(env.ss.getSheetByName('Consolidated').data.find((x) => x[0] === 'FFFPF6666F'), 'added to Consolidated');
});

test('wbReassign extends a tab and copies formulas down when its ready formula rows run out', () => {
  const env = withRoles(fresh({ email: 'tara@example.com' }));
  const ravi = env.ss.getSheetByName('Ravi');
  ravi.data.pop(); // no spare formula row left
  ravi.data[2][1] = '=CUSTOMER(A3)'; // stand-in formula in column B of the last PAN row
  call(env, 'wbReassign', ['AAAPA1111A'], 'Ravi');
  assert.equal(ravi.data[3][0], 'AAAPA1111A', 'written below the last PAN');
  assert.equal(ravi.data[3][1], '=CUSTOMER(A3)', 'formulas copied from the row above');
  assert.equal(ravi.data[3][ravi.data[1].indexOf('POE Required ?')], '', 'copied POE value is not carried over');
});

test('wbCreateEmailDraft sends the previewed statement and counts as a follow-up', () => {
  const env = fresh();
  const html = '<p>Dear Priya,</p><table><tr><td>INV-A1</td><td>50,000</td></tr></table>';
  const r = call(env, 'wbCreateEmailDraft', { pan: 'AAAPA1111A', customer: 'Alpha', invoices: ['INV-A1', 'INV-A2'], total: 70000,
    to: 'ap@alpha.test', cc: 'kam.one@company.test', subject: 'Payment reminder', html });
  assert.ok(r.draftId);
  assert.equal(env.drafts.length, 1);
  assert.equal(env.drafts[0].o.htmlBody, html);
  assert.equal(env.drafts[0].o.cc, 'kam.one@company.test');
  assert.equal(dailyCell(env, 'Asha', 'AAAPA1111A'), 'Yes');
  assert.equal(env.ss.getSheetByName('WB Activity Log').data[1][5], 'Email');
  assert.throws(() => env.run('wbCreateEmailDraft', { pan: 'AAAPA1111A' }), /Nothing to send/);
});

test('wbLogCopy logs a copied statement and optionally marks the day', () => {
  const env = fresh();
  call(env, 'wbLogCopy', { pan: 'BBBPB2222B', invoices: ['INV-B1'], total: 30000, markDaily: false });
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), '');
  call(env, 'wbLogCopy', { pan: 'BBBPB2222B', invoices: ['INV-B1'], total: 30000, markDaily: true });
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), 'Yes');
  assert.match(env.ss.getSheetByName('WB Activity Log').data[2][6], /Statement copied/);
});

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

test('WB_dailyMaintenance adds new overdue invoices and auto-marks "Invoice Not Due"', () => {
  const env = fresh();
  env.run('WB_dailyMaintenance');
  assert.ok(ptpRow(env, 'INV-D2'), 'overdue invoice missing from tracker is added');
  assert.equal(ptpRow(env, 'INV-D2').Associate, 'Ravi');
  assert.equal(ptpRow(env, 'INV-C1'), null, 'not-due invoices are not added');
  assert.equal(dailyCell(env, 'Asha', 'CCCPC3333C'), 'Invoice Not Due');
  assert.equal(dailyCell(env, 'Asha', 'BBBPB2222B'), '', 'overdue PANs are left for the associate');
  assert.equal(dailyCell(env, 'Ravi', 'DDDPD4444D'), 'Yes', 'existing entries are untouched');
  const before = env.ss.getSheetByName('PTP Tracker').getLastRow();
  env.run('WB_dailyMaintenance');
  assert.equal(env.ss.getSheetByName('PTP Tracker').getLastRow(), before, 'idempotent');
});

test('WB_nightlySnapshot writes one row per associate and replaces a same-day run', () => {
  const env = fresh();
  env.run('WB_setup');
  assert.equal(env.run('WB_nightlySnapshot'), 2);
  env.run('WB_nightlySnapshot');
  const snap = env.ss.getSheetByName('WB Snapshots').data;
  assert.equal(snap.length, 3, 'header + 2 associates');
  const asha = snap.find((r) => r[1] === 'Asha');
  assert.equal(asha[2], 3, 'active PANs');
  assert.equal(asha[3], 113000);
});

test('WB_setup is idempotent: tabs, headers, settings and triggers once', () => {
  const env = fresh();
  env.run('WB_setup');
  env.run('WB_setup');
  assert.deepEqual(env.triggers.slice().sort(), ['WB_hourly', 'WB_onOpen'], 'only two triggers');
  const hdr = env.ss.getSheetByName('PTP Tracker').data[0].filter(Boolean);
  assert.equal(hdr.length, 12 + 8);
  assert.equal(hdr[12], 'PAN');
  assert.deepEqual(env.ss.getSheetByName('IO Sign Off Rate Card').data[0].filter(Boolean).slice(12), ['IO Signed On', 'IO Updated By']);
  const set = env.ss.getSheetByName('WB Settings').data;
  assert.deepEqual(set.slice(3).map((r) => r[0]).filter(Boolean), ['Asha', 'Ravi']);
  assert.equal(set.slice(3).filter((r) => r[6]).length, 9, 'every setting listed once');
  assert.ok(env.ss.getSheetByName('WB Activity Log'));
  assert.ok(env.ss.getSheetByName('WB Snapshots'));
});

// ---------------------------------------------------------------------------
// PTP / IO / productivity / team / overview
// ---------------------------------------------------------------------------

test('wbGetPtps and wbGetProductivity roll up correctly', () => {
  const env = fresh();
  env.run('WB_refreshPtpStatuses');
  call(env, 'wbSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A1'], ptpDate: key(day(4)) });
  const ptps = call(env, 'wbGetPtps', { assoc: 'Asha' });
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
  assert.equal(prod.io.done, 1);
  assert.deepEqual(prod.team.map((t) => t.assoc).sort(), ['Asha', 'Ravi']);
  assert.equal(prod.mine.trend.length, 21);
});

test('wbGetTeamReview gives team leads per-associate KPIs and review queues', () => {
  const env = withRoles(fresh());
  assert.throws(() => env.run('wbGetTeamReview', 'Tara'), /team leads/);
  env.setEmail('tara@example.com');
  env.run('WB_refreshPtpStatuses');
  const t = call(env, 'wbGetTeamReview', 'Tara');
  assert.deepEqual(t.associates.map((a) => a.name), ['Asha', 'Ravi']);
  const asha = t.associates.find((a) => a.name === 'Asha');
  assert.equal(asha.active, 3);
  assert.equal(asha.overdue, 100000);
  assert.equal(asha.ioDone, 1);
  assert.equal(asha.ioPending, 1);
  assert.deepEqual(t.queues.broken.map((r) => r.pan), ['BBBPB2222B']);
  assert.ok(t.queues.stale.some((r) => r.pan === 'BBBPB2222B'));
  assert.deepEqual(t.queues.ioPending.map((r) => r.pan), ['AAAPA1111A', 'DDDPD4444D'], 'highest incentive first');
  assert.equal(t.queues.stale[0].owner, 'Asha');
});

test('wbGetOverview: portfolio totals and data health checks', () => {
  const env = withRoles(fresh());
  env.setEmail('tara@example.com');
  assert.throws(() => env.run('wbGetOverview'), /management/);
  env.setEmail('maya@example.com');
  env.run('WB_nightlySnapshot');
  const o = call(env, 'wbGetOverview');
  assert.equal(o.total.total, 163000);
  assert.equal(o.total.active, 4);
  assert.equal(o.associates.length, 2);
  assert.equal(o.trend.length, 1);
  assert.equal(o.io.done, 1);
  const h = Object.fromEntries(o.health.map((c) => [c.id, c]));
  assert.equal(h.subtotal.level, 'bad');
  assert.equal(h.subtotal.items[0].owner, 'Ravi', 'Ravi\'s total row hides 10,000');
  assert.equal(h.subtotal.items[0].amount, 10000);
  assert.equal(h.unassigned.level, 'bad');
  assert.equal(h.unassigned.items[0].pan, 'FFFPF6666F');
  assert.equal(h.unassigned.items[0].amount, 15000);
  assert.equal(h.duplicates.level, 'ok');
  assert.equal(h.consolidated.level, 'warn');
  assert.equal(h.consolidated.items[0].pan, 'EEEPE5555E');
  assert.equal(h.payables.level, 'warn');
  assert.equal(h.payables.items[0].pan, 'CCCPC3333C');
  assert.equal(h.dates.level, 'ok');
  assert.equal(h.ptpText.level, 'warn', 'the "25th sep" status is flagged until the daily job converts it');
});

test('team views read cached books but see writes made through the workbench', () => {
  const env = fresh();
  const before = call(env, 'wbGetBook', { all: true });
  assert.equal(before.live, false);
  call(env, 'wbSaveRemark', 'DDDPD4444D', 'Fresh note', 'remarks');
  const after = call(env, 'wbGetBook', { all: true });
  assert.equal(after.rows.find((r) => r.pan === 'DDDPD4444D').remarks, 'Fresh note', 'the owner\'s cached book is dropped on write');
});

// ---------------------------------------------------------------------------
// Caches and navigation
// ---------------------------------------------------------------------------

test('open-invoice cache is reused and rebuilt when Imported_Data grows', () => {
  const env = fresh();
  const first = env.run('wbOpenInvoices_', false);
  assert.equal(first.count, 8);
  const again = env.run('wbOpenInvoices_', false);
  assert.equal(again.builtAt, first.builtAt, 'served from cache');
  const inv = env.ss.getSheetByName('Imported_Data');
  const row = inv.data[5].slice();
  row[6] = 'INV-NEW'; row[15] = 1234;
  inv.data.push(row);
  const rebuilt = env.run('wbOpenInvoices_', false);
  assert.equal(rebuilt.count, 9);
  assert.ok(rebuilt.byInv['INV-NEW']);
});

test('wbGoToRow selects the PAN row in the owner tab', () => {
  const env = fresh();
  assert.deepEqual(call(env, 'wbGoToRow', 'DDDPD4444D'), { ok: true, sheet: 'Ravi', row: 3 });
  const sel = call(env, 'wbGetSelection');
  assert.equal(sel.sheet, 'Ravi');
  assert.equal(sel.pan, 'DDDPD4444D');
  assert.equal(call(env, 'wbGoToRow', 'NOPEX0000X').ok, false);
});

test('wbBoot returns session info and the view to open, fast (the book comes in a second call)', () => {
  const env = withRoles(fresh());
  let b = call(env, 'wbBoot', '');
  assert.equal(b.key, 'a:Asha');
  assert.equal(b.init.me, 'Asha');
  assert.equal(b.book, null);
  assert.equal(call(env, 'wbBoot', 'a:Ravi').key, 'a:Asha', 'associates always start on their own book');
  env.setEmail('tara@example.com');
  assert.equal(call(env, 'wbBoot', '').key, 't:Tara');
  assert.equal(call(env, 'wbBoot', 'a:Ravi').key, 'a:Ravi', 'team leads return to the view they left');
  assert.equal(call(env, 'wbBoot', 'a:Nobody').key, 't:Tara', 'unknown saved view falls back');
  assert.ok(Array.isArray(call(env, 'wbGetBook', { teamLead: 'Tara' }).ptps.rows), 'PTPs come with the book');
});

test('WB_checkSpeed times every building block and leaves the caches warm', () => {
  const env = fresh();
  env.run('WB_setup');
  const msg = env.run('WB_checkSpeed');
  assert.match(msg, /Imported_Data \(open invoices\): [\d.]+ s  \(8 open\)/);
  assert.match(msg, /All associate tabs: .*2 tabs/);
  assert.doesNotMatch(msg, /ERROR/);
});

test('cached tabs are refreshed by workbench writes (PTP, IO, log)', () => {
  const env = fresh();
  call(env, 'wbGetPan', 'AAAPA1111A'); // warm the caches
  call(env, 'wbSavePtp', { pan: 'AAAPA1111A', invoices: ['INV-A3'], ptpDate: key(day(6)) });
  call(env, 'wbSaveIo', { pan: 'AAAPA1111A', signed: true, link: 'https://drive.example/x' });
  const d = call(env, 'wbGetPan', 'AAAPA1111A');
  assert.equal(d.invoices.find((i) => i.inv === 'INV-A3').ptpDate, key(day(6)));
  assert.equal(d.io.done, true);
  assert.deepEqual(d.history.map((h) => h.type), ['IO', 'PTP'], 'log tail picks up new rows');
  env.ss.getSheetByName('WB Activity Log').appendRow([new Date(), new Date(), 'Asha', 'AAAPA1111A', '', 'Call', 'typed in the sheet']);
  assert.equal(call(env, 'wbGetPan', 'AAAPA1111A').history[0].outcome, 'typed in the sheet', 'rows added outside the workbench too');
});

test('WB_setup removes old / duplicate workbench triggers and explains a full trigger quota', () => {
  const env = fresh();
  env.triggers.push('WB_dailyMaintenance', 'WB_warmCaches', 'WB_onOpen', 'WB_onOpen');
  env.run('WB_setup');
  assert.deepEqual(env.triggers.slice().sort(), ['WB_hourly', 'WB_onOpen']);
  const full = fresh();
  for (let i = 0; i < 20; i++) full.triggers.push('otherJob' + i);
  const r = full.run('wbInstallTriggers_', full.ss);
  assert.deepEqual([...r.failed], ['WB_onOpen', 'WB_hourly']);
  assert.match(r.note, /limit of 20 triggers/);
  assert.match(r.note, /otherJob0/);
});

test('WB_hourly runs the daily job once a day and warms caches in office hours', () => {
  const env = fresh();
  env.run('WB_setup');
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date())) % 24;
  const first = env.run('WB_hourly');
  const again = env.run('WB_hourly');
  if (hour >= 7) {
    assert.ok(first.includes('daily'));
    assert.ok(!again.includes('daily'), 'not twice the same day');
    assert.equal(dailyCell(env, 'Asha', 'CCCPC3333C'), 'Invoice Not Due');
  } else {
    assert.ok(!first.includes('daily'));
  }
  if (hour >= 22) assert.ok(first.includes('snapshot') && !again.includes('snapshot'));
  if (hour >= 8 && hour < 22) assert.ok(again.includes('warm'));
});
