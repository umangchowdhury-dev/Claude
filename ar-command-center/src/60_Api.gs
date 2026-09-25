/**
 * Workbench API (google.script.run). Everything returned is plain JSON (no Date objects).
 * Roles come from the Team tab (matched by e-mail): Associate, Team Lead, Management, Admin.
 */

function ccInit() {
  var cfg = ccConfig_();
  var team = ccTeam_();
  var who = ccWhoAmI_();
  var saved = PropertiesService.getUserProperties().getProperty('cc_me') || '';
  var person = who.person || team.filter(function (t) { return t.name === saved; })[0] || null;
  var role = person ? person.role : 'Associate';
  var associates = ccAssociates_().map(function (t) { return t.name; });
  var teamLeads = [];
  team.forEach(function (t) { if (t.teamLead && teamLeads.indexOf(t.teamLead) < 0) teamLeads.push(t.teamLead); });
  team.forEach(function (t) { if (t.role === 'Team Lead' && teamLeads.indexOf(t.name) < 0) teamLeads.push(t.name); });
  var activeSheet = SpreadsheetApp.getActive().getActiveSheet().getName();
  return {
    email: who.email, me: person ? person.name : saved, role: role, identified: !!who.person,
    associates: associates, teamLeads: teamLeads,
    team: team.map(function (t) { return { name: t.name, role: t.role, teamLead: t.teamLead, group: t.group }; }),
    today: ccToday_(), mode: cfg.MODE, restrict: cfg.RESTRICT_VIEWS === 'Yes',
    lastSync: PropertiesService.getScriptProperties().getProperty('cc_last_sync') || '',
    dailyValues: CC.DAILY_VALUES, invoiceTags: CC.INVOICE_TAGS, confidence: CC.CONFIDENCE, activeSheet: activeSheet
  };
}

function ccSetMe(name) {
  PropertiesService.getUserProperties().setProperty('cc_me', name || '');
  return true;
}

/** Which PAN is the user pointing at in the grid (for "Follow"). */
function ccGetSelection() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getActiveSheet();
  var cell = sh.getActiveCell();
  var out = { sheet: sh.getName(), row: cell ? cell.getRow() : 0, pan: '' };
  if (!cell || out.row < 2) return out;
  var n = sh.getName();
  var v = function (c) { return ccStr_(sh.getRange(out.row, c).getValue()); };
  if (n === CC.T.PAN || n === CC.T.INV || n === CC.T.IO || n === CC.T.INPUTS) out.pan = v(1);
  else if (n === CC.T.FU) out.pan = v(2);
  else if (n === CC.T.LOG) out.pan = v(4);
  else if (n === CC.T.PTP) {
    out.pan = v(13);
    if (!out.pan) { var o = ccOpenInvoices_().byInv[v(1)]; if (o) out.pan = o.pan; }
  } else {
    var a = v(1);
    if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(a)) out.pan = a;
  }
  if (out.pan.length < 8 || /\s/.test(out.pan)) out.pan = '';
  return out;
}

// ---------------------------------------------------------------------------
// Light model: PAN Master as objects + follow-ups + PTPs + IO (no recompute)
// ---------------------------------------------------------------------------

function ccLightModel_(opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.getActive();
  var cfg = ccConfig_();
  var today = ccToday_();
  var sh = ss.getSheetByName(CC.T.PAN);
  var rows = [];
  var fu = ccReadFollowUps_(ss);
  var workdays = [];
  for (var back = 1; workdays.length < 3 && back < 15; back++) {
    var d = ccAddDays_(today, -back);
    if (ccIsWorkday_(d, cfg)) workdays.push(d);
  }
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, CC_PAN_COLS.length).getValues().forEach(function (v, i) {
      if (!v[0]) return;
      var o = { row: i + 2 };
      CC_PAN_COLS.forEach(function (c, j) {
        var x = v[j];
        if (c.date) o[c.key] = x instanceof Date ? ccKey_(x) : '';
        else if (c.datetime) o[c.key] = x instanceof Date ? x.toISOString() : '';
        else if (c.money) o[c.key] = x === '' ? (c.input ? '' : 0) : ccNum_(x);
        else o[c.key] = x instanceof Date ? ccKey_(x) : x;
      });
      ['openInv', 'ptpOpen', 'ptpBroken', 'priority', 'fuMtd'].forEach(function (k) { o[k] = ccNum_(o[k]); });
      o.pan = String(o.pan).trim();
      o.owner = ccStr_(o.owner);
      var daily = fu.byPan[o.pan] || {};
      o.todayStatus = daily[today] || '';
      o.recent = [];
      for (var k = 0; k < 7; k++) o.recent.push(daily[ccAddDays_(today, -k)] || '');
      o.daysSince = o.daysSince === '' ? '' : ccNum_(o.daysSince);
      o.notFollowed3 = o.total > 0 && workdays.length === 3 && workdays.every(function (dk) { return !daily[dk] || daily[dk] === 'No'; });
      o.ptpDueToday = 0;
      rows.push(o);
    });
  }
  var ptpSh = ccSheet_(CC.T.PTP);
  var ptpRows = ptpSh.getLastRow() >= 2
    ? ptpSh.getRange(2, 1, ptpSh.getLastRow() - 1, CC_PTP_COLS.length).getValues().filter(function (r) { return r[0]; })
      .map(function (r) { return ccPtpRowObj_(r, today); })
    : [];
  var byPan = {};
  rows.forEach(function (r) { byPan[r.pan] = r; });
  ptpRows.forEach(function (p) {
    if (p.ptpDate === today && p.outstanding > 0 && byPan[p.pan]) byPan[p.pan].ptpDueToday++;
  });
  return {
    cfg: cfg, today: today, team: ccTeam_(), rows: rows, byPan: byPan, fu: fu,
    ptp: { rows: ptpRows }, io: ccReadIo_(ss), inv: { total: opts.withInvoiceTotal ? ccOpenTotal_() : 0 }
  };
}

