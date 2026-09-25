/**
 * AR Associate Workbench
 * ----------------------
 * Apps Script add-on for the "Associate Level Ageing Master - AR" Google Sheet.
 *
 * Gives every associate a personal workbench (sidebar + full-screen view) on top of
 * the existing tabs:
 *   - Today       : work queue (PTPs due / broken, scheduled follow-ups, untouched PANs)
 *   - My PANs     : searchable, filterable, sortable book of PANs with ageing + flags
 *   - PAN drill   : invoice-level details from Imported_Data, PTP per invoice,
 *                   follow-up logging, e-mail reminder drafts, activity history
 *   - PTPs        : every PTP the associate owns with live status
 *   - Productivity: coverage, activities, PTP kept-rate, team leaderboard
 *
 * Nothing in the existing formulas is changed. The script only writes to:
 *   - the associate's own tab  (Remarks column + today's daily follow-up column)
 *   - 'PTP Tracker'            (upsert by Invoice No, extra columns appended on the right)
 *   - 'WB Activity Log'        (new tab, created on first use)
 *
 * Run WB_setup() once from the Apps Script editor to install triggers.
 */

var WB = {
  SHEET_CONSOLIDATED: 'Consolidated',
  SHEET_PTP: 'PTP Tracker',
  SHEET_INV: 'Imported_Data',
  SHEET_LOG: 'WB Activity Log',
  // Values allowed by the existing data validation on the daily follow-up columns.
  DAILY_VALUES: ['Yes', 'No', 'Leave', 'Holiday', 'Invoice Not Due', 'PTP', 'Expected Payment'],
  INVOICE_TAGS: ['', 'Disputed', 'AR-AP Proposed', 'AR-AP Approved', 'Expected Payment', 'Awaiting POE',
    'Awaiting Reco / Remittance', 'Credit Note Requested', 'Escalated to KAM', 'Legal'],
  PTP_EXTRA_HEADERS: ['PAN', 'PTP Amount', 'Payment Mode', 'Contact Person', 'PTP Remarks',
    'Invoice Tag', 'Updated By', 'Updated On'],
  LOG_HEADERS: ['Timestamp', 'Date', 'Associate', 'PAN', 'Customer', 'Type', 'Outcome',
    'Invoices', 'Amount', 'Next Follow-up', 'Remarks', 'User'],
  CACHE_PREFIX: 'wb_open_v2_',
  CACHE_TTL: 21600 // 6 h, the CacheService maximum
};

// Header aliases: tabs were built at different times and are not 100% consistent.
var WB_COLS = {
  pan: ['PAN', 'PAN #', 'PAN Number'],
  customer: ['Customer Name'],
  brands: ['Brand Names', 'Brand'],
  months: ['Due Activity Months', 'Pending Activity Months'],
  kamMgr: ['KAM Managers'],
  kams: ['KAMs'],
  bizModel: ['Business Model'],
  arApHist: ['Historically AR AP Done or not ?', 'Historically AR AP Done or not'],
  exposure: ['Exposure/Defaulting PAN ?', 'Exposure/Defaulting PAN'],
  poe: ['POE Required ?', 'POE Required'],
  buHead: ['BU Head'],
  cat1: ['Category Head 1'],
  cat2: ['Category Head 2'],
  bizfin: ['BizFin Spoc', 'BizFin SPOC'],
  ioIncentive: ['IO Sign Off Incentive - If Applicable'],
  b0: ['a.Not Due'], b1: ['b.0-30'], b2: ['c.31-60'], b3: ['d.61-90'],
  b4: ['e.91-120'], b5: ['f.121-150'], b6: ['g.>151'],
  total: ['Total Receivables'],
  overdue: ['Total Overdue Receivables'],
  netPayable: ['Net Payable Balance'],
  possibleArAp: ['Possible AR AP', 'Possible AR AP - Overdue'],
  gt60: ['>60 days receivables'],
  possibleArAp60: ['Possible AR AP > 60 days'],
  remarks: ['Associate Remarks', 'Remarks'],
  tlRemarks: ['Team Lead Remarks'],
  red: ['Red'], yellow: ['Yellow'], green: ['Green']
};
var WB_STATUSES = ['PTP Pending', 'PTP Given', 'PTP Due Today', 'PTP Broken', 'Partially Paid', 'Paid',
  'Paid (PTP Kept)', 'Paid (after PTP)'];
var WB_BUCKETS = ['a.Not Due', 'b.0-30', 'c.31-60', 'd.61-90', 'e.91-120', 'f.121-150', 'g.>151'];

// ---------------------------------------------------------------------------
// Menu, triggers, setup
// ---------------------------------------------------------------------------

/** Installed as an installable onOpen trigger by WB_setup (so it never clashes with an existing onOpen). */
function WB_onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧾 AR Workbench')
    .addItem('Open my workbench (sidebar)', 'WB_openSidebar')
    .addItem('Open full-screen workbench', 'WB_openFullScreen')
    .addItem('Invoices of selected PAN', 'WB_openSelectedPan')
    .addSeparator()
    .addItem('Refresh invoice data now', 'WB_refreshNow')
    .addItem('Run daily maintenance now', 'WB_dailyMaintenance')
    .addSeparator()
    .addItem('Setup / repair (admin)', 'WB_setup')
    .addToUi();
}

function WB_setup() {
  var ss = SpreadsheetApp.getActive();
  wbEnsureLogSheet_(ss);
  wbEnsurePtpHeaders_(ss);
  var existing = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (existing.indexOf('WB_onOpen') < 0) {
    ScriptApp.newTrigger('WB_onOpen').forSpreadsheet(ss).onOpen().create();
  }
  if (existing.indexOf('WB_dailyMaintenance') < 0) {
    ScriptApp.newTrigger('WB_dailyMaintenance').timeBased().everyDays(1).atHour(7).create();
  }
  if (existing.indexOf('WB_refreshPtpStatuses') < 0) {
    ScriptApp.newTrigger('WB_refreshPtpStatuses').timeBased().everyHours(2).create();
  }
  WB_onOpen();
  try {
    SpreadsheetApp.getUi().alert('AR Workbench is ready.\n\nUse the "🧾 AR Workbench" menu to open your workbench.');
  } catch (e) { /* run from a trigger / editor without UI */ }
}

function WB_openSidebar() {
  var t = HtmlService.createTemplateFromFile('Workbench');
  t.mode = 'sidebar';
  t.startPan = '';
  SpreadsheetApp.getUi().showSidebar(t.evaluate().setTitle('AR Workbench'));
}

function WB_openFullScreen(pan) {
  var t = HtmlService.createTemplateFromFile('Workbench');
  t.mode = 'full';
  t.startPan = typeof pan === 'string' ? pan : '';
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(1280).setHeight(820), 'AR Workbench');
}

function WB_openSelectedPan() {
  var sel = wbGetSelection();
  if (!sel.pan) {
    SpreadsheetApp.getUi().alert('Select any cell on a PAN row in your tab, Consolidated or PTP Tracker first.');
    return;
  }
  WB_openFullScreen(sel.pan);
}

function WB_refreshNow() {
  wbOpenInvoices_(true);
  WB_refreshPtpStatuses();
  SpreadsheetApp.getActive().toast('Invoice data refreshed', 'AR Workbench', 4);
}

// ---------------------------------------------------------------------------
// Public API (called from the HTML via google.script.run)
// ---------------------------------------------------------------------------