function ccOpenTotal_() {
  var o = ccOpenInvoices_().byInv;
  return Object.keys(o).reduce(function (s, k) { return s + (o[k].pan ? o[k].net : 0); }, 0);
}

/** Which associates may this user see? (only enforced when Config RESTRICT_VIEWS = Yes) */
function ccVisible_(model) {
  var init = ccInit();
  if (!init.restrict || init.role === 'Management' || init.role === 'Admin') return null; // everyone
  if (init.role === 'Team Lead') {
    return model.team.filter(function (t) { return t.teamLead === init.me || t.name === init.me; }).map(function (t) { return t.name; });
  }
  return [init.me];
}

function ccCheckScope_(model, assocs) {
  var vis = ccVisible_(model);
  if (!vis) return;
  assocs.forEach(function (a) { if (vis.indexOf(a) < 0) throw new Error('You can only open your own / your team\'s PANs'); });
}

function ccSlim_(r) {
  return {
    pan: r.pan, customer: r.customer, owner: r.owner, teamLead: r.teamLead, group: r.group, brands: r.brands,
    kams: r.kams, kamMgr: r.kamMgr, bizModel: r.bizModel, exposure: r.exposure, arApHist: r.arApHist,
    b0: r.b0, b1: r.b1, b2: r.b2, b3: r.b3, b4: r.b4, b5: r.b5, b6: r.b6, total: r.total, overdue: r.overdue,
    gt60: r.gt60, netPayable: r.netPayable, possibleArAp: r.possibleArAp, openInv: r.openInv, oldest: r.oldest,
    ptpOpen: r.ptpOpen, ptpAmt: r.ptpAmt, ptpNext: r.ptpNext, ptpBroken: r.ptpBroken, ptpDueToday: r.ptpDueToday,
    lastTouch: r.lastTouch, daysSince: r.daysSince === '' ? null : r.daysSince, recent: r.recent, today: r.todayStatus,
    priority: r.priority, confidence: r.confidence, redAmt: r.redAmt, amberAmt: r.amberAmt, greenAmt: r.greenAmt, poe: r.poe, nextFollowUp: r.nextFu,
    remarks: r.remarks, tlRemarks: r.tlRemarks, notFollowed3: r.notFollowed3, ioRate: r.ioRate, ioDone: r.ioDone
  };
}

// ---------------------------------------------------------------------------
// Book / PAN
// ---------------------------------------------------------------------------

/** scope: {assoc} | {teamLead} | {all:true} */
function ccGetBook(scope) {
  scope = scope || {};
  var m = ccLightModel_();
  var names = ccScopeNames_(m, scope);
  ccCheckScope_(m, names);
  var rows = m.rows.filter(function (r) { return names.indexOf(r.owner || 'Unassigned') >= 0; }).map(ccSlim_);
  var ptps = m.ptp.rows.filter(function (p) { return names.indexOf(p.associate) >= 0 && (p.ptpDate || p.tag || (p.status && p.status !== 'PTP Pending')); });
  var nextFu = {};
  rows.forEach(function (r) { nextFu[r.pan] = r.nextFollowUp; });
  return { scope: scope, names: names, today: m.today, rows: rows, ptps: ptps };
}

function ccScopeNames_(m, scope) {
  if (scope.all) {
    var all = m.team.map(function (t) { return t.name; });
    m.rows.forEach(function (r) { var n = r.owner || 'Unassigned'; if (all.indexOf(n) < 0) all.push(n); });
    return all;
  }
  if (scope.teamLead) {
    var list = m.team.filter(function (t) { return t.teamLead === scope.teamLead; }).map(function (t) { return t.name; });
    return list.length ? list : [scope.teamLead];
  }
  return [scope.assoc || ''];
}

function ccGetPan(pan) {
  pan = String(pan || '').trim();
  var ss = SpreadsheetApp.getActive();
  var m = ccLightModel_();
  var r = m.byPan[pan];
  if (r) ccCheckScope_(m, [r.owner || 'Unassigned']);
  var today = m.today;
  var header = r ? ccSlim_(r) : null;
  if (header) {
    var daily = m.fu.byPan[pan] || {};
    header.daily = daily;
    header.recentDates = [];
    for (var k = 0; k < 14; k++) header.recentDates.push(ccAddDays_(today, -k));
    ['months', 'buHead', 'cat1', 'cat2', 'bizfin', 'possibleArAp60', 'possibleArApTotal', 'fuMtd'].forEach(function (f) { header[f] = r[f]; });
  }
  var open = ccOpenInvoices_().byPan[pan] || [];
  var ptpBy = {};
  m.ptp.rows.forEach(function (p) { ptpBy[p.invoice] = p; });
  var invoices = open.map(function (inv) {
    var p = ptpBy[inv.inv] || {};
    return {
      inv: inv.inv, invDate: inv.invDate, dueDate: inv.dueDate, credit: inv.credit, month: inv.month, brand: inv.brand,
      ageing: inv.ageing, bucket: inv.bucket, tds: inv.tds, receipt: inv.receipt, arap: inv.arap, net: inv.net,
      kam: inv.kam, kamMgr: inv.kamMgr, overdue: inv.bucket !== 'a.Not Due' && !!inv.dueDate && inv.dueDate < today,
      ptpDate: p.ptpDate || '', ptpAmount: p.ptpAmount === undefined ? '' : p.ptpAmount, ptpStatus: p.live || '',
      ptpMode: p.mode || '', ptpContact: p.contact || '', ptpRemarks: p.remarks || '', tag: p.tag || '', inTracker: !!p.invoice
    };
  });
  invoices.sort(function (a, b) { return (b.ageing || 0) - (a.ageing || 0); });
  return {
    pan: pan, owner: r ? r.owner : '', header: header, invoices: invoices, customer: (r && r.customer) || (open[0] && open[0].cust) || '',
    paid: ccRecentPaid_(ss, pan, 15), history: ccReadLog_(ss).filter(function (l) { return l.pan === pan; }).reverse().slice(0, 50)
  };
}