function wbInit() {
  var ss = SpreadsheetApp.getActive();
  var associates = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  var props = PropertiesService.getUserProperties();
  var me = props.getProperty('wb_me') || '';
  var active = ss.getActiveSheet().getName();
  if (associates.indexOf(active) >= 0) me = active;
  if (associates.indexOf(me) < 0) me = '';
  return {
    me: me,
    associates: associates,
    today: wbKey_(new Date()),
    tz: ss.getSpreadsheetTimeZone(),
    dailyValues: WB.DAILY_VALUES,
    invoiceTags: WB.INVOICE_TAGS,
    user: wbUser_()
  };
}

function wbSetMe(name) {
  PropertiesService.getUserProperties().setProperty('wb_me', name || '');
  return true;
}

/** What PAN is the user pointing at in the grid? Used by the sidebar's "follow selection". */
function wbGetSelection() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getActiveSheet();
  var cell = sh.getActiveCell();
  var out = { sheet: sh.getName(), row: cell ? cell.getRow() : 0, pan: '' };
  if (!cell || out.row < 2) return out;
  var name = sh.getName();
  if (name === WB.SHEET_PTP) {
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var h = wbHeaderIndex_(hdr);
    var panCol = h['pan'];
    if (panCol !== undefined) out.pan = String(sh.getRange(out.row, panCol + 1).getValue() || '').trim();
    if (!out.pan) {
      var inv = String(sh.getRange(out.row, 1).getValue() || '').trim();
      var rec = wbInvoiceLookup_(inv);
      if (rec) out.pan = rec.pan;
    }
    return out;
  }
  if (name === WB.SHEET_CONSOLIDATED || wbIsAssociateSheet_(sh)) {
    if (out.row < 3) return out;
    out.pan = String(sh.getRange(out.row, 1).getValue() || '').trim();
  } else if (name === WB.SHEET_INV) {
    out.pan = String(sh.getRange(out.row, 1).getValue() || '').trim();
  }
  if (out.pan.length < 8 || /\s/.test(out.pan)) out.pan = ''; // headers, totals, blanks
  return out;
}

/** The associate's whole book: one row per PAN with ageing, flags, follow-up history and PTP roll-up. */
function wbGetBook(assoc) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(assoc);
  if (!sh) throw new Error('No tab named "' + assoc + '"');
  var book = wbReadAssocSheet_(sh);
  var today = wbKey_(new Date());
  var ptps = wbReadPtp_(ss).rows.filter(function (p) { return p.associate === assoc; });
  var byPan = {};
  ptps.forEach(function (p) {
    if (!p.pan) return;
    (byPan[p.pan] = byPan[p.pan] || []).push(p);
  });
  var nextFu = wbNextFollowUps_(ss, assoc);
  book.rows.forEach(function (r) {
    var list = byPan[r.pan] || [];
    r.ptpOpen = 0; r.ptpOpenAmt = 0; r.ptpBroken = 0; r.ptpNext = ''; r.ptpDueToday = 0;
    list.forEach(function (p) {
      if (!p.ptpDate || p.outstanding <= 0) return;
      r.ptpOpen++;
      r.ptpOpenAmt += p.ptpAmount || p.outstanding;
      if (p.ptpDate < today) r.ptpBroken++;
      else if (p.ptpDate === today) r.ptpDueToday++;
      if (p.ptpDate >= today && (!r.ptpNext || p.ptpDate < r.ptpNext)) r.ptpNext = p.ptpDate;
    });
    r.nextFollowUp = nextFu[r.pan] || '';
    r.priority = wbPriority_(r, today);
    delete r.daily; // keep the payload small; the 7-day strip is in r.recent
  });
  return { assoc: assoc, today: today, rows: book.rows, dates: book.dates };
}

/** Everything about one PAN: header, open invoices (+ PTP per invoice), recent paid invoices, activity history. */
function wbGetPan(assoc, pan) {
  var ss = SpreadsheetApp.getActive();
  pan = String(pan || '').trim();
  var header = null;
  var owner = assoc;
  var sh = assoc ? ss.getSheetByName(assoc) : null;
  if (sh) header = wbFindPanInAssocSheet_(sh, pan);
  if (!header) {
    // PAN belongs to someone else - find the owner through Consolidated.
    owner = wbOwnerOf_(ss, pan) || '';
    var osh = owner ? ss.getSheetByName(owner) : null;
    if (osh) header = wbFindPanInAssocSheet_(osh, pan);
  }
  var open = wbOpenInvoices_(false).byPan[pan] || [];
  var ptp = wbReadPtp_(ss);
  var ptpByInv = {};
  ptp.rows.forEach(function (p) { ptpByInv[p.invoice] = p; });
  var today = wbKey_(new Date());
  var invoices = open.map(function (inv) {
    var p = ptpByInv[inv.inv] || {};
    return {
      inv: inv.inv, invDate: inv.invDate, dueDate: inv.dueDate, credit: inv.credit,
      month: inv.month, brand: inv.brand, ageing: inv.ageing, bucket: inv.bucket,
      tds: inv.tds, receipt: inv.receipt, arap: inv.arap, net: inv.net,
      kam: inv.kam, kamMgr: inv.kamMgr,
      overdue: inv.bucket !== 'a.Not Due' && inv.dueDate && inv.dueDate < today,
      ptpDate: p.ptpDate || '', ptpAmount: p.ptpAmount || '', ptpStatus: p.status || '',
      ptpMode: p.mode || '', ptpContact: p.contact || '', ptpRemarks: p.remarks || '',
      tag: p.tag || '', inTracker: !!p.invoice
    };
  });
  invoices.sort(function (a, b) { return (b.ageing || 0) - (a.ageing || 0); });
  return {
    pan: pan,
    owner: owner,
    header: header,
    invoices: invoices,
    paid: wbRecentPaid_(ss, pan, 15),
    history: wbHistory_(ss, pan, 40),
    customer: (header && header.customer) || (open[0] && open[0].cust) || ''
  };
}

/**
 * Record a PTP against one or many invoices.
 * payload: {assoc, pan, invoices:[invNo], ptpDate:'yyyy-MM-dd', amounts:{inv:amt}, mode, contact, remarks, markDaily}
 */
function wbSavePtp(payload) {
  if (!payload || !payload.invoices || !payload.invoices.length) throw new Error('Select at least one invoice');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.ptpDate || '')) throw new Error('Pick a PTP date');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var open = wbOpenInvoices_(false).byInv;
    var now = new Date();
    var total = 0;
    var updates = payload.invoices.map(function (invNo) {
      var inv = open[invNo] || {};
      var amt = payload.amounts && payload.amounts[invNo] !== undefined && payload.amounts[invNo] !== ''
        ? Number(payload.amounts[invNo]) : (inv.net || '');
      total += Number(amt) || 0;
      return {
        invoice: invNo,
        defaults: {
          customer: inv.cust || '', brand: inv.brand || '', associate: payload.assoc,
          dueDate: inv.dueDate ? wbDate_(inv.dueDate) : '', added: inv.net || '', outstanding: inv.net || '',
          addedOn: wbDate_(wbKey_(now)), pan: payload.pan
        },
        set: {
          ptpDate: wbDate_(payload.ptpDate), ptpAmount: amt, mode: payload.mode || '',
          contact: payload.contact || '', remarks: payload.remarks || '',
          status: wbPtpStatus_(payload.ptpDate, inv.net, inv.net, ''),
          pan: payload.pan, updatedBy: wbUser_() || payload.assoc, updatedOn: now
        }
      };
    });
    wbUpsertPtp_(ss, updates);
    wbLog_(ss, {
      assoc: payload.assoc, pan: payload.pan, customer: payload.customer, type: 'PTP',
      outcome: 'PTP for ' + wbFmtDate_(payload.ptpDate), invoices: payload.invoices.join(', '),
      amount: total, next: payload.ptpDate, remarks: payload.remarks || ''
    });
    if (payload.markDaily !== false) wbMarkDaily_(ss, payload.assoc, payload.pan, 'PTP');
    if (payload.updateRemark !== false) {
      wbSetRemark_(ss, payload.assoc, payload.pan,
        'PTP ' + wbFmtDate_(payload.ptpDate) + ' for ' + payload.invoices.length + ' inv (' + wbInr_(total) + ')' +
        (payload.remarks ? ' - ' + payload.remarks : ''));
    }
    return { ok: true, count: payload.invoices.length, amount: total };
  } finally {
    lock.releaseLock();
  }
}

/** Tag invoices (dispute, AR-AP proposed, ...) or clear a PTP. payload: {assoc, pan, invoices, tag, clearPtp, remarks} */
function wbTagInvoices(payload) {
  if (!payload || !payload.invoices || !payload.invoices.length) throw new Error('Select at least one invoice');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var open = wbOpenInvoices_(false).byInv;
    var now = new Date();
    var updates = payload.invoices.map(function (invNo) {
      var inv = open[invNo] || {};
      var set = { updatedBy: wbUser_() || payload.assoc, updatedOn: now, pan: payload.pan };
      if (payload.tag !== undefined) set.tag = payload.tag;
      if (payload.clearPtp) { set.ptpDate = ''; set.ptpAmount = ''; set.status = 'PTP Pending'; set.days = ''; }
      if (payload.remarks) set.remarks = payload.remarks;
      return {
        invoice: invNo,
        defaults: {
          customer: inv.cust || '', brand: inv.brand || '', associate: payload.assoc,
          dueDate: inv.dueDate ? wbDate_(inv.dueDate) : '', added: inv.net || '', outstanding: inv.net || '',
          addedOn: wbDate_(wbKey_(now)), pan: payload.pan, status: 'PTP Pending'
        },
        set: set
      };
    });
    wbUpsertPtp_(ss, updates);
    var what = payload.clearPtp ? 'PTP cleared' : (payload.tag ? 'Tagged: ' + payload.tag : 'Tag removed');
    wbLog_(ss, {
      assoc: payload.assoc, pan: payload.pan, customer: payload.customer, type: 'Status',
      outcome: what, invoices: payload.invoices.join(', '), remarks: payload.remarks || ''
    });
    if (payload.tag === 'Expected Payment') wbMarkDaily_(ss, payload.assoc, payload.pan, 'Expected Payment');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Log a follow-up. payload: {assoc, pan, customer, channel, outcome, remarks, nextDate, daily, updateRemark}
 * daily = value for today's follow-up column (one of WB.DAILY_VALUES) or '' to leave it.
 */
function wbLogFollowUp(payload) {
  if (!payload || !payload.pan) throw new Error('No PAN');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    wbLog_(ss, {
      assoc: payload.assoc, pan: payload.pan, customer: payload.customer, type: payload.channel || 'Call',
      outcome: payload.outcome || '', next: payload.nextDate || '', remarks: payload.remarks || ''
    });
    var daily = payload.daily === undefined ? 'Yes' : payload.daily;
    if (daily) wbMarkDaily_(ss, payload.assoc, payload.pan, daily);
    if (payload.updateRemark !== false && (payload.remarks || payload.outcome)) {
      wbSetRemark_(ss, payload.assoc, payload.pan,
        [payload.outcome, payload.remarks].filter(String).join(' - ') +
        (payload.nextDate ? ' | next f/u ' + wbFmtDate_(payload.nextDate) : ''));
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Quick one-click daily status for many PANs at once (e.g. "Leave", "Holiday", "Yes"). */
function wbBulkDaily(assoc, pans, value) {
  if (WB.DAILY_VALUES.indexOf(value) < 0) throw new Error('Invalid status ' + value);
  var ss = SpreadsheetApp.getActive();
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    pans.forEach(function (p) { wbMarkDaily_(ss, assoc, p, value); });
    wbLog_(ss, { assoc: assoc, pan: pans.length === 1 ? pans[0] : '(' + pans.length + ' PANs)', type: 'Daily status',
      outcome: value, remarks: pans.length > 1 ? pans.join(', ') : '' });
    return { ok: true, count: pans.length };
  } finally {
    lock.releaseLock();
  }
}

/** Create a Gmail draft with the open-invoice statement for this PAN and log it as an e-mail follow-up. */
function wbCreateEmailDraft(payload) {
  var data = wbGetPan(payload.assoc, payload.pan);
  var list = data.invoices.filter(function (i) {
    return !payload.invoices || !payload.invoices.length || payload.invoices.indexOf(i.inv) >= 0;
  });
  if (!list.length) throw new Error('No open invoices to include');
  var total = list.reduce(function (s, i) { return s + (i.net || 0); }, 0);
  var rows = list.map(function (i) {
    return '<tr><td>' + wbEsc_(i.inv) + '</td><td>' + wbFmtDate_(i.invDate) + '</td><td>' + wbFmtDate_(i.dueDate) +
      '</td><td>' + wbEsc_(i.brand) + '</td><td style="text-align:right">' + (i.ageing || 0) +
      '</td><td style="text-align:right">' + wbInrFull_(i.net) + '</td></tr>';
  }).join('');
  var th = 'style="background:#f1f3f4;text-align:left;padding:6px;border:1px solid #ddd"';
  var html = '<p>Dear ' + wbEsc_(payload.contact || 'Team') + ',</p>' +
    '<p>Greetings from Zepto. As per our records, the following invoices for <b>' + wbEsc_(data.customer) +
    '</b> (PAN ' + wbEsc_(data.pan) + ') are outstanding. Total due: <b>' + wbInrFull_(total) + '</b>.</p>' +
    '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px" cellpadding="6" border="1">' +
    '<tr><th ' + th + '>Invoice No</th><th ' + th + '>Invoice Date</th><th ' + th + '>Due Date</th><th ' + th +
    '>Brand</th><th ' + th + '>Days</th><th ' + th + '>Amount (INR)</th></tr>' + rows +
    '<tr><td colspan="5"><b>Total</b></td><td style="text-align:right"><b>' + wbInrFull_(total) + '</b></td></tr></table>' +
    '<p>' + (payload.note ? wbEsc_(payload.note) : 'Request you to share the payment date / remittance details at the earliest.') + '</p>' +
    '<p>Regards,<br>' + wbEsc_(payload.assoc) + '<br>Accounts Receivable</p>';
  var subject = payload.subject || ('Payment reminder: ' + data.customer + ' - outstanding ' + wbInrFull_(total));
  var draft = GmailApp.createDraft(payload.to || '', subject, 'Please view this e-mail in HTML.', {
    htmlBody: html, cc: payload.cc || ''
  });
  var ss = SpreadsheetApp.getActive();
  wbLog_(ss, {
    assoc: payload.assoc, pan: payload.pan, customer: data.customer, type: 'Email',
    outcome: 'Reminder drafted (' + list.length + ' inv)', invoices: list.map(function (i) { return i.inv; }).join(', '),
    amount: total, remarks: payload.to ? 'To: ' + payload.to : ''
  });
  wbMarkDaily_(ss, payload.assoc, payload.pan, 'Yes');
  return { ok: true, draftId: draft.getId(), link: 'https://mail.google.com/mail/#drafts', count: list.length, total: total };
}

/** Jump the grid to the PAN's row in the owner's tab. */
function wbGoToRow(assoc, pan) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(assoc);
  if (!sh) return false;
  var f = sh.getRange(3, 1, Math.max(sh.getLastRow() - 2, 1), 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (!f) return false;
  ss.setActiveSheet(sh);
  sh.setActiveRange(sh.getRange(f.getRow(), 1));
  return true;
}

/** Save a free-text PAN remark straight into the Remarks column. */
function wbSaveRemark(assoc, pan, text) {
  var ss = SpreadsheetApp.getActive();
  wbSetRemark_(ss, assoc, pan, text, true);
  wbLog_(ss, { assoc: assoc, pan: pan, type: 'Note', outcome: 'Remark updated', remarks: text });
  return { ok: true };
}

/** All PTP Tracker rows owned by the associate, with live status. */
function wbGetPtps(assoc) {
  var ss = SpreadsheetApp.getActive();
  var today = wbKey_(new Date());
  var rows = wbReadPtp_(ss).rows.filter(function (p) {
    return p.associate === assoc && (p.ptpDate || p.tag || (p.status && p.status !== 'PTP Pending'));
  });
  rows.forEach(function (p) {
    p.live = wbPtpStatus_(p.ptpDate, p.outstanding, p.added, p.settlement);
    if (p.ptpDate && p.outstanding > 0) p.daysLate = p.ptpDate < today ? wbDiffDays_(p.ptpDate, today) : 0;
  });
  rows.sort(function (a, b) { return (a.ptpDate || '9999') < (b.ptpDate || '9999') ? -1 : 1; });
  return { today: today, rows: rows };
}

/** Productivity dashboard for one associate + team leaderboard. */
function wbGetProductivity(assoc) {
  var ss = SpreadsheetApp.getActive();
  var today = wbKey_(new Date());
  var monthStart = today.slice(0, 8) + '01';
  var weekStart = wbAddDays_(today, -((new Date(today + 'T00:00:00').getDay() + 6) % 7));
  var sheets = wbAssociateSheets_(ss);
  var team = [];
  var mine = null;
  sheets.forEach(function (sh) {
    var b = wbReadAssocSheet_(sh);
    var active = b.rows.filter(function (r) { return r.total !== 0 || r.overdue !== 0; });
    var cov = function (key) {
      var d = active.filter(function (r) { return r.daily[key]; }).length;
      return active.length ? d / active.length : 0;
    };
    var days = b.dates.filter(function (d) { return d >= monthStart && d <= today; });
    var mtdCov = days.length ? days.reduce(function (s, d) { return s + cov(d); }, 0) / days.length : 0;
    var entry = {
      assoc: sh.getName(), active: active.length, todayCov: cov(today), mtdCov: mtdCov,
      touchedToday: active.filter(function (r) { return r.daily[today]; }).length,
      untouched3: active.filter(function (r) { return r.daysSince === null || r.daysSince >= 3; }).length,
      overdue: active.reduce(function (s, r) { return s + r.overdue; }, 0),
      gt60: active.reduce(function (s, r) { return s + r.gt60; }, 0)
    };
    team.push(entry);
    if (sh.getName() === assoc) {
      mine = entry;
      mine.trend = b.dates.filter(function (d) { return d <= today && d >= wbAddDays_(today, -20); }).map(function (d) {
        var counts = {};
        active.forEach(function (r) { var v = r.daily[d]; if (v) counts[v] = (counts[v] || 0) + 1; });
        return { date: d, cov: cov(d), counts: counts };
      });
    }
  });
  // Activity log roll-up
  var log = wbReadLog_(ss);
  var acts = { today: {}, week: {}, month: {} };
  var teamActs = {};
  log.forEach(function (l) {
    if (l.date >= monthStart) teamActs[l.assoc] = (teamActs[l.assoc] || 0) + 1;
    if (l.assoc !== assoc) return;
    var t = l.type || 'Other';
    if (l.date === today) acts.today[t] = (acts.today[t] || 0) + 1;
    if (l.date >= weekStart) acts.week[t] = (acts.week[t] || 0) + 1;
    if (l.date >= monthStart) acts.month[t] = (acts.month[t] || 0) + 1;
  });
  team.forEach(function (t) { t.actsMtd = teamActs[t.assoc] || 0; });
  // PTP outcomes
  var ptp = wbReadPtp_(ss).rows.filter(function (p) { return p.associate === assoc && p.ptpDate; });
  var ptpStats = { given: 0, givenAmt: 0, kept: 0, keptAmt: 0, broken: 0, brokenAmt: 0, open: 0, openAmt: 0, partial: 0, missed: 0 };
  ptp.forEach(function (p) {
    var s = wbPtpStatus_(p.ptpDate, p.outstanding, p.added, p.settlement);
    var amt = Number(p.ptpAmount) || p.added || p.outstanding || 0;
    ptpStats.given++; ptpStats.givenAmt += amt;
    if (s === 'Paid (PTP Kept)') { ptpStats.kept++; ptpStats.keptAmt += amt; }
    else if (s === 'Paid (after PTP)') { ptpStats.missed++; ptpStats.keptAmt += amt; }
    else if (s === 'PTP Broken') { ptpStats.broken++; ptpStats.brokenAmt += p.outstanding; }
    else { ptpStats.open++; ptpStats.openAmt += p.outstanding; if (s === 'Partially Paid') ptpStats.partial++; }
  });
  var closed = ptpStats.kept + ptpStats.missed + ptpStats.broken;
  ptpStats.keptRate = closed ? ptpStats.kept / closed : null;
  team.sort(function (a, b) { return b.mtdCov - a.mtdCov; });
  return { today: today, mine: mine, acts: acts, ptp: ptpStats, team: team };
}

/** Force a cache rebuild (button in the UI). */
function wbRefresh() {
  var d = wbOpenInvoices_(true);
  return { ok: true, invoices: d.count, builtAt: d.builtAt };
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

/**
 * Daily (07:00):
 *  1. rebuild the open-invoice cache
 *  2. refresh PTP Tracker: PAN, current outstanding, settlement date, days vs PTP, status
 *     (and convert free-text statuses like "25th sep" into a real PTP date)
 *  3. add newly-overdue open invoices to PTP Tracker as "PTP Pending"
 *  4. auto-mark "Invoice Not Due" in today's column for PANs with nothing overdue (Improvement Point #29)
 */
function WB_dailyMaintenance() {
  var ss = SpreadsheetApp.getActive();
  wbOpenInvoices_(true);
  WB_refreshPtpStatuses(true);
  wbAutoNotDue_(ss);
}

function WB_refreshPtpStatuses(addMissing) {
  var ss = SpreadsheetApp.getActive();
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    wbEnsurePtpHeaders_(ss);
    var all = wbAllInvoiceIndex_(ss);
    var sh = ss.getSheetByName(WB.SHEET_PTP);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var H = wbPtpCols_(hdr);
    var data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
    var today = wbKey_(new Date());
    var seen = {};
    var year = Number(today.slice(0, 4));
    data.forEach(function (row) {
      var invNo = String(row[H.invoice] || '').trim();
      if (!invNo) return;
      seen[invNo] = true;
      var rec = all[invNo];
      if (rec) {
        if (H.pan !== undefined && !row[H.pan]) row[H.pan] = rec.pan;
        row[H.outstanding] = rec.net;
        if (rec.net <= 0 && !row[H.settlement]) row[H.settlement] = rec.receiptDate ? wbDate_(rec.receiptDate) : wbDate_(today);
      }
      var ptpKey = row[H.ptpDate] instanceof Date ? wbKey_(row[H.ptpDate]) : '';
      var st = String(row[H.status] || '');
      if (!ptpKey) {
        var parsed = wbParseLooseDate_(st, year);
        if (parsed) { ptpKey = parsed; row[H.ptpDate] = wbDate_(parsed); }
      }
      var settleKey = row[H.settlement] instanceof Date ? wbKey_(row[H.settlement]) : '';
      var outstanding = Number(row[H.outstanding]) || 0;
      var added = Number(row[H.added]) || outstanding;
      var next = st;
      if (ptpKey) {
        next = wbPtpStatus_(ptpKey, outstanding, added, settleKey);
        // Days vs PTP: positive = paid/unpaid that many days after the promise; blank while the promise is in the future.
        var ref = outstanding <= 0 ? (settleKey || today) : today;
        row[H.days] = ref >= ptpKey || outstanding <= 0 ? wbDiffDays_(ptpKey, ref) : '';
      } else if (outstanding <= 0 && rec) {
        next = 'Paid';
      } else if (!st) {
        next = 'PTP Pending';
      }
      if (next !== st) {
        // Keep anything an associate typed into Status (e.g. "Ar-ap recvd") in PTP Remarks.
        if (st && WB_STATUSES.indexOf(st) < 0 && H.remarks !== undefined && String(row[H.remarks]).indexOf(st) < 0) {
          row[H.remarks] = row[H.remarks] ? row[H.remarks] + ' | ' + st : st;
        }
        row[H.status] = next;
      }
    });
    if (data.length) sh.getRange(2, 1, data.length, lastCol).setValues(data);
    if (addMissing === true) {
      var owners = wbOwnerMap_(ss);
      var add = [];
      Object.keys(all).forEach(function (invNo) {
        var r = all[invNo];
        if (seen[invNo] || !(r.net > 0) || r.bucket === 'a.Not Due' || !r.bucket) return;
        var row = new Array(lastCol).fill('');
        row[H.invoice] = invNo; row[H.customer] = r.cust; row[H.brand] = r.brand;
        row[H.associate] = owners[r.pan] || r.assoc; row[H.dueDate] = r.dueDate ? wbDate_(r.dueDate) : '';
        row[H.added] = r.net; row[H.outstanding] = r.net; row[H.addedOn] = wbDate_(today);
        row[H.status] = 'PTP Pending';
        if (H.pan !== undefined) row[H.pan] = r.pan;
        add.push(row);
      });
      if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, lastCol).setValues(add);
    }
  } finally {
    lock.releaseLock();
  }
}

function wbAutoNotDue_(ss) {
  var today = wbKey_(new Date());
  wbAssociateSheets_(ss).forEach(function (sh) {
    var b = wbReadAssocSheet_(sh);
    var col = b.dateCols[today];
    if (!col) return;
    b.rows.forEach(function (r) {
      if (!r.daily[today] && r.overdue === 0 && r.b0 > 0) sh.getRange(r.row, col).setValue('Invoice Not Due');
    });
  });
}

// ---------------------------------------------------------------------------
// Internals: reading sheets
// ---------------------------------------------------------------------------

function wbIsAssociateSheet_(sh) {
  if (!sh || sh.getName() === WB.SHEET_CONSOLIDATED) return false;
  if (sh.getLastRow() < 2 || sh.getLastColumn() < 30) return false;
  var h = sh.getRange(2, 1, 1, 30).getValues()[0].map(wbNorm_);
  return h[0] === 'pan' && h.indexOf('total receivables') >= 0 && h.indexOf('team lead remarks') >= 0;
}

function wbAssociateSheets_(ss) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('wb_assoc_list');
  var sheets = ss.getSheets();
  if (hit) {
    var names = JSON.parse(hit);
    var list = names.map(function (n) { return ss.getSheetByName(n); }).filter(Boolean);
    if (list.length === names.length) return list;
  }
  var out = sheets.filter(function (s) { return !s.isSheetHidden() && wbIsAssociateSheet_(s); });
  cache.put('wb_assoc_list', JSON.stringify(out.map(function (s) { return s.getName(); })), 3600);
  return out;
}