function ccRecentPaid_(ss, pan, limit) {
  var sh = ss.getSheetByName(CC.T.INV);
  if (!sh || sh.getLastRow() < 2) return [];
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var C = ccInvCols_(hdr);
  var cells = sh.getRange(2, C.pan + 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findAll();
  var rowsNo = cells.map(function (c) { return c.getRow(); }).sort(function (a, b) { return b - a; });
  var out = [];
  for (var i = 0; i < rowsNo.length && out.length < limit && i < limit * 4; i++) {
    var row = sh.getRange(rowsNo[i], 1, 1, hdr.length).getValues()[0];
    if (ccNum_(row[C.net]) !== 0 || !row[C.inv]) continue;
    out.push({ inv: ccStr_(row[C.inv]), invDate: ccKey_(row[C.invDate]), dueDate: ccKey_(row[C.due]), receipt: ccNum_(row[C.receipt]),
      receiptDate: ccKey_(row[C.receiptDate]), arap: ccNum_(row[C.arap]), tds: ccNum_(row[C.tds]), brand: ccStr_(row[C.brand]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function ccOwnerOf_(pan) {
  var sh = SpreadsheetApp.getActive().getSheetByName(CC.T.PAN);
  if (!sh || sh.getLastRow() < 2) return '';
  var f = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findNext();
  return f ? ccStr_(sh.getRange(f.getRow(), ccPanColIndex_().owner + 1).getValue()) : '';
}

function ccWithLock_(fn) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** payload: {pan, customer, invoices:[no], ptpDate, amounts:{no:amt}, mode, contact, remarks, markDaily, updateRemark} */
function ccSavePtp(payload) {
  if (!payload || !payload.invoices || !payload.invoices.length) throw new Error('Select at least one invoice');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.ptpDate || '')) throw new Error('Pick a PTP date');
  return ccWithLock_(function () {
    var user = ccUser_();
    var owner = ccOwnerOf_(payload.pan) || payload.assoc || '';
    var open = ccOpenInvoices_().byInv;
    var now = new Date();
    var total = 0;
    var ups = payload.invoices.map(function (no) {
      var inv = open[no] || {};
      var amt = payload.amounts && payload.amounts[no] !== undefined && payload.amounts[no] !== '' ? Number(payload.amounts[no]) : (inv.net || '');
      total += Number(amt) || 0;
      return { invoice: no, inv: inv, set: { 8: ccDate_(payload.ptpDate), 10: '', 11: ccPtpStatus_(payload.ptpDate, inv.net, inv.net, ''),
        12: payload.pan, 13: amt, 14: payload.mode || '', 15: payload.contact || '', 16: payload.remarks || '', 18: user || owner, 19: now } };
    });
    ccUpsertPtpRows_(ups, owner);
    ccLog_({ assoc: owner, pan: payload.pan, customer: payload.customer, type: 'PTP', outcome: 'PTP for ' + ccFmtDate_(payload.ptpDate),
      invoices: payload.invoices.join(', '), amount: total, next: payload.ptpDate, remarks: payload.remarks || '' });
    if (payload.markDaily !== false) ccSetFollowUp_(ccToday_(), payload.pan, owner, 'PTP', 'Workbench', user);
    if (payload.updateRemark !== false) {
      ccSetInputs_(payload.pan, { remarks: ccStamp_() + ': PTP ' + ccFmtDate_(payload.ptpDate) + ' for ' + payload.invoices.length + ' inv (' + ccInr_(total) + ')' +
        (payload.remarks ? ' - ' + payload.remarks : '') }, user);
    }
    ccRefreshPanPtpRollup_(payload.pan);
    return { ok: true, count: payload.invoices.length, amount: total };
  });
}

/** payload: {pan, invoices, tag?, clearPtp?, remarks?} */
function ccTagInvoices(payload) {
  if (!payload || !payload.invoices || !payload.invoices.length) throw new Error('Select at least one invoice');
  return ccWithLock_(function () {
    var user = ccUser_();
    var owner = ccOwnerOf_(payload.pan) || '';
    var open = ccOpenInvoices_().byInv;
    var now = new Date();
    var ups = payload.invoices.map(function (no) {
      var set = { 12: payload.pan, 18: user || owner, 19: now };
      if (payload.tag !== undefined) set[17] = payload.tag;
      if (payload.clearPtp) { set[8] = ''; set[13] = ''; set[11] = 'PTP Pending'; set[10] = ''; }
      if (payload.remarks) set[16] = payload.remarks;
      return { invoice: no, inv: open[no] || {}, set: set };
    });
    ccUpsertPtpRows_(ups, owner);
    ccLog_({ assoc: owner, pan: payload.pan, customer: payload.customer, type: 'Status',
      outcome: payload.clearPtp ? 'PTP cleared' : (payload.tag ? 'Tagged: ' + payload.tag : 'Tag removed'),
      invoices: payload.invoices.join(', '), remarks: payload.remarks || '' });
    if (payload.tag === 'Expected Payment') ccSetFollowUp_(ccToday_(), payload.pan, owner, 'Expected Payment', 'Workbench', user);
    ccRefreshPanPtpRollup_(payload.pan);
    return { ok: true, count: payload.invoices.length };
  });
}

/** Upsert PTP Tracker rows by invoice. set = {colIndex0: value} */
function ccUpsertPtpRows_(ups, owner) {
  var sh = ccSheet_(CC.T.PTP);
  var W = CC_PTP_COLS.length;
  var last = sh.getLastRow();
  var rowOf = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { var k = ccStr_(r[0]); if (k) rowOf[k] = i + 2; });
  var today = ccToday_();
  var appends = [];
  ups.forEach(function (u) {
    var r = rowOf[u.invoice];
    var row;
    if (r) row = sh.getRange(r, 1, 1, W).getValues()[0];
    else {
      row = ccFit_([], W);
      row[0] = u.invoice; row[1] = u.inv.cust || ''; row[2] = u.inv.brand || ''; row[3] = owner;
      row[4] = u.inv.dueDate ? ccDate_(u.inv.dueDate) : ''; row[5] = u.inv.net || ''; row[6] = u.inv.net || '';
      row[7] = ccDate_(today); row[11] = 'PTP Pending';
    }
    Object.keys(u.set).forEach(function (k) { row[Number(k)] = u.set[k]; });
    if (!row[3]) row[3] = owner;
    if (r) sh.getRange(r, 1, 1, W).setValues([row]); else appends.push(row);
  });
  ccAppendRows_(sh, appends);
}

/** Recompute Open PTPs / PTP Amount / Next PTP / Broken PTPs on the PAN Master row after a PTP change. */
function ccRefreshPanPtpRollup_(pan) {
  var sh = ccSheet_(CC.T.PTP);
  if (sh.getLastRow() < 2) return;
  var today = ccToday_();
  var cells = sh.getRange(2, 13, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findAll();
  var b = { ptpOpen: 0, ptpAmt: 0, ptpNext: '', ptpBroken: 0 };
  cells.forEach(function (c) {
    var p = ccPtpRowObj_(sh.getRange(c.getRow(), 1, 1, CC_PTP_COLS.length).getValues()[0], today);
    if (!p.ptpDate || p.outstanding <= 0) return;
    b.ptpOpen++;
    b.ptpAmt += p.ptpAmount === '' ? p.outstanding : p.ptpAmount;
    if (p.ptpDate < today) b.ptpBroken++;
    if (p.ptpDate >= today && (!b.ptpNext || p.ptpDate < b.ptpNext)) b.ptpNext = p.ptpDate;
  });
  b.ptpNext = b.ptpNext ? ccDate_(b.ptpNext) : '';
  ccPatchPanMaster_(pan, b);
}

/** payload: {pan, customer, channel, outcome, remarks, nextDate, daily, updateRemark} */
function ccLogFollowUp(payload) {
  if (!payload || !payload.pan) throw new Error('No PAN');
  return ccWithLock_(function () {
    var user = ccUser_();
    var owner = ccOwnerOf_(payload.pan) || payload.assoc || '';
    ccLog_({ assoc: owner, pan: payload.pan, customer: payload.customer, type: payload.channel || 'Call',
      outcome: payload.outcome || '', next: payload.nextDate || '', remarks: payload.remarks || '' });
    var daily = payload.daily === undefined ? 'Yes' : payload.daily;
    if (daily) ccSetFollowUp_(ccToday_(), payload.pan, owner, daily, 'Workbench', user);
    var fields = {};
    if (payload.nextDate !== undefined) fields.nextFu = payload.nextDate || '';
    if (payload.updateRemark !== false && (payload.remarks || payload.outcome)) {
      fields.remarks = ccStamp_() + ': ' + [payload.outcome, payload.remarks].filter(String).join(' - ') +
        (payload.nextDate ? ' | next f/u ' + ccFmtDate_(payload.nextDate) : '');
    }
    if (Object.keys(fields).length) ccSetInputs_(payload.pan, fields, user);
    return { ok: true };
  });
}

function ccBulkDaily(pans, value) {
  if (CC.DAILY_VALUES.indexOf(value) < 0) throw new Error('Invalid status ' + value);
  return ccWithLock_(function () {
    var user = ccUser_();
    pans.forEach(function (p) { ccSetFollowUp_(ccToday_(), p, ccOwnerOf_(p), value, 'Workbench', user); });
    ccLog_({ assoc: pans.length ? ccOwnerOf_(pans[0]) : '', pan: pans.length === 1 ? pans[0] : '(' + pans.length + ' PANs)',
      type: 'Daily status', outcome: value, remarks: pans.length > 1 ? pans.join(', ') : '' });
    return { ok: true, count: pans.length };
  });
}

/** which: 'remarks' | 'tlRemarks' */
function ccSaveRemark(pan, text, which) {
  which = which === 'tlRemarks' ? 'tlRemarks' : 'remarks';
  return ccWithLock_(function () {
    var f = {};
    f[which] = text;
    ccSetInputs_(pan, f, ccUser_());
    ccLog_({ assoc: ccOwnerOf_(pan), pan: pan, type: which === 'tlRemarks' ? 'TL review' : 'Note',
      outcome: which === 'tlRemarks' ? 'Team Lead remark' : 'Remark updated', remarks: text });
    return { ok: true };
  });
}

/** amounts: {redAmt, amberAmt, greenAmt} (numbers or ''). poe: 'Yes' | 'No' | undefined */
function ccSetConfidence(pan, amounts, poe) {
  return ccWithLock_(function () {
    var f = {};
    ['redAmt', 'amberAmt', 'greenAmt'].forEach(function (k) {
      var v = amounts ? amounts[k] : '';
      f[k] = v === '' || v === null || v === undefined ? '' : Number(v);
    });
    var confidence = ccConfidenceOf_(f);
    if (poe !== undefined) f.poe = poe;
    ccSetInputs_(pan, f, ccUser_());
    ccLog_({ assoc: ccOwnerOf_(pan), pan: pan, type: 'Status', outcome: 'Confidence: ' + (confidence || 'cleared') + (poe ? ' · POE ' + poe : '') });
    return { ok: true };
  });
}

/** Team lead / management: move PANs to another associate. */
function ccReassign(pans, newOwner) {
  var init = ccInit();
  if (init.role === 'Associate' && init.restrict) throw new Error('Only team leads / management can reassign PANs');
  return ccWithLock_(function () {
    var user = ccUser_();
    var t = ccTeam_().filter(function (x) { return x.name === newOwner; })[0] || {};
    pans.forEach(function (p) {
      var from = ccOwnerOf_(p);
      ccSetInputs_(p, { owner: newOwner }, user, { skipPanMaster: true });
      ccPatchPanMaster_(p, { owner: newOwner, teamLead: t.teamLead || '', group: t.group || '', updatedBy: user, updatedOn: new Date() });
      ccLog_({ assoc: newOwner, pan: p, type: 'Reassigned', outcome: (from || 'Unassigned') + ' → ' + newOwner });
    });
    return { ok: true, count: pans.length };
  });
}

function ccCreateEmailDraft(payload) {
  var data = ccGetPan(payload.pan);
  var list = data.invoices.filter(function (i) { return !payload.invoices || !payload.invoices.length || payload.invoices.indexOf(i.inv) >= 0; });
  if (!list.length) throw new Error('No open invoices to include');
  var cfg = ccConfig_();
  var total = list.reduce(function (s, i) { return s + (i.net || 0); }, 0);
  var th = 'style="background:#f1f3f4;text-align:left;padding:6px;border:1px solid #ddd"';
  var rows = list.map(function (i) {
    return '<tr><td>' + ccEsc_(i.inv) + '</td><td>' + ccFmtDate_(i.invDate) + '</td><td>' + ccFmtDate_(i.dueDate) + '</td><td>' +
      ccEsc_(i.brand) + '</td><td style="text-align:right">' + (i.ageing || 0) + '</td><td style="text-align:right">' + ccInrFull_(i.net) + '</td></tr>';
  }).join('');
  var owner = data.owner || payload.assoc || '';
  var html = '<p>Dear ' + ccEsc_(payload.contact || 'Team') + ',</p><p>Greetings from Zepto. As per our records, the following invoices for <b>' +
    ccEsc_(data.customer) + '</b> (PAN ' + ccEsc_(data.pan) + ') are outstanding. Total due: <b>' + ccInrFull_(total) + '</b>.</p>' +
    '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px" cellpadding="6" border="1"><tr><th ' + th + '>Invoice No</th><th ' + th +
    '>Invoice Date</th><th ' + th + '>Due Date</th><th ' + th + '>Brand</th><th ' + th + '>Days</th><th ' + th + '>Amount (INR)</th></tr>' + rows +
    '<tr><td colspan="5"><b>Total</b></td><td style="text-align:right"><b>' + ccInrFull_(total) + '</b></td></tr></table>' +
    '<p>' + ccEsc_(payload.note || 'Request you to share the payment date / remittance details at the earliest.') + '</p>' +
    '<p>Regards,<br>' + ccEsc_(owner) + '<br>' + ccEsc_(cfg.EMAIL_SIGNATURE || 'Accounts Receivable') + '</p>';
  var draft = GmailApp.createDraft(payload.to || '', payload.subject || ('Payment reminder: ' + data.customer + ' - outstanding ' + ccInrFull_(total)),
    'Please view this e-mail in HTML.', { htmlBody: html, cc: payload.cc || '' });
  ccWithLock_(function () {
    ccLog_({ assoc: owner, pan: data.pan, customer: data.customer, type: 'Email', outcome: 'Reminder drafted (' + list.length + ' inv)',
      invoices: list.map(function (i) { return i.inv; }).join(', '), amount: total, remarks: payload.to ? 'To: ' + payload.to : '' });
    ccSetFollowUp_(ccToday_(), data.pan, owner, 'Yes', 'Workbench', ccUser_());
  });
  return { ok: true, draftId: draft.getId(), link: 'https://mail.google.com/mail/#drafts', count: list.length, total: total };
}

function ccGoToRow(pan) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CC.T.PAN);
  if (!sh || sh.getLastRow() < 2) return false;
  var f = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (!f) return false;
  ss.setActiveSheet(sh);
  sh.setActiveRange(sh.getRange(f.getRow(), 1));
  return true;
}

function ccRefresh() {
  var r = ccRebuild_();
  return { ok: true, pans: r.pans, invoices: r.openInvoices };
}

// ---------------------------------------------------------------------------
// Productivity, team review, management overview
// ---------------------------------------------------------------------------

function ccGetProductivity(assoc) {
  var m = ccLightModel_();
  ccCheckScope_(m, [assoc]);
  var today = m.today;
  var monthStart = today.slice(0, 8) + '01';
  var weekStart = ccAddDays_(today, -((ccDow_(today) + 6) % 7));
  var sum = ccSummaryByAssociate_(m);
  var mine = sum.filter(function (s) { return s.name === assoc; })[0] || null;
  var counts = m.fu.byAssocDate[assoc] || {};
  var trend = [];
  for (var k = 20; k >= 0; k--) {
    var d = ccAddDays_(today, -k);
    trend.push({ date: d, counts: counts[d] || {}, cov: mine && mine.nonZero ? ccTouchedCount_(counts[d]) / mine.nonZero : 0 });
  }
  var acts = { today: {}, week: {}, month: {} };
  var teamActs = {};
  ccReadLog_().forEach(function (l) {
    if (l.date >= monthStart) teamActs[l.assoc] = (teamActs[l.assoc] || 0) + 1;
    if (l.assoc !== assoc) return;
    var t = l.type || 'Other';
    if (l.date === today) acts.today[t] = (acts.today[t] || 0) + 1;
    if (l.date >= weekStart) acts.week[t] = (acts.week[t] || 0) + 1;
    if (l.date >= monthStart) acts.month[t] = (acts.month[t] || 0) + 1;
  });
  var ptp = { given: 0, givenAmt: 0, kept: 0, keptAmt: 0, broken: 0, brokenAmt: 0, open: 0, openAmt: 0, partial: 0, missed: 0 };
  m.ptp.rows.forEach(function (p) {
    if (p.associate !== assoc || !p.ptpDate) return;
    var amt = p.ptpAmount === '' ? (p.added || p.outstanding) : p.ptpAmount;
    ptp.given++; ptp.givenAmt += amt;
    if (p.live === 'Paid (PTP Kept)') { ptp.kept++; ptp.keptAmt += amt; }
    else if (p.live === 'Paid (after PTP)') { ptp.missed++; ptp.keptAmt += amt; }
    else if (p.live === 'PTP Broken') { ptp.broken++; ptp.brokenAmt += p.outstanding; }
    else { ptp.open++; ptp.openAmt += p.outstanding; if (p.live === 'Partially Paid') ptp.partial++; }
  });
  var closed = ptp.kept + ptp.missed + ptp.broken;
  ptp.keptRate = closed ? ptp.kept / closed : null;
  var team = sum.filter(function (s) { return !s.isTotal && s.name !== 'Unassigned'; }).map(function (s) {
    return { assoc: s.name, teamLead: s.teamLead, active: s.nonZero, todayCov: s.nonZero ? s.touchedToday / s.nonZero : 0, mtdCov: s.mtdCov,
      touchedToday: s.touchedToday, untouched3: s.notFollowed3, overdue: s.overdue, gt60: s.gt60, actsMtd: teamActs[s.name] || 0, keptRate: s.keptRate };
  }).sort(function (a, b) { return b.mtdCov - a.mtdCov; });
  return {
    today: today, mine: mine ? { active: mine.nonZero, touchedToday: mine.touchedToday, todayCov: mine.nonZero ? mine.touchedToday / mine.nonZero : 0,
      mtdCov: mine.mtdCov, untouched3: mine.notFollowed3, trend: trend } : null,
    acts: acts, ptp: ptp, team: team
  };
}

/** Team lead review: per-associate KPIs + review queues. teamLead '' = everybody (management). */
function ccGetTeamReview(teamLead) {
  var m = ccLightModel_();
  var names = teamLead ? ccScopeNames_(m, { teamLead: teamLead }) : ccScopeNames_(m, { all: true });
  ccCheckScope_(m, names.filter(function (n) { return n !== 'Unassigned'; }));
  var sum = ccSummaryByAssociate_(m).filter(function (s) { return !s.isTotal && names.indexOf(s.name) >= 0; });
  var rows = m.rows.filter(function (r) { return names.indexOf(r.owner || 'Unassigned') >= 0; });
  var top = function (list, key, n) { return list.sort(function (a, b) { return b[key] - a[key]; }).slice(0, n || 30).map(ccSlim_); };
  return {
    teamLead: teamLead, names: names, today: m.today,
    associates: sum.map(function (s) {
      return { name: s.name, active: s.nonZero, overdue: s.overdue, gt60: s.gt60, arap: s.possibleArAp, touchedToday: s.touchedToday,
        todayCov: s.nonZero ? s.touchedToday / s.nonZero : 0, mtdCov: s.mtdCov, stale: s.notFollowed3, ptpOpen: s.ptpOpen,
        broken: s.ptpBroken, keptRate: s.keptRate, remarksFilled: s.remarksFilled, red: s.red, amber: s.amber, green: s.green };
    }),
    queues: {
      broken: top(rows.filter(function (r) { return r.ptpBroken > 0; }), 'overdue'),
      stale: top(rows.filter(function (r) { return r.overdue > 0 && r.notFollowed3; }), 'overdue'),
      gt60NoPtp: top(rows.filter(function (r) { return r.gt60 > 0 && !r.ptpOpen; }), 'gt60'),
      noRemark: top(rows.filter(function (r) { return r.overdue > 0 && !r.remarks; }), 'overdue'),
      red: top(rows.filter(function (r) { return r.confidence === 'Red'; }), 'overdue'),
      exposure: top(rows.filter(function (r) { return r.exposure === 'Yes' && r.overdue > 0; }), 'overdue')
    }
  };
}

/** Management overview: portfolio, ageing, groupings, trend from Snapshots, reconciliation. */
function ccGetOverview() {
  var m = ccLightModel_({ withInvoiceTotal: true });
  var sum = ccSummaryByAssociate_(m);
  var tot = sum[sum.length - 1];
  var group = function (keyFn) {
    var g = {};
    m.rows.forEach(function (r) {
      if (!r.total) return;
      var k = keyFn(r) || '(blank)';
      var o = g[k] || (g[k] = { key: k, pans: 0, total: 0, overdue: 0, gt60: 0, arap: 0 });
      o.pans++; o.total += r.total; o.overdue += r.overdue; o.gt60 += r.gt60; o.arap += r.possibleArAp;
    });
    return Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.overdue - a.overdue; }).slice(0, 15);
  };
  var snaps = {};
  var ssh = SpreadsheetApp.getActive().getSheetByName(CC.T.SNAP);
  if (ssh && ssh.getLastRow() >= 2) {
    ssh.getRange(2, 1, ssh.getLastRow() - 1, CC_SNAP_COLS.length).getValues().forEach(function (r) {
      var d = ccKey_(r[0]);
      if (!d) return;
      var o = snaps[d] || (snaps[d] = { date: d, total: 0, overdue: 0, gt60: 0, touched: 0, active: 0, broken: 0 });
      o.total += ccNum_(r[4]); o.overdue += ccNum_(r[5]); o.gt60 += ccNum_(r[6]); o.touched += ccNum_(r[9]); o.active += ccNum_(r[3]); o.broken += ccNum_(r[14]);
    });
  }
  var trend = Object.keys(snaps).sort().slice(-60).map(function (k) { return snaps[k]; });
  return {
    today: m.today, lastSync: PropertiesService.getScriptProperties().getProperty('cc_last_sync') || '',
    total: { total: tot.total, overdue: tot.overdue, gt60: tot.gt60, arap: tot.possibleArAp, arapHist: tot.possibleArApHist, netPayable: tot.netPayable,
      b: tot.b, pans: tot.nonZero, touched: tot.touchedToday, mtdCov: tot.mtdCov, ptpOpen: tot.ptpOpen, ptpAmt: tot.ptpAmt, broken: tot.ptpBroken,
      keptRate: tot.keptRate, red: tot.red, amber: tot.amber, green: tot.green, stale: tot.notFollowed3, ioDone: tot.ioDone, ioPending: tot.ioPending,
      ioIncentive: tot.ioIncentive },
    recon: { panMaster: tot.total, invoices: m.inv.total, diff: tot.total - m.inv.total },
    associates: sum.filter(function (s) { return !s.isTotal; }).map(function (s) {
      return { name: s.name, group: s.group, teamLead: s.teamLead, active: s.nonZero, total: s.total, overdue: s.overdue, gt60: s.gt60,
        arap: s.possibleArAp, todayCov: s.nonZero ? s.touchedToday / s.nonZero : 0, mtdCov: s.mtdCov, stale: s.notFollowed3,
        ptpOpen: s.ptpOpen, broken: s.ptpBroken, keptRate: s.keptRate, ioDone: s.ioDone, ioPending: s.ioPending };
    }),
    byModel: group(function (r) { return r.bizModel; }),
    byBu: group(function (r) { return String(r.buHead || '').split(',')[0].trim(); }),
    byTeamLead: group(function (r) { return r.teamLead || '(no team lead)'; }),
    topOverdue: m.rows.filter(function (r) { return r.overdue > 0; }).sort(function (a, b) { return b.overdue - a.overdue; }).slice(0, 20).map(ccSlim_),
    trend: trend
  };
}

function ccStamp_() { return Utilities.formatDate(new Date(), ccTz_(), 'dd-MMM'); }