function wbNorm_(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Map of logical field -> 0-based column index using WB_COLS aliases. */
function wbHeaderIndex_(hdr) {
  var norm = hdr.map(wbNorm_);
  var out = {};
  Object.keys(WB_COLS).forEach(function (k) {
    for (var i = 0; i < WB_COLS[k].length; i++) {
      var j = norm.indexOf(wbNorm_(WB_COLS[k][i]));
      if (j >= 0) { out[k] = j; break; }
    }
  });
  return out;
}

function wbReadAssocSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 3) return { rows: [], dates: [], dateCols: {} };
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var hdr = values[1];
  var H = wbHeaderIndex_(hdr);
  var dateCols = {};
  var dates = [];
  hdr.forEach(function (v, i) {
    if (v instanceof Date) { var k = wbKey_(v); dateCols[k] = i + 1; dates.push(k); }
  });
  var today = wbKey_(new Date());
  var pastDates = dates.filter(function (d) { return d <= today; }).sort().reverse();
  var num = function (row, k) { var v = H[k] === undefined ? 0 : row[H[k]]; return typeof v === 'number' ? v : Number(v) || 0; };
  var str = function (row, k) { var v = H[k] === undefined ? '' : row[H[k]]; return v === null || v === undefined ? '' : String(v); };
  var rows = [];
  for (var r = 2; r < values.length; r++) {
    var row = values[r];
    var pan = String(row[0] || '').trim();
    if (!pan) continue;
    var daily = {};
    dates.forEach(function (d) { var v = row[dateCols[d] - 1]; if (v !== '' && v !== null) daily[d] = String(v); });
    var last = '';
    for (var i = 0; i < pastDates.length; i++) {
      var dv = daily[pastDates[i]];
      if (dv && dv !== 'No' && dv !== 'Leave' && dv !== 'Holiday') { last = pastDates[i]; break; }
    }
    rows.push({
      row: r + 1, pan: pan,
      customer: str(row, 'customer'), brands: str(row, 'brands'), months: str(row, 'months'),
      kamMgr: str(row, 'kamMgr'), kams: str(row, 'kams'), bizModel: str(row, 'bizModel'),
      arApHist: str(row, 'arApHist'), exposure: str(row, 'exposure'), poe: str(row, 'poe'),
      buHead: str(row, 'buHead'), cat1: str(row, 'cat1'), cat2: str(row, 'cat2'), bizfin: str(row, 'bizfin'),
      ioIncentive: str(row, 'ioIncentive'),
      b0: num(row, 'b0'), b1: num(row, 'b1'), b2: num(row, 'b2'), b3: num(row, 'b3'),
      b4: num(row, 'b4'), b5: num(row, 'b5'), b6: num(row, 'b6'),
      total: num(row, 'total'), overdue: num(row, 'overdue'), netPayable: num(row, 'netPayable'),
      possibleArAp: num(row, 'possibleArAp'), gt60: num(row, 'gt60'), possibleArAp60: num(row, 'possibleArAp60'),
      remarks: str(row, 'remarks'), tlRemarks: str(row, 'tlRemarks'),
      today: daily[today] || '', lastTouch: last,
      daysSince: last ? wbDiffDays_(last, today) : null,
      mtdTouches: Object.keys(daily).filter(function (d) {
        return d.slice(0, 7) === today.slice(0, 7) && d <= today && daily[d] !== 'No';
      }).length,
      recent: pastDates.slice(0, 7).map(function (d) { return daily[d] || ''; }),
      daily: daily
    });
  }
  return { rows: rows, dates: dates, dateCols: dateCols, H: H };
}

function wbFindPanInAssocSheet_(sh, pan) {
  var b = wbReadAssocSheet_(sh);
  for (var i = 0; i < b.rows.length; i++) {
    if (b.rows[i].pan === pan) {
      var r = b.rows[i];
      r.owner = sh.getName();
      r.recentDates = b.dates.filter(function (d) { return d <= wbKey_(new Date()); }).sort().reverse().slice(0, 14);
      return r;
    }
  }
  return null;
}

function wbOwnerMap_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_CONSOLIDATED);
  var out = {};
  if (!sh || sh.getLastRow() < 3) return out;
  var v = sh.getRange(3, 1, sh.getLastRow() - 2, 3).getValues();
  v.forEach(function (r) { if (r[0]) out[String(r[0]).trim()] = String(r[2] || '').trim(); });
  return out;
}

function wbOwnerOf_(ss, pan) {
  var owner = wbOwnerMap_(ss)[pan];
  if (owner && ss.getSheetByName(owner)) return owner;
  var found = '';
  wbAssociateSheets_(ss).some(function (sh) {
    var f = sh.getRange(3, 1, Math.max(sh.getLastRow() - 2, 1), 1).createTextFinder(pan).matchEntireCell(true).findNext();
    if (f) { found = sh.getName(); return true; }
    return false;
  });
  return found;
}

/** Imported_Data column map (header row detected by the "PAN #" cell). */
function wbInvSheet_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_INV);
  if (!sh) throw new Error('Tab "' + WB.SHEET_INV + '" not found');
  var top = sh.getRange(1, 1, Math.min(10, sh.getLastRow()), Math.min(sh.getLastColumn(), 40)).getValues();
  var hdrRow = -1;
  for (var i = 0; i < top.length; i++) { if (wbNorm_(top[i][0]) === 'pan #' || wbNorm_(top[i][0]) === 'pan') { hdrRow = i; break; } }
  if (hdrRow < 0) throw new Error('Could not find the header row (PAN #) in ' + WB.SHEET_INV);
  var norm = top[hdrRow].map(wbNorm_);
  var idx = function (names) {
    for (var k = 0; k < names.length; k++) { var j = norm.indexOf(wbNorm_(names[k])); if (j >= 0) return j; }
    return -1;
  };
  var C = {
    pan: idx(['PAN #', 'PAN']), month: idx(['Revised Activity month']), invDate: idx(['Invoice Date']),
    dueDate: idx(['Due Date']), credit: idx(['Credit Period']), inv: idx(['Invoice no', 'Invoice No']),
    cust: idx(['Customer Name']), kam: idx(['KAM']), kamMgr: idx(['KAM Manager']), assoc: idx(['Associate']),
    tds: idx(['TDS Amount']), receipt: idx(['Receipt']), receiptDate: idx(['Receipt Date']),
    arap: idx(['AR AP adjustment']), net: idx(['Net to be received']), brand: idx(['Brand']),
    ageing: idx(['Ageing in Days']), bucket: idx(['Ageing Bucket'])
  };
  var width = 0;
  Object.keys(C).forEach(function (k) { width = Math.max(width, C[k] + 1); });
  return { sh: sh, first: hdrRow + 2, C: C, width: width };
}

function wbInvRecord_(row, C) {
  var d = function (v) { return v instanceof Date ? wbKey_(v) : ''; };
  var n = function (v) { return typeof v === 'number' ? v : Number(v) || 0; };
  var s = function (v) { return v === null || v === undefined ? '' : String(v).trim(); };
  return {
    pan: s(row[C.pan]), month: s(row[C.month]), invDate: d(row[C.invDate]), dueDate: d(row[C.dueDate]),
    credit: n(row[C.credit]), inv: s(row[C.inv]), cust: s(row[C.cust]), kam: s(row[C.kam]),
    kamMgr: s(row[C.kamMgr]), assoc: s(row[C.assoc]), tds: n(row[C.tds]), receipt: n(row[C.receipt]),
    receiptDate: d(row[C.receiptDate]), arap: n(row[C.arap]), net: n(row[C.net]), brand: s(row[C.brand]),
    ageing: n(row[C.ageing]), bucket: s(row[C.bucket])
  };
}

/**
 * Open invoices (Net to be received != 0) indexed by PAN and invoice no.
 * Imported_Data is ~80k rows but only a few thousand are open, so the open set is cached
 * (chunked, shared by all users) and rebuilt when the sheet's row count changes or every 6 h.
 */
function wbOpenInvoices_(force) {
  var ss = SpreadsheetApp.getActive();
  var inv = wbInvSheet_(ss);
  var lastRow = inv.sh.getLastRow();
  var cache = CacheService.getScriptCache();
  var metaRaw = force ? null : cache.get(WB.CACHE_PREFIX + 'meta');
  var list = null;
  var builtAt = '';
  if (metaRaw) {
    var meta = JSON.parse(metaRaw);
    if (meta.lastRow === lastRow) {
      var keys = [];
      for (var i = 0; i < meta.chunks; i++) keys.push(WB.CACHE_PREFIX + i);
      var got = cache.getAll(keys);
      if (keys.every(function (k) { return got[k] !== undefined && got[k] !== null; })) {
        list = JSON.parse(keys.map(function (k) { return got[k]; }).join(''));
        builtAt = meta.builtAt;
      }
    }
  }
  if (!list) {
    var values = inv.sh.getRange(inv.first, 1, lastRow - inv.first + 1, inv.width).getValues();
    list = [];
    values.forEach(function (row) {
      var net = row[inv.C.net];
      if (!row[inv.C.inv] || !net || Number(net) === 0) return;
      var r = wbInvRecord_(row, inv.C);
      // Compact array form keeps the cache small.
      list.push([r.pan, r.month, r.invDate, r.dueDate, r.credit, r.inv, r.cust, r.kam, r.kamMgr, r.assoc,
        r.tds, r.receipt, r.receiptDate, r.arap, r.net, r.brand, r.ageing, r.bucket]);
    });
    var json = JSON.stringify(list);
    var size = 90000;
    var put = {};
    var n = Math.ceil(json.length / size);
    for (var c = 0; c < n; c++) put[WB.CACHE_PREFIX + c] = json.substr(c * size, size);
    builtAt = new Date().toISOString();
    put[WB.CACHE_PREFIX + 'meta'] = JSON.stringify({ lastRow: lastRow, chunks: n, builtAt: builtAt });
    try { cache.putAll(put, WB.CACHE_TTL); } catch (e) { /* cache full / too big: fall back to no cache */ }
  }
  var fields = ['pan', 'month', 'invDate', 'dueDate', 'credit', 'inv', 'cust', 'kam', 'kamMgr', 'assoc',
    'tds', 'receipt', 'receiptDate', 'arap', 'net', 'brand', 'ageing', 'bucket'];
  var byPan = {};
  var byInv = {};
  list.forEach(function (a) {
    var o = {};
    fields.forEach(function (f, i) { o[f] = a[i]; });
    (byPan[o.pan] = byPan[o.pan] || []).push(o);
    byInv[o.inv] = o;
  });
  return { byPan: byPan, byInv: byInv, count: list.length, builtAt: builtAt };
}

/** Every invoice (open + settled) keyed by invoice no - used by the scheduled PTP refresh only. */
function wbAllInvoiceIndex_(ss) {
  var inv = wbInvSheet_(ss);
  var lastRow = inv.sh.getLastRow();
  var values = inv.sh.getRange(inv.first, 1, lastRow - inv.first + 1, inv.width).getValues();
  var out = {};
  values.forEach(function (row) {
    var no = row[inv.C.inv];
    if (!no) return;
    out[String(no).trim()] = wbInvRecord_(row, inv.C);
  });
  return out;
}

function wbInvoiceLookup_(invNo) {
  if (!invNo) return null;
  var open = wbOpenInvoices_(false).byInv[invNo];
  if (open) return open;
  var ss = SpreadsheetApp.getActive();
  var inv = wbInvSheet_(ss);
  var f = inv.sh.getRange(inv.first, inv.C.inv + 1, inv.sh.getLastRow() - inv.first + 1, 1)
    .createTextFinder(invNo).matchEntireCell(true).findNext();
  if (!f) return null;
  return wbInvRecord_(inv.sh.getRange(f.getRow(), 1, 1, inv.width).getValues()[0], inv.C);
}

/** Latest settled invoices for the PAN (TextFinder keeps this cheap on 80k rows). */
function wbRecentPaid_(ss, pan, limit) {
  var inv = wbInvSheet_(ss);
  var cells = inv.sh.getRange(inv.first, inv.C.pan + 1, inv.sh.getLastRow() - inv.first + 1, 1)
    .createTextFinder(pan).matchEntireCell(true).findAll();
  var rows = cells.map(function (c) { return c.getRow(); }).sort(function (a, b) { return b - a; });
  var out = [];
  // Rows are appended chronologically, so walk from the bottom in small blocks.
  for (var i = 0; i < rows.length && out.length < limit && i < limit * 4; i++) {
    var rec = wbInvRecord_(inv.sh.getRange(rows[i], 1, 1, inv.width).getValues()[0], inv.C);
    if (rec.net === 0 && rec.inv) out.push(rec);
  }
  return out;
}

function wbPtpCols_(hdr) {
  var norm = hdr.map(wbNorm_);
  var find = function (n) { var i = norm.indexOf(wbNorm_(n)); return i < 0 ? undefined : i; };
  return {
    invoice: find('Invoice No'), customer: find('Customer Name'), brand: find('Brand'), associate: find('Associate'),
    dueDate: find('Due Date'), added: find('Outstanding When Added'), outstanding: find('Current Outstanding'),
    addedOn: find('Added On'), ptpDate: find('PTP Date'), settlement: find('Settlement Date'),
    days: find('Days vs PTP'), status: find('Status'),
    pan: find('PAN'), ptpAmount: find('PTP Amount'), mode: find('Payment Mode'), contact: find('Contact Person'),
    remarks: find('PTP Remarks'), tag: find('Invoice Tag'), updatedBy: find('Updated By'), updatedOn: find('Updated On')
  };
}

function wbEnsurePtpHeaders_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_PTP);
  if (!sh) {
    sh = ss.insertSheet(WB.SHEET_PTP);
    sh.getRange(1, 1, 1, 12).setValues([['Invoice No', 'Customer Name', 'Brand', 'Associate', 'Due Date',
      'Outstanding When Added', 'Current Outstanding', 'Added On', 'PTP Date', 'Settlement Date', 'Days vs PTP', 'Status']]);
  }
  var lastCol = Math.max(sh.getLastColumn(), 12);
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var norm = hdr.map(wbNorm_);
  var missing = WB.PTP_EXTRA_HEADERS.filter(function (h) { return norm.indexOf(wbNorm_(h)) < 0; });
  if (missing.length) {
    var start = lastCol + 1;
    while (start > 1 && !hdr[start - 2]) start--; // first empty header column
    sh.getRange(1, start, 1, missing.length).setValues([missing])
      .setFontWeight('bold').setBackground('#e8f0fe');
  }
  return sh;
}

function wbReadPtp_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_PTP);
  if (!sh || sh.getLastRow() < 2) return { rows: [], H: {} };
  var lastCol = sh.getLastColumn();
  var values = sh.getRange(1, 1, sh.getLastRow(), lastCol).getValues();
  var H = wbPtpCols_(values[0]);
  var g = function (row, k) { return H[k] === undefined ? '' : row[H[k]]; };
  var dk = function (v) { return v instanceof Date ? wbKey_(v) : ''; };
  var openByInv = null; // lazily used for rows added before the PAN column existed
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var inv = String(g(row, 'invoice') || '').trim();
    if (!inv) continue;
    rows.push({
      row: i + 1, invoice: inv, customer: String(g(row, 'customer') || ''), brand: String(g(row, 'brand') || ''),
      associate: String(g(row, 'associate') || '').trim(), dueDate: dk(g(row, 'dueDate')),
      added: Number(g(row, 'added')) || 0, outstanding: Number(g(row, 'outstanding')) || 0,
      addedOn: dk(g(row, 'addedOn')), ptpDate: dk(g(row, 'ptpDate')), settlement: dk(g(row, 'settlement')),
      status: String(g(row, 'status') || ''),
      pan: String(g(row, 'pan') || '').trim() ||
        ((openByInv = openByInv || wbOpenInvoices_(false).byInv)[inv] || {}).pan || '',
      ptpAmount: g(row, 'ptpAmount') === '' ? '' : Number(g(row, 'ptpAmount')),
      mode: String(g(row, 'mode') || ''), contact: String(g(row, 'contact') || ''),
      remarks: String(g(row, 'remarks') || ''), tag: String(g(row, 'tag') || ''),
      updatedBy: String(g(row, 'updatedBy') || ''),
      updatedOn: g(row, 'updatedOn') instanceof Date ? g(row, 'updatedOn').toISOString() : ''
    });
  }
  return { rows: rows, H: H };
}

/** Upsert rows in PTP Tracker by invoice number. updates: [{invoice, defaults:{...}, set:{...}}] */
function wbUpsertPtp_(ss, updates) {
  var sh = wbEnsurePtpHeaders_(ss);
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var H = wbPtpCols_(hdr);
  var lastRow = sh.getLastRow();
  var invCol = lastRow > 1 ? sh.getRange(2, H.invoice + 1, lastRow - 1, 1).getValues() : [];
  var rowOf = {};
  invCol.forEach(function (r, i) { var k = String(r[0] || '').trim(); if (k) rowOf[k] = i + 2; });
  var appends = [];
  updates.forEach(function (u) {
    var r = rowOf[u.invoice];
    if (r) {
      var cur = sh.getRange(r, 1, 1, lastCol).getValues()[0];
      Object.keys(u.set).forEach(function (k) { if (H[k] !== undefined) cur[H[k]] = u.set[k]; });
      if (H.pan !== undefined && !cur[H.pan] && u.defaults.pan) cur[H.pan] = u.defaults.pan;
      if (u.set.ptpDate && H.days !== undefined) cur[H.days] = '';
      sh.getRange(r, 1, 1, lastCol).setValues([cur]);
    } else {
      var row = new Array(lastCol).fill('');
      row[H.invoice] = u.invoice;
      Object.keys(u.defaults).forEach(function (k) { if (H[k] !== undefined) row[H[k]] = u.defaults[k]; });
      Object.keys(u.set).forEach(function (k) { if (H[k] !== undefined) row[H[k]] = u.set[k]; });
      appends.push(row);
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, lastCol).setValues(appends);
}

function wbPtpStatus_(ptpKey, outstanding, added, settleKey) {
  var today = wbKey_(new Date());
  var out = Number(outstanding);
  var known = outstanding !== '' && outstanding !== null && outstanding !== undefined && !isNaN(out);
  if (!ptpKey) return known && out <= 0 ? 'Paid' : 'PTP Pending';
  if (known && out <= 0) return (settleKey || today) <= ptpKey ? 'Paid (PTP Kept)' : 'Paid (after PTP)';
  if (ptpKey < today) return 'PTP Broken';
  if (known && added && out < Number(added)) return 'Partially Paid';
  if (ptpKey === today) return 'PTP Due Today';
  return 'PTP Given';
}

function wbPriority_(r, today) {
  // Higher = work first. Money at risk (log scale) + staleness + promises gone wrong + flags.
  var s = 0;
  s += r.overdue > 0 ? Math.log10(r.overdue + 1) * 10 : 0;
  s += r.gt60 > 0 ? Math.log10(r.gt60 + 1) * 6 : 0;
  s += r.daysSince === null ? 25 : Math.min(r.daysSince, 10) * 3;
  s += r.ptpBroken * 20 + r.ptpDueToday * 15;
  if (r.exposure === 'Yes') s += 10;
  if (r.possibleArAp > 0) s += 5;
  if (r.today) s -= 40;
  if (r.nextFollowUp && r.nextFollowUp <= today) s += 15;
  return Math.round(s);
}

// ---------------------------------------------------------------------------
// Internals: writing
// ---------------------------------------------------------------------------

function wbEnsureLogSheet_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_LOG);
  if (!sh) {
    sh = ss.insertSheet(WB.SHEET_LOG);
    sh.getRange(1, 1, 1, WB.LOG_HEADERS.length).setValues([WB.LOG_HEADERS])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
  }
  return sh;
}

function wbLog_(ss, e) {
  var sh = wbEnsureLogSheet_(ss);
  var now = new Date();
  sh.appendRow([now, wbDate_(wbKey_(now)), e.assoc || '', e.pan || '', e.customer || '', e.type || '', e.outcome || '',
    e.invoices || '', e.amount || '', e.next ? wbDate_(e.next) : '', e.remarks || '', wbUser_()]);
}

function wbReadLog_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, WB.LOG_HEADERS.length).getValues().map(function (r) {
    return {
      ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), date: r[1] instanceof Date ? wbKey_(r[1]) : '',
      assoc: String(r[2]), pan: String(r[3]), customer: String(r[4]), type: String(r[5]), outcome: String(r[6]),
      invoices: String(r[7]), amount: r[8], next: r[9] instanceof Date ? wbKey_(r[9]) : '', remarks: String(r[10]),
      user: String(r[11])
    };
  });
}

function wbHistory_(ss, pan, limit) {
  return wbReadLog_(ss).filter(function (l) { return l.pan === pan; }).reverse().slice(0, limit);
}

/** Latest "next follow-up" date per PAN for the associate (only future/today or overdue, not superseded). */
function wbNextFollowUps_(ss, assoc) {
  var out = {};
  wbReadLog_(ss).forEach(function (l) {
    if (l.assoc !== assoc || !l.pan) return;
    if (l.type === 'PTP') return; // PTP dates are tracked separately
    out[l.pan] = l.next || '';     // later entries override earlier ones
  });
  return out;
}

function wbMarkDaily_(ss, assoc, pan, value) {
  if (WB.DAILY_VALUES.indexOf(value) < 0) return false;
  var sh = ss.getSheetByName(assoc);
  if (!sh) return false;
  var hdr = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  var today = wbKey_(new Date());
  var col = -1;
  hdr.forEach(function (v, i) { if (v instanceof Date && wbKey_(v) === today) col = i + 1; });
  if (col < 0) return false;
  var f = sh.getRange(3, 1, Math.max(sh.getLastRow() - 2, 1), 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (!f) return false;
  var cell = sh.getRange(f.getRow(), col);
  var cur = String(cell.getValue() || '');
  // Never downgrade a richer status (PTP / Expected Payment) to a plain "Yes" on the same day.
  var rank = { '': 0, 'No': 0, 'Invoice Not Due': 1, 'Yes': 2, 'Expected Payment': 3, 'PTP': 4, 'Leave': 5, 'Holiday': 5 };
  if ((rank[value] || 0) >= (rank[cur] || 0) || value === 'Leave' || value === 'Holiday') cell.setValue(value);
  return true;
}

function wbSetRemark_(ss, assoc, pan, text, raw) {
  var sh = ss.getSheetByName(assoc);
  if (!sh) return false;
  var hdr = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  var H = wbHeaderIndex_(hdr);
  if (H.remarks === undefined) return false;
  var f = sh.getRange(3, 1, Math.max(sh.getLastRow() - 2, 1), 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (!f) return false;
  var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'dd-MMM');
  sh.getRange(f.getRow(), H.remarks + 1).setValue(raw ? text : stamp + ': ' + text);
  return true;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function wbTz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }
function wbKey_(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return Utilities.formatDate(d, wbTz_(), 'yyyy-MM-dd');
}
/** yyyy-MM-dd -> Date at local midnight of the spreadsheet (what Sheets shows as that date). */
function wbDate_(key) {
  var p = key.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function wbAddDays_(key, n) {
  var d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function wbDiffDays_(a, b) {
  var t = function (k) { return Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); };
  return Math.round((t(b) - t(a)) / 86400000);
}
function wbFmtDate_(key) {
  if (!key) return '';
  var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return key.slice(8, 10) + '-' + m[+key.slice(5, 7) - 1] + '-' + key.slice(2, 4);
}
function wbParseLooseDate_(s, year) {
  var m = /^\s*(\d{1,2})\s*(st|nd|rd|th)?[\s\-\/]*([a-z]{3})[a-z]*\.?\s*$/i.exec(s || '');
  if (!m) return '';
  var mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[3].toLowerCase());
  if (mon < 0) return '';
  var dd = ('0' + m[1]).slice(-2);
  var mm = ('0' + (mon + 1)).slice(-2);
  return year + '-' + mm + '-' + dd;
}
function wbInr_(n) {
  n = Number(n) || 0;
  var a = Math.abs(n);
  var s = a >= 1e7 ? (a / 1e7).toFixed(2) + ' Cr' : a >= 1e5 ? (a / 1e5).toFixed(2) + ' L' : Math.round(a).toLocaleString('en-IN');
  return (n < 0 ? '-' : '') + '₹' + s;
}
function wbInrFull_(n) {
  n = Math.round(Number(n) || 0);
  var s = String(Math.abs(n));
  var last3 = s.slice(-3);
  var rest = s.slice(0, -3);
  if (rest) last3 = ',' + last3;
  return (n < 0 ? '-' : '') + '₹' + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
}
function wbEsc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function wbUser_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
