/**
 * AR Workbench v2
 * ---------------
 * One Apps Script add-on for the "Associate Level Ageing Master - AR" Google Sheet. It is the associate's
 * personal workbench, the team lead's review desk and management's command center, all inside the live
 * sheet. The input tabs (Imported_Data, Payable Data - Daily, mappings, lists) stay exactly as they are.
 *
 *   Associate   Today queue · PAN book · PAN drill-down (open invoices, copy-ready mail table, PTP per invoice
 *               or for the whole PAN, IO sign-off, R/A/G, remarks, payables & AR-AP, history) · PTPs ·
 *               IO sign-offs · Productivity
 *   Team lead   + Team review (per-associate KPIs, review queues, team lead remarks, reassign PANs)
 *   Management  + Overview (portfolio, ageing, confidence, IO, trend, breakdowns, top PANs, data health checks)
 *
 * The script writes only to:
 *   - associate tabs:          PAN (reassign), POE Required ?, Remarks, Team Lead Remarks, Red / Yellow / Green,
 *                              today's daily follow-up cell
 *   - Consolidated:            Associate Name (reassign only)
 *   - PTP Tracker:             upsert by Invoice No; extra columns appended on the right
 *   - IO Sign Off Rate Card:   IO Sign off Link, Remarks, IO Signed Brand PDF + "IO Signed On", "IO Updated By"
 *   - new tabs:                WB Activity Log, WB Settings, WB Snapshots
 *
 * Run WB_setup() once from the Apps Script editor. It creates the new tabs and installs the triggers.
 */

var WB = {
  VERSION: '2.0',
  SHEET_CONSOLIDATED: 'Consolidated',
  SHEET_SUMMARY: 'Summary',
  SHEET_PTP: 'PTP Tracker',
  SHEET_INV: 'Imported_Data',
  SHEET_IO: 'IO Sign Off Rate Card',
  SHEET_PAY: 'Payable Data - Daily',
  SHEET_LOG: 'WB Activity Log',
  SHEET_SETTINGS: 'WB Settings',
  SHEET_SNAP: 'WB Snapshots',
  // Values allowed by the existing data validation on the daily follow-up columns.
  DAILY_VALUES: ['Yes', 'No', 'Leave', 'Holiday', 'Invoice Not Due', 'PTP', 'Expected Payment'],
  TOUCHED: ['Yes', 'PTP', 'Expected Payment'],
  INVOICE_TAGS: ['', 'Disputed', 'AR-AP Proposed', 'AR-AP Approved', 'Expected Payment', 'Awaiting POE',
    'Awaiting Reco / Remittance', 'Credit Note Requested', 'Escalated to KAM', 'Legal'],
  PTP_EXTRA_HEADERS: ['PAN', 'PTP Amount', 'Payment Mode', 'Contact Person', 'PTP Remarks',
    'Invoice Tag', 'Updated By', 'Updated On'],
  IO_EXTRA_HEADERS: ['IO Signed On', 'IO Updated By'],
  LOG_HEADERS: ['Timestamp', 'Date', 'Associate', 'PAN', 'Customer', 'Type', 'Outcome',
    'Invoices', 'Amount', 'Next Follow-up', 'Remarks', 'User'],
  SNAP_HEADERS: ['Date', 'Associate', 'Active PANs', 'Total Receivables', 'Overdue', '>60 days', 'Net Payable',
    'Possible AR AP', 'PANs Touched', 'Coverage %', 'Not Followed Up', 'Open PTPs', 'PTP Amount', 'Broken PTPs',
    'IO Signed', 'IO Pending', 'Activities', 'Red', 'Yellow', 'Green'],
  TEAM_HEADERS: ['Name', 'Role', 'Team Lead', 'Email', 'Active'],
  SETTING_HEADERS: ['Setting', 'Value', 'What it does'],
  ROLES: ['Associate', 'Team Lead', 'Management', 'Admin'],
  CACHE_PREFIX: 'wb_open_v3_',
  BOOK_PREFIX: 'wb_book_v3_',
  CACHE_TTL: 21600, // 6 h, the CacheService maximum
  BOOK_TTL: 1800    // team / overview views may be up to 30 min old (own book is always read live)
};

var WB_SETTINGS_DEFAULTS = [
  ['WINDOW_SIZE', '1280x780', 'Width x height (px) of the workbench window. Make it smaller on small laptops (e.g. 1100x680).'],
  ['STALE_DAYS', '3', 'A PAN with overdue and no follow-up (Yes / PTP / Expected Payment) for this many working days is "not followed up".'],
  ['COVERAGE_TARGET', '80', 'Daily coverage goal in % (PANs with a balance touched today). Drives the ring on Today.'],
  ['WORK_WEEK', 'Mon-Sat', 'Mon-Sat or Mon-Fri. Used for the "not followed up" check and coverage averages.'],
  ['EMAIL_SIGNATURE', 'Accounts Receivable', 'Line under the associate name in reminder mails.'],
  ['KAM_EMAIL_DOMAIN', '', 'KAM names in Imported_Data look like e-mail user names (Ishan.Chawla). Put your mail domain here (e.g. company.com) to offer "CC KAMs" on mails.'],
  ['RESTRICT_VIEWS', 'No', 'Yes = associates only see their own PANs and team leads only their team.'],
  ['AUTO_NOT_DUE', 'Yes', 'Daily 07:00 job writes "Invoice Not Due" in today\'s column for PANs with nothing overdue (blank cells only).'],
  ['ADD_OVERDUE_TO_PTP', 'Yes', 'Daily 07:00 job adds newly overdue invoices to PTP Tracker as "PTP Pending".']
];

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
// Book rows are cached as arrays in this field order (keeps the cache small).
var WB_BOOK_FIELDS = ['row', 'pan', 'customer', 'brands', 'months', 'kamMgr', 'kams', 'bizModel', 'arApHist', 'exposure',
  'poe', 'buHead', 'cat1', 'cat2', 'bizfin', 'ioIncentive', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'total', 'overdue',
  'netPayable', 'possibleArAp', 'gt60', 'possibleArAp60', 'remarks', 'tlRemarks', 'red', 'yellow', 'green', 'today',
  'lastTouch', 'mtdTouches', 'recent', 'stale'];
var WB_OPEN_FIELDS = ['pan', 'month', 'invDate', 'dueDate', 'credit', 'inv', 'cust', 'kam', 'kamMgr', 'assoc',
  'tds', 'receipt', 'receiptDate', 'arap', 'net', 'brand', 'ageing', 'bucket'];

// ---------------------------------------------------------------------------
// Menu, triggers, setup
// ---------------------------------------------------------------------------

/** Installed as an installable onOpen trigger by WB_setup (so it never clashes with an existing onOpen). */
function WB_onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧾 AR Workbench')
    .addItem('Open workbench (large window)', 'WB_openWindow')
    .addItem('Open compact side panel', 'WB_openSidebar')
    .addItem('Open selected PAN', 'WB_openSelectedPan')
    .addSeparator()
    .addItem('Refresh data now', 'WB_refreshNow')
    .addItem('Run daily maintenance now', 'WB_dailyMaintenance')
    .addItem('Take snapshot now', 'WB_nightlySnapshot')
    .addSeparator()
    .addItem('Check speed (admin)', 'WB_checkSpeed')
    .addItem('Setup / repair (admin)', 'WB_setup')
    .addToUi();
}

function WB_setup() {
  var ss = SpreadsheetApp.getActive();
  wbEnsureLogSheet_(ss);
  wbEnsurePtpHeaders_(ss);
  wbEnsureIoHeaders_(ss);
  wbEnsureSettingsSheet_(ss);
  wbEnsureSnapSheet_(ss);
  var trig = wbInstallTriggers_(ss);
  wbClearCaches_();
  WB_onOpen();
  // Prepare the shared caches now, so the first person to open the workbench doesn't wait for 66k invoice rows.
  var warm = '';
  try { var t0 = Date.now(); WB_warmCaches(); warm = 'Data prepared in ' + Math.round((Date.now() - t0) / 1000) + ' s.\n\n'; }
  catch (e) { warm = 'Could not prepare the data yet (' + e.message + '). The hourly job will retry.\n\n'; }
  trig.note = warm + trig.note;
  try {
    SpreadsheetApp.getUi().alert('AR Workbench ' + WB.VERSION + ' is ready.\n\n' + trig.note +
      '1. Fill in roles and e-mails on the "' + WB.SHEET_SETTINGS + '" tab (team leads, management).\n' +
      '2. Use the "🧾 AR Workbench" menu to open the workbench.');
  } catch (e) { /* run from a trigger / editor without UI */ }
}

/**
 * Only two triggers: the open menu and ONE hourly job that does everything scheduled (Google allows 20 triggers
 * per person per script, and many sheets already use some). Old / duplicate workbench triggers are removed first.
 */
function wbInstallTriggers_(ss) {
  var mine = ['WB_onOpen', 'WB_hourly'];
  var legacy = ['WB_dailyMaintenance', 'WB_refreshPtpStatuses', 'WB_warmCaches', 'WB_nightlySnapshot'];
  var seen = {};
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (legacy.indexOf(fn) >= 0 || (mine.indexOf(fn) >= 0 && seen[fn])) { ScriptApp.deleteTrigger(t); removed++; return; }
    seen[fn] = true;
  });
  var add = {
    WB_onOpen: function () { ScriptApp.newTrigger('WB_onOpen').forSpreadsheet(ss).onOpen().create(); },
    WB_hourly: function () { ScriptApp.newTrigger('WB_hourly').timeBased().everyHours(1).create(); }
  };
  var failed = [];
  mine.forEach(function (fn) {
    if (seen[fn]) return;
    try { add[fn](); } catch (e) { failed.push(fn); }
  });
  var others = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); })
    .filter(function (fn) { return mine.indexOf(fn) < 0; });
  var note = '';
  if (failed.length) {
    note = '⚠️ Google\'s limit of 20 triggers for your account on this script is full, so these could not be added: ' +
      failed.join(', ') + '.\nOpen Apps Script → Triggers (clock icon), delete triggers you no longer need (' + others.length +
      ' other trigger(s): ' + others.slice(0, 8).join(', ') + (others.length > 8 ? ', …' : '') + '), then run WB_setup again.\n\n';
  } else if (removed) {
    note = 'Tidied ' + removed + ' old workbench trigger(s).\n\n';
  }
  return { failed: failed, removed: removed, note: note };
}

/**
 * The single scheduled job (installed every hour). Runs, in the spreadsheet's time zone:
 *   from 07:00 once a day  daily maintenance (caches, PTP statuses, new overdue into PTP Tracker, Invoice Not Due)
 *   every 2 hours          PTP status refresh
 *   08:00-21:59            cache warm-up so team / overview views open instantly
 *   from 22:00 once a day  snapshot for the trend
 * "Once a day" is tracked in script properties, so a missed or late run is caught up by the next one.
 */
function WB_hourly() {
  var props = PropertiesService.getScriptProperties();
  var now = new Date();
  var today = wbKey_(now);
  var hour = Number(Utilities.formatDate(now, wbTz_(), 'H'));
  var did = [];
  if (hour >= 7 && props.getProperty('wb_last_daily') !== today) {
    WB_dailyMaintenance();
    props.setProperty('wb_last_daily', today);
    did.push('daily');
  } else if (hour % 2 === 0) {
    WB_refreshPtpStatuses();
    did.push('ptp');
  }
  if (hour >= 22 && props.getProperty('wb_last_snap') !== today) {
    WB_nightlySnapshot();
    props.setProperty('wb_last_snap', today);
    did.push('snapshot');
  } else if (hour >= 8 && hour < 22) {
    WB_warmCaches();
    did.push('warm');
  }
  return did;
}

/** Menu → Check speed: times every building block of the workbench on this sheet (cold, without caches). */
function WB_checkSpeed() {
  var ss = SpreadsheetApp.getActive();
  var out = [];
  var step = function (name, fn) {
    var t0 = Date.now();
    var note = '';
    try { note = fn() || ''; } catch (e) { note = 'ERROR: ' + e.message; }
    out.push(name + ': ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (note ? '  (' + note + ')' : ''));
  };
  wbClearCaches_();
  var names = [];
  step('Settings & roles', function () { var i = wbRoleInfo_(); return i.role + (i.email ? ', ' + i.email : ', e-mail hidden'); });
  step('Find associate tabs', function () { names = wbAssociateSheets_(ss).map(function (s) { return s.getName(); }); return names.length + ' tabs'; });
  step('Imported_Data (open invoices)', function () { return wbOpenInvoices_(true).count + ' open'; });
  step('PTP Tracker', function () { return wbReadPtp_(ss).rows.length + ' rows'; });
  step('IO rate card', function () { return wbReadIo_(ss).rows.length + ' rows'; });
  step('Payables', function () { return Object.keys(wbPayIndex_(ss).pan).length + ' PANs'; });
  step('Activity log', function () { return wbReadLogTail_(ss, wbKey_(new Date())).length + ' today'; });
  step('PAN index (all tabs, col A)', function () { return Object.keys(wbOwnerIndex_(true).byPan).length + ' PANs'; });
  if (names.length) step('One associate tab (' + names[0] + ')', function () { return wbBuildBook_(ss.getSheetByName(names[0])).rows.length + ' PANs'; });
  step('All associate tabs', function () { var b = wbBooks_(names, false); return Object.keys(b).length + ' tabs'; });
  var msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('AR Workbench – speed check', msg + '\n\nThe caches are now warm, so the workbench should open quickly.', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* no UI */ }
  return msg;
}

function WB_openSidebar() {
  var t = HtmlService.createTemplateFromFile('Workbench');
  t.mode = 'sidebar';
  t.startPan = '';
  SpreadsheetApp.getUi().showSidebar(t.evaluate().setTitle('AR Workbench'));
}

/**
 * The main workbench: a large floating window. It is modeless, so the sheet stays clickable behind it
 * (Google fixes the side panel at 300 px; a dialog can be as wide as the screen). Size: WINDOW_SIZE setting.
 */
function WB_openWindow(pan) {
  var t = HtmlService.createTemplateFromFile('Workbench');
  t.mode = 'full';
  t.startPan = typeof pan === 'string' ? pan : '';
  var m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(String(wbSettings_().WINDOW_SIZE || '').trim()) || [0, 1280, 780];
  SpreadsheetApp.getUi().showModelessDialog(t.evaluate().setWidth(Number(m[1])).setHeight(Number(m[2])), 'AR Workbench');
}
/** Kept for menus / buttons installed by earlier versions. */
function WB_openFullScreen(pan) { WB_openWindow(pan); }

function WB_openSelectedPan() {
  var sel = wbGetSelection();
  if (!sel.pan) {
    SpreadsheetApp.getUi().alert('Select any cell on a PAN row first (your tab, Consolidated, PTP Tracker, IO rate card, Imported_Data or Payables).');
    return;
  }
  WB_openWindow(sel.pan);
}

function WB_refreshNow() {
  wbClearCaches_();
  wbOpenInvoices_(true);
  WB_refreshPtpStatuses();
  SpreadsheetApp.getActive().toast('Data refreshed', 'AR Workbench', 4);
}

// ---------------------------------------------------------------------------
// Public API: session, identity, search
// ---------------------------------------------------------------------------

function wbInit() {
  var ss = SpreadsheetApp.getActive();
  var info = wbRoleInfo_();
  var cfg = wbSettings_();
  var team = wbTeam_();
  var associates = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  var teamLeads = [];
  team.forEach(function (t) {
    if (t.teamLead && teamLeads.indexOf(t.teamLead) < 0) teamLeads.push(t.teamLead);
    if (t.role === 'Team Lead' && teamLeads.indexOf(t.name) < 0) teamLeads.push(t.name);
  });
  return {
    version: WB.VERSION,
    me: info.me,
    role: info.role,
    rolesConfigured: info.configured,
    identified: info.identified,
    email: info.email,
    associates: associates,
    teamLeads: teamLeads,
    team: team.map(function (t) { return { name: t.name, role: t.role, teamLead: t.teamLead }; }),
    myTeam: info.role === 'Team Lead' ? wbTeamOf_(info.me) : [],
    restrict: cfg.RESTRICT_VIEWS === 'Yes',
    today: wbKey_(new Date()),
    tz: ss.getSpreadsheetTimeZone(),
    dailyValues: WB.DAILY_VALUES,
    invoiceTags: WB.INVOICE_TAGS,
    coverageTarget: Number(cfg.COVERAGE_TARGET) || 80,
    staleDays: Number(cfg.STALE_DAYS) || 3,
    kamDomain: cfg.KAM_EMAIL_DOMAIN || '',
    signature: cfg.EMAIL_SIGNATURE || 'Accounts Receivable',
    user: info.email
  };
}

/**
 * Start-up in one round trip: session info + the first book (with its PTPs).
 * savedKey = the view the user picked last time ('a:Name' | 't:Lead' | 'all'), kept in the browser.
 */
function wbBoot(savedKey) {
  var init = wbInit();
  var key = '';
  if (init.role === 'Associate') key = init.me ? 'a:' + init.me : '';
  else if (init.role === 'Team Lead') key = 't:' + init.me;
  else key = init.me && init.associates.indexOf(init.me) >= 0 ? 'a:' + init.me : 'all';
  if (init.role !== 'Associate' && /^(a:|t:|all$)/.test(savedKey || '')) {
    var ok = savedKey === 'all' ? init.role !== 'Team Lead' || !init.restrict
      : savedKey.indexOf('a:') === 0 ? init.associates.indexOf(savedKey.slice(2)) >= 0
      : init.teamLeads.indexOf(savedKey.slice(2)) >= 0;
    if (ok) key = savedKey;
  }
  // The book is loaded by a second call so the window appears at once and can show progress.
  return { init: init, key: key, book: null };
}

function wbScopeOf_(key) {
  return key === 'all' ? { all: true } : key.indexOf('t:') === 0 ? { teamLead: key.slice(2) } : { assoc: key.slice(2) };
}

function wbSetMe(name) {
  PropertiesService.getUserProperties().setProperty('wb_me', name || '');
  return true;
}

/** What PAN is the user pointing at in the grid? Used by the side panel's "Follow". */
function wbGetSelection() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getActiveSheet();
  var cell = sh.getActiveCell();
  var out = { sheet: sh.getName(), row: cell ? cell.getRow() : 0, pan: '' };
  if (!cell || out.row < 2) return out;
  var name = sh.getName();
  var v = function (c) { return wbStr_(sh.getRange(out.row, c).getValue()); };
  if (name === WB.SHEET_PTP) {
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var H = wbPtpCols_(hdr);
    if (H.pan !== undefined) out.pan = v(H.pan + 1);
    if (!out.pan) {
      var rec = wbInvoiceLookup_(v(H.invoice === undefined ? 1 : H.invoice + 1));
      if (rec) out.pan = rec.pan;
    }
  } else if (name === WB.SHEET_LOG) {
    out.pan = v(4);
  } else if (name === WB.SHEET_PAY) {
    out.pan = wbIsPan_(v(1)) ? v(1) : v(17);
  } else if (name === WB.SHEET_CONSOLIDATED || wbIsAssociateSheet_(sh)) {
    if (out.row < 3) return out;
    out.pan = v(1);
  } else {
    out.pan = v(1);
  }
  if (!wbIsPan_(out.pan)) out.pan = '';
  return out;
}

/** Global search: PAN, customer, invoice number or brand across every tab the workbench knows. */
function wbSearch(q) {
  q = String(q || '').trim();
  if (q.length < 2) return { results: [] };
  var ql = q.toLowerCase();
  var ss = SpreadsheetApp.getActive();
  var idx = wbOwnerIndex_();
  var open = wbOpenInvoices_(false);
  var cons = wbConsolidated_(ss);
  var seen = {};
  var out = [];
  var add = function (pan, why) {
    if (!pan || seen[pan] || out.length >= 40) return;
    seen[pan] = true;
    var inv = open.byPan[pan] || [];
    out.push({
      pan: pan, customer: (cons.byPan[pan] || {}).customer || (inv[0] || {}).cust || '',
      owner: (idx.byPan[pan] || [])[0] ? idx.byPan[pan][0].assoc : '',
      open: inv.reduce(function (s, i) { return s + i.net; }, 0), invoices: inv.length, why: why
    });
  };
  if (wbIsPan_(q.toUpperCase())) add(q.toUpperCase(), 'PAN');
  if (open.byInv[q]) add(open.byInv[q].pan, 'Invoice ' + q);
  Object.keys(open.byInv).forEach(function (no) {
    if (out.length < 40 && no.toLowerCase().indexOf(ql) >= 0) add(open.byInv[no].pan, 'Invoice ' + no);
  });
  Object.keys(cons.byPan).forEach(function (p) {
    var c = cons.byPan[p];
    if (p.toLowerCase().indexOf(ql) >= 0 || String(c.customer).toLowerCase().indexOf(ql) >= 0) add(p, 'Customer');
  });
  Object.keys(open.byPan).forEach(function (p) {
    var list = open.byPan[p];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].cust).toLowerCase().indexOf(ql) >= 0) { add(p, 'Customer'); break; }
      if (String(list[i].brand).toLowerCase().indexOf(ql) >= 0) { add(p, 'Brand ' + list[i].brand); break; }
    }
  });
  if (!out.length) {
    var hit = wbInvoiceLookup_(q);
    if (hit) add(hit.pan, 'Invoice ' + q + ' (settled)');
  }
  return { results: out };
}

// ---------------------------------------------------------------------------
// Public API: book, PAN detail
// ---------------------------------------------------------------------------

/**
 * The PAN book for a scope: {assoc} | {teamLead} | {all:true}.
 * One row per PAN with ageing, flags, follow-up history, PTP roll-up, IO status and priority.
 */
function wbGetBook(scope) {
  var ss = SpreadsheetApp.getActive();
  var info = wbRoleInfo_();
  var names = wbScopeNames_(scope, info);
  var today = wbKey_(new Date());
  var single = names.length === 1;
  var books = wbBooks_(names, single);
  var ptp = wbReadPtp_(ss);
  var ptpBy = wbPtpRollup_(ptp.rows, today);
  var io = wbReadIo_(ss);
  var nextFu = wbNextFollowUps_(ss);
  var rows = [];
  var builtAt = '';
  var zeroRows = 0;
  names.forEach(function (n) {
    var b = books[n];
    if (!b) return;
    if (!builtAt || b.builtAt < builtAt) builtAt = b.builtAt;
    b.rows.forEach(function (r) {
      // Several associates at once: leave out zero-balance PANs unless asked (keeps the payload small).
      if (!single && !(scope || {}).withZero && r.total === 0 && r.overdue === 0) { zeroRows++; return; }
      r.owner = n;
      wbDecorateRow_(r, ptpBy[r.pan], io.byPan[r.pan], nextFu[r.pan], today);
      rows.push(wbListRow_(r));
    });
  });
  return { scope: scope || {}, names: names, today: today, rows: rows, builtAt: builtAt, live: single, zeroRows: zeroRows,
    ptps: wbPtpList_(ptp.rows, names, today) };
}

/** A book row for lists: long text trimmed (the PAN view shows everything in full). */
function wbListRow_(r) {
  var cut = function (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  var o = {};
  ['pan', 'owner', 'bizModel', 'arApHist', 'exposure', 'poe', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'total', 'overdue',
    'netPayable', 'possibleArAp', 'gt60', 'possibleArAp60', 'red', 'yellow', 'green', 'today', 'lastTouch', 'mtdTouches',
    'recent', 'stale', 'ptpOpen', 'ptpAmt', 'ptpBroken', 'ptpDueToday', 'ptpNext', 'io', 'ioRate', 'nextFollowUp', 'daysSince',
    'confidence', 'priority', 'row'].forEach(function (k) { o[k] = r[k]; });
  o.customer = cut(r.customer, 60);
  o.brands = cut(r.brands, 140);
  o.kams = cut(r.kams, 100);
  o.kamMgr = cut(r.kamMgr, 80);
  o.remarks = cut(r.remarks, 240);
  o.tlRemarks = cut(r.tlRemarks, 160);
  return o;
}

/** Everything about one PAN. */
function wbGetPan(pan) {
  var ss = SpreadsheetApp.getActive();
  pan = String(pan || '').trim().toUpperCase();
  var info = wbRoleInfo_();
  var today = wbKey_(new Date());
  var owners = wbOwnersOf_(pan);
  var owner = owners[0] || '';
  wbCheckScope_(info, owner ? [owner] : []);
  var header = owner ? wbPanRow_(ss.getSheetByName(owner), pan) : null;
  var open = wbOpenInvoices_(false).byPan[pan] || [];
  var ptp = wbReadPtp_(ss);
  var ptpByInv = {};
  ptp.rows.forEach(function (p) { ptpByInv[p.invoice] = p; });
  var invoices = open.map(function (inv) {
    var p = ptpByInv[inv.inv] || {};
    var live = p.invoice ? wbPtpStatus_(p.ptpDate, p.outstanding, p.added, p.settlement) : '';
    return {
      inv: inv.inv, invDate: inv.invDate, dueDate: inv.dueDate, credit: inv.credit,
      month: inv.month, brand: inv.brand, ageing: inv.ageing, bucket: inv.bucket,
      tds: inv.tds, receipt: inv.receipt, arap: inv.arap, net: inv.net,
      kam: inv.kam, kamMgr: inv.kamMgr,
      overdue: inv.bucket !== 'a.Not Due' && !!inv.dueDate && inv.dueDate < today,
      ptpDate: p.ptpDate || '', ptpAmount: p.ptpAmount === undefined ? '' : p.ptpAmount, ptpStatus: live,
      ptpMode: p.mode || '', ptpContact: p.contact || '', ptpRemarks: p.remarks || '',
      tag: p.tag || '', inTracker: !!p.invoice
    };
  });
  invoices.sort(function (a, b) { return (b.ageing || 0) - (a.ageing || 0); });
  var roll = wbPtpRollup_(ptp.rows.filter(function (p) { return p.pan === pan; }), today)[pan];
  var ioRec = wbReadIo_(ss).byPan[pan] || null;
  if (header) wbDecorateRow_(header, roll, ioRec, wbNextFollowUps_(ss)[pan], today);
  var kams = [];
  var kamMgrs = [];
  open.forEach(function (i) {
    if (i.kam && kams.indexOf(i.kam) < 0) kams.push(i.kam);
    if (i.kamMgr && kamMgrs.indexOf(i.kamMgr) < 0) kamMgrs.push(i.kamMgr);
  });
  return {
    pan: pan,
    owner: owner,
    owners: owners,
    consolidatedOwner: (wbConsolidated_(ss).byPan[pan] || {}).assoc || '',
    header: header,
    invoices: invoices,
    io: ioRec,
    payables: wbPayablesOf_(ss, pan),
    kams: kams,
    kamMgrs: kamMgrs,
    paid: null, // loaded when the section is opened (wbGetPaid)
    history: wbHistory_(ss, pan, 50),
    customer: (header && header.customer && header.customer !== '#N/A' ? header.customer : '') ||
      (open[0] && open[0].cust) || (ioRec && ioRec.customer) || '',
    canTl: info.role !== 'Associate'
  };
}

/** Recently settled invoices of a PAN - loaded only when the associate opens that section. */
function wbGetPaid(pan) {
  return { pan: pan, paid: wbRecentPaid_(SpreadsheetApp.getActive(), String(pan || '').trim(), 15) };
}

// ---------------------------------------------------------------------------
// Public API: actions
// ---------------------------------------------------------------------------

/**
 * Record a PTP against one or many invoices.
 * payload: {pan, customer, invoices:[invNo], ptpDate:'yyyy-MM-dd', dates:{inv:'yyyy-MM-dd'} (per-invoice, overrides
 *           ptpDate), amounts:{inv:amt}, mode, contact, remarks, markDaily, updateRemark}
 */
function wbSavePtp(payload) {
  if (!payload || !payload.invoices || !payload.invoices.length) throw new Error('Select at least one invoice');
  var dates = payload.dates || {};
  payload.invoices.forEach(function (no) {
    var d = dates[no] || payload.ptpDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw new Error('Pick a PTP date');
  });
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var pan = String(payload.pan || '').trim();
    var owner = wbOwnersOf_(pan)[0] || payload.assoc || '';
    var open = wbOpenInvoices_(false).byInv;
    var now = new Date();
    var total = 0;
    var earliest = '';
    var updates = payload.invoices.map(function (invNo) {
      var inv = open[invNo] || {};
      var d = dates[invNo] || payload.ptpDate;
      if (!earliest || d < earliest) earliest = d;
      var amt = payload.amounts && payload.amounts[invNo] !== undefined && payload.amounts[invNo] !== ''
        ? Number(payload.amounts[invNo]) : (inv.net || '');
      total += Number(amt) || 0;
      var set = {
        ptpDate: wbDate_(d), ptpAmount: amt, status: wbPtpStatus_(d, inv.net, inv.net, ''),
        pan: pan, updatedBy: wbUser_() || owner, updatedOn: now
      };
      if (payload.mode !== undefined) set.mode = payload.mode || '';
      if (payload.contact !== undefined) set.contact = payload.contact || '';
      if (payload.remarks !== undefined) set.remarks = payload.remarks || '';
      return {
        invoice: invNo,
        defaults: {
          customer: inv.cust || payload.customer || '', brand: inv.brand || '', associate: owner,
          dueDate: inv.dueDate ? wbDate_(inv.dueDate) : '', added: inv.net || '', outstanding: inv.net || '',
          addedOn: wbDate_(wbKey_(now)), pan: pan
        },
        set: set
      };
    });
    wbUpsertPtp_(ss, updates);
    var sameDate = payload.invoices.every(function (no) { return (dates[no] || payload.ptpDate) === earliest; });
    wbLog_(ss, {
      assoc: owner, pan: pan, customer: payload.customer, type: 'PTP',
      outcome: 'PTP ' + (sameDate ? 'for ' : 'from ') + wbFmtDate_(earliest) + ' · ' + payload.invoices.length + ' inv',
      invoices: payload.invoices.join(', '), amount: total, next: earliest, remarks: payload.remarks || ''
    });
    if (payload.markDaily !== false) wbMarkDaily_(ss, owner, pan, 'PTP');
    if (payload.updateRemark !== false) {
      wbSetRemark_(ss, owner, pan,
        'PTP ' + wbFmtDate_(earliest) + ' for ' + payload.invoices.length + ' inv (' + wbInr_(total) + ')' +
        (payload.remarks ? ' - ' + payload.remarks : ''));
    }
    wbDropBook_(owner);
    return { ok: true, count: payload.invoices.length, amount: total, date: earliest };
  });
}

/** Tag invoices (dispute, AR-AP proposed, ...) or clear a PTP. payload: {pan, invoices, tag, clearPtp, remarks} */
function wbTagInvoices(payload) {
  if (!payload || !payload.invoices || !payload.invoices.length) throw new Error('Select at least one invoice');
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var pan = String(payload.pan || '').trim();
    var owner = wbOwnersOf_(pan)[0] || payload.assoc || '';
    var open = wbOpenInvoices_(false).byInv;
    var now = new Date();
    var updates = payload.invoices.map(function (invNo) {
      var inv = open[invNo] || {};
      var set = { updatedBy: wbUser_() || owner, updatedOn: now, pan: pan };
      if (payload.tag !== undefined) set.tag = payload.tag;
      if (payload.clearPtp) { set.ptpDate = ''; set.ptpAmount = ''; set.status = 'PTP Pending'; set.days = ''; }
      if (payload.remarks) set.remarks = payload.remarks;
      return {
        invoice: invNo,
        defaults: {
          customer: inv.cust || '', brand: inv.brand || '', associate: owner,
          dueDate: inv.dueDate ? wbDate_(inv.dueDate) : '', added: inv.net || '', outstanding: inv.net || '',
          addedOn: wbDate_(wbKey_(now)), pan: pan, status: 'PTP Pending'
        },
        set: set
      };
    });
    wbUpsertPtp_(ss, updates);
    var what = payload.clearPtp ? 'PTP cleared' : (payload.tag ? 'Tagged: ' + payload.tag : 'Tag removed');
    wbLog_(ss, {
      assoc: owner, pan: pan, customer: payload.customer, type: 'Status',
      outcome: what, invoices: payload.invoices.join(', '), remarks: payload.remarks || ''
    });
    if (payload.tag === 'Expected Payment') wbMarkDaily_(ss, owner, pan, 'Expected Payment');
    wbDropBook_(owner);
    return { ok: true, count: payload.invoices.length };
  });
}

/**
 * Log a follow-up. payload: {pan, customer, channel, outcome, remarks, nextDate, daily, updateRemark}
 * daily = value for today's follow-up column (one of WB.DAILY_VALUES) or '' to leave it.
 */
function wbLogFollowUp(payload) {
  if (!payload || !payload.pan) throw new Error('No PAN');
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var owner = wbOwnersOf_(payload.pan)[0] || payload.assoc || '';
    wbLog_(ss, {
      assoc: owner, pan: payload.pan, customer: payload.customer, type: payload.channel || 'Call',
      outcome: payload.outcome || '', next: payload.nextDate || '', remarks: payload.remarks || ''
    });
    var daily = payload.daily === undefined ? 'Yes' : payload.daily;
    if (daily) wbMarkDaily_(ss, owner, payload.pan, daily);
    if (payload.updateRemark !== false && (payload.remarks || payload.outcome)) {
      wbSetRemark_(ss, owner, payload.pan,
        [payload.outcome, payload.remarks].filter(String).join(' - ') +
        (payload.nextDate ? ' | next f/u ' + wbFmtDate_(payload.nextDate) : ''));
    }
    wbDropBook_(owner);
    return { ok: true };
  });
}

/** One-click daily status for many PANs at once (e.g. "Leave", "Holiday", "Yes"). */
function wbBulkDaily(pans, value) {
  if (WB.DAILY_VALUES.indexOf(value) < 0) throw new Error('Invalid status ' + value);
  pans = pans || [];
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var byOwner = {};
    pans.forEach(function (p) {
      var o = wbOwnersOf_(p)[0];
      if (o) (byOwner[o] = byOwner[o] || []).push(p);
    });
    var n = 0;
    Object.keys(byOwner).forEach(function (o) {
      n += wbMarkDailyMany_(ss, o, byOwner[o], value);
      wbLog_(ss, { assoc: o, pan: byOwner[o].length === 1 ? byOwner[o][0] : '(' + byOwner[o].length + ' PANs)',
        type: 'Daily status', outcome: value, remarks: byOwner[o].length > 1 ? byOwner[o].join(', ') : '' });
      wbDropBook_(o);
    });
    return { ok: true, count: n };
  });
}

/** Save a PAN remark (which = 'remarks') or a team lead remark (which = 'tlRemarks') straight into the tab. */
function wbSaveRemark(pan, text, which) {
  which = which === 'tlRemarks' ? 'tlRemarks' : 'remarks';
  var info = wbRoleInfo_();
  if (which === 'tlRemarks' && info.role === 'Associate') throw new Error('Only team leads and management can write team lead remarks');
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var owner = wbOwnersOf_(pan)[0];
    if (!owner) throw new Error('PAN ' + pan + ' is not on any associate tab');
    if (!wbSetCell_(ss, owner, pan, which, text)) throw new Error('Could not find the ' + which + ' column in ' + owner);
    wbLog_(ss, { assoc: owner, pan: pan, type: which === 'tlRemarks' ? 'TL review' : 'Note',
      outcome: which === 'tlRemarks' ? 'Team lead remark' : 'Remark updated', remarks: text });
    wbDropBook_(owner);
    return { ok: true };
  });
}

/** Collection confidence split (Red / Yellow / Green amounts) and POE flag, written to the owner's tab. */
function wbSetConfidence(pan, amounts, poe) {
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var owner = wbOwnersOf_(pan)[0];
    if (!owner) throw new Error('PAN ' + pan + ' is not on any associate tab');
    var num = function (v) { return v === '' || v === null || v === undefined ? '' : Number(v) || 0; };
    var vals = { red: num((amounts || {}).red), yellow: num((amounts || {}).yellow), green: num((amounts || {}).green) };
    wbSetCells_(ss, owner, pan, poe === undefined ? vals : Object.assign({ poe: poe }, vals));
    var best = '';
    var max = 0;
    [['Red', vals.red], ['Yellow', vals.yellow], ['Green', vals.green]].forEach(function (x) {
      if ((Number(x[1]) || 0) > max) { max = Number(x[1]); best = x[0]; }
    });
    wbLog_(ss, { assoc: owner, pan: pan, type: 'Status',
      outcome: 'Confidence: ' + (best || 'cleared') + (poe ? ' · POE ' + poe : ''),
      remarks: 'R ' + wbInr_(vals.red) + ' / Y ' + wbInr_(vals.yellow) + ' / G ' + wbInr_(vals.green) });
    wbDropBook_(owner);
    return { ok: true, confidence: best };
  });
}

/**
 * IO sign-off for a PAN, written to the IO Sign Off Rate Card.
 * payload: {pan, signed:true|false, link, pdf, remarks, signedOn:'yyyy-MM-dd'}
 * A PAN counts as signed when "IO Sign off Link" is filled (same rule as the rate card's own summary).
 */
function wbSaveIo(payload) {
  if (!payload || !payload.pan) throw new Error('No PAN');
  if (payload.signed && !String(payload.link || '').trim()) throw new Error('Paste the IO sign-off link (Drive link to the signed IO)');
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var sh = wbEnsureIoHeaders_(ss);
    if (!sh) throw new Error('Tab "' + WB.SHEET_IO + '" not found');
    var pan = String(payload.pan).trim();
    var C = wbIoCols_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
    var row = 0;
    if (sh.getLastRow() >= 2) {
      var f = sh.getRange(2, C.pan + 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findNext();
      if (f) row = f.getRow();
    }
    var owner = wbOwnersOf_(pan)[0] || '';
    if (!row) {
      row = sh.getLastRow() + 1;
      sh.getRange(row, C.pan + 1).setValue(pan);
      if (C.customer >= 0) sh.getRange(row, C.customer + 1).setValue(payload.customer || '');
    }
    var set = function (col, v) { if (col >= 0) sh.getRange(row, col + 1).setValue(v); };
    set(C.link, payload.signed ? String(payload.link).trim() : '');
    if (payload.pdf !== undefined) set(C.pdf, String(payload.pdf || '').trim());
    if (payload.remarks !== undefined) set(C.remarks, payload.remarks || '');
    set(C.signedOn, payload.signed ? wbDate_(payload.signedOn || wbKey_(new Date())) : '');
    set(C.updatedBy, (wbUser_() || owner) + ' · ' + Utilities.formatDate(new Date(), wbTz_(), 'dd-MMM HH:mm'));
    wbLog_(ss, { assoc: owner, pan: pan, customer: payload.customer, type: 'IO',
      outcome: payload.signed ? 'IO signed' + (payload.signedOn ? ' on ' + wbFmtDate_(payload.signedOn) : '') : 'IO marked pending',
      remarks: [payload.remarks, payload.signed ? payload.link : ''].filter(String).join(' | ') });
    wbDropCache_('io');
    return { ok: true };
  });
}

/**
 * Team lead / management: move PANs to another associate. The PAN is written into the first free formula row
 * of the new owner's tab (so all columns calculate), the typed inputs (POE, remarks, team lead remarks,
 * Red/Yellow/Green) move with it, and Consolidated's Associate Name is updated. The old row keeps its daily
 * history (the Summary's past counts stay right); only its PAN and inputs are cleared.
 */
function wbReassign(pans, newOwner) {
  var info = wbRoleInfo_();
  if (info.role === 'Associate') throw new Error('Only team leads and management can reassign PANs');
  var ss = SpreadsheetApp.getActive();
  var target = ss.getSheetByName(newOwner);
  if (!target || !wbIsAssociateSheet_(target)) throw new Error('No associate tab named "' + newOwner + '"');
  return wbWithLock_(function () {
    var moved = [];
    (pans || []).forEach(function (pan) {
      pan = String(pan).trim();
      var from = wbOwnersOf_(pan)[0] || '';
      if (from === newOwner) return;
      var inputs = {};
      var fromSh = from ? ss.getSheetByName(from) : null;
      var fromRow = fromSh ? wbFindRow_(fromSh, pan) : 0;
      var keys = ['poe', 'remarks', 'tlRemarks', 'red', 'yellow', 'green'];
      if (fromRow) {
        var fH = wbHeaderIndex_(fromSh.getRange(2, 1, 1, fromSh.getLastColumn()).getValues()[0]);
        var vals = fromSh.getRange(fromRow, 1, 1, fromSh.getLastColumn()).getValues()[0];
        keys.forEach(function (k) { if (fH[k] !== undefined) inputs[k] = vals[fH[k]]; });
      }
      var row = wbFreeRow_(target);
      var tH = wbHeaderIndex_(target.getRange(2, 1, 1, target.getLastColumn()).getValues()[0]);
      wbEnsureFormulaRow_(target, row, tH.possibleArAp60 === undefined ? 0 : tH.possibleArAp60);
      target.getRange(row, 1).setValue(pan);
      keys.forEach(function (k) {
        if (tH[k] === undefined) return;
        var v = inputs[k] !== undefined ? inputs[k] : '';
        if (v !== '' || k === 'poe') target.getRange(row, tH[k] + 1).setValue(v);
      });
      if (fromRow) {
        delete wbMemoStore_['row|' + from + '|' + pan];
        fromSh.getRange(fromRow, 1).setValue('');
        var fH2 = wbHeaderIndex_(fromSh.getRange(2, 1, 1, fromSh.getLastColumn()).getValues()[0]);
        keys.forEach(function (k) { if (fH2[k] !== undefined) fromSh.getRange(fromRow, fH2[k] + 1).setValue(''); });
      }
      wbSetConsolidatedOwner_(ss, pan, newOwner);
      wbLog_(ss, { assoc: newOwner, pan: pan, type: 'Reassigned', outcome: (from || 'Unassigned') + ' → ' + newOwner });
      if (from) wbDropBook_(from);
      moved.push(pan);
    });
    wbDropBook_(newOwner);
    wbDropOwners_();
    return { ok: true, count: moved.length };
  });
}

/**
 * Create a Gmail draft. payload: {pan, customer, to, cc, subject, html, invoices:[no], total}
 * The HTML is the same statement the associate previewed and can copy (built in the workbench).
 */
function wbCreateEmailDraft(payload) {
  if (!payload || !payload.pan) throw new Error('No PAN');
  if (!payload.html) throw new Error('Nothing to send');
  var draft = GmailApp.createDraft(payload.to || '', payload.subject || ('Payment reminder: ' + (payload.customer || payload.pan)),
    'Please view this e-mail in HTML.', { htmlBody: payload.html, cc: payload.cc || '' });
  wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var owner = wbOwnersOf_(payload.pan)[0] || '';
    wbLog_(ss, {
      assoc: owner, pan: payload.pan, customer: payload.customer, type: 'Email',
      outcome: 'Reminder drafted (' + (payload.invoices || []).length + ' inv)', invoices: (payload.invoices || []).join(', '),
      amount: payload.total || '', remarks: payload.to ? 'To: ' + payload.to : ''
    });
    if (payload.markDaily !== false) wbMarkDaily_(ss, owner, payload.pan, 'Yes');
    wbDropBook_(owner);
  });
  return { ok: true, draftId: draft.getId(), link: 'https://mail.google.com/mail/#drafts' };
}

/** Copying the statement for a mail counts as a follow-up touch (optional, from the copy dialog). */
function wbLogCopy(payload) {
  return wbWithLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var owner = wbOwnersOf_(payload.pan)[0] || '';
    wbLog_(ss, { assoc: owner, pan: payload.pan, customer: payload.customer, type: 'Email',
      outcome: 'Statement copied for mail (' + (payload.invoices || []).length + ' inv)',
      invoices: (payload.invoices || []).join(', '), amount: payload.total || '' });
    if (payload.markDaily) wbMarkDaily_(ss, owner, payload.pan, 'Yes');
    wbDropBook_(owner);
    return { ok: true };
  });
}

/** Jump the grid to the PAN's row in the owner's tab. */
function wbGoToRow(pan) {
  var ss = SpreadsheetApp.getActive();
  var owner = wbOwnersOf_(pan)[0];
  var sh = owner ? ss.getSheetByName(owner) : null;
  if (!sh) return { ok: false };
  var r = wbFindRow_(sh, pan);
  if (!r) return { ok: false };
  ss.setActiveSheet(sh);
  sh.setActiveRange(sh.getRange(r, 1));
  return { ok: true, sheet: owner, row: r };
}

/** Force a cache rebuild (↻ in the UI). */
function wbRefresh() {
  wbClearCaches_();
  var d = wbOpenInvoices_(true);
  return { ok: true, invoices: d.count, builtAt: d.builtAt };
}

// ---------------------------------------------------------------------------
// Public API: PTPs, IO, productivity
// ---------------------------------------------------------------------------

/** PTP Tracker rows owned by the scope, with live status. */
function wbGetPtps(scope) {
  var ss = SpreadsheetApp.getActive();
  var names = wbScopeNames_(scope, wbRoleInfo_());
  var today = wbKey_(new Date());
  return wbPtpList_(wbReadPtp_(ss).rows, names, today);
}

/** PTP Tracker rows of these associates that carry a PTP, a tag or a non-default status, with live status. */
function wbPtpList_(all, names, today) {
  var rows = all.filter(function (p) {
    return names.indexOf(p.associate) >= 0 && (p.ptpDate || p.tag || (p.status && p.status !== 'PTP Pending'));
  }).map(function (p) {
    var o = {};
    Object.keys(p).forEach(function (k) { o[k] = p[k]; });
    o.live = wbPtpStatus_(p.ptpDate, p.outstanding, p.added, p.settlement);
    if (p.ptpDate && p.outstanding > 0) o.daysLate = p.ptpDate < today ? wbDiffDays_(p.ptpDate, today) : 0;
    return o;
  });
  rows.sort(function (a, b) { return (a.ptpDate || '9999') < (b.ptpDate || '9999') ? -1 : 1; });
  return { today: today, rows: rows };
}

/** IO sign-off book for the scope (rate card rows whose current associate is in scope). */
function wbGetIo(scope) {
  var ss = SpreadsheetApp.getActive();
  var names = wbScopeNames_(scope, wbRoleInfo_());
  var io = wbReadIo_(ss);
  var open = wbOpenInvoices_(false).byPan;
  var monthStart = wbKey_(new Date()).slice(0, 8) + '01';
  var rows = io.rows.filter(function (r) { return names.indexOf(r.assoc) >= 0; }).map(function (r) {
    var inv = open[r.pan] || [];
    r.open = inv.reduce(function (s, i) { return s + i.net; }, 0);
    r.overdue = inv.reduce(function (s, i) { return s + (i.bucket !== 'a.Not Due' ? i.net : 0); }, 0);
    r.thisMonth = r.done && r.signedOn >= monthStart;
    return r;
  });
  var s = { pans: rows.length, done: 0, pending: 0, earned: 0, earnedMonth: 0, potential: 0 };
  rows.forEach(function (r) {
    if (r.done) { s.done++; s.earned += r.rate; if (r.thisMonth) s.earnedMonth += r.rate; } else { s.pending++; s.potential += r.rate; }
  });
  rows.sort(function (a, b) { return (a.done - b.done) || (b.rate - a.rate) || (b.avgInv - a.avgInv); });
  return { rows: rows, stats: s, month: monthStart.slice(0, 7) };
}

/** Productivity for one associate + team leaderboard. */
function wbGetProductivity(assoc) {
  var ss = SpreadsheetApp.getActive();
  var info = wbRoleInfo_();
  wbCheckScope_(info, [assoc]);
  var today = wbKey_(new Date());
  var monthStart = today.slice(0, 8) + '01';
  var weekStart = wbAddDays_(today, -((wbDow_(today) + 6) % 7));
  var all = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  var books = wbBooks_(all, false);
  var fresh = wbBooks_([assoc], true)[assoc];
  if (fresh) books[assoc] = fresh;
  var log = wbReadLogTail_(ss, monthStart);
  var teamActs = {};
  var acts = { today: {}, week: {}, month: {} };
  log.forEach(function (l) {
    if (l.date >= monthStart) teamActs[l.assoc] = (teamActs[l.assoc] || 0) + 1;
    if (l.assoc !== assoc) return;
    var t = l.type || 'Other';
    if (l.date === today) acts.today[t] = (acts.today[t] || 0) + 1;
    if (l.date >= weekStart) acts.week[t] = (acts.week[t] || 0) + 1;
    if (l.date >= monthStart) acts.month[t] = (acts.month[t] || 0) + 1;
  });
  var ptpRows = wbReadPtp_(ss).rows;
  var ptpStats = wbPtpStats_(ptpRows.filter(function (p) { return p.associate === assoc && p.ptpDate; }));
  var io = wbReadIo_(ss);
  var ioBy = wbIoByAssoc_(io.rows, monthStart);
  var team = all.map(function (n) {
    var b = books[n];
    if (!b) return null;
    var st = b.stats;
    var ps = wbPtpStats_(ptpRows.filter(function (p) { return p.associate === n && p.ptpDate; }));
    return {
      assoc: n, active: st.active, todayCov: st.active ? st.touchedToday / st.active : 0, mtdCov: st.mtdCov,
      touchedToday: st.touchedToday, untouched3: st.stale, overdue: st.overdue, gt60: st.gt60, actsMtd: teamActs[n] || 0,
      keptRate: ps.keptRate, ioDone: (ioBy[n] || {}).done || 0, ioMonth: (ioBy[n] || {}).month || 0
    };
  }).filter(Boolean).sort(function (a, b) { return b.mtdCov - a.mtdCov; });
  var mine = books[assoc] ? books[assoc].stats : null;
  return {
    today: today,
    mine: mine ? {
      active: mine.active, touchedToday: mine.touchedToday, todayCov: mine.active ? mine.touchedToday / mine.active : 0,
      mtdCov: mine.mtdCov, untouched3: mine.stale, trend: mine.trend
    } : null,
    acts: acts, ptp: ptpStats, io: ioBy[assoc] || { pans: 0, done: 0, pending: 0, earned: 0, earnedMonth: 0, month: 0 },
    team: team
  };
}

// ---------------------------------------------------------------------------
// Public API: team review and management overview
// ---------------------------------------------------------------------------

/** Team lead review: per-associate KPIs + review queues. teamLead '' = everybody. */
function wbGetTeamReview(teamLead, force) {
  var ss = SpreadsheetApp.getActive();
  var info = wbRoleInfo_();
  if (info.role === 'Associate') throw new Error('Team review is for team leads and management');
  var names = teamLead ? wbScopeNames_({ teamLead: teamLead }, info) : wbScopeNames_({ all: true }, info);
  if (force) names.forEach(wbDropBook_);
  var books = wbBooks_(names, false);
  var today = wbKey_(new Date());
  var ptpRows = wbReadPtp_(ss).rows;
  var ptpBy = wbPtpRollup_(ptpRows, today);
  var io = wbReadIo_(ss);
  var ioBy = wbIoByAssoc_(io.rows, today.slice(0, 8) + '01');
  var nextFu = wbNextFollowUps_(ss);
  var rows = [];
  var builtAt = '';
  var associates = names.map(function (n) {
    var b = books[n];
    if (!b) return null;
    if (!builtAt || b.builtAt < builtAt) builtAt = b.builtAt;
    var st = b.stats;
    var ps = wbPtpStats_(ptpRows.filter(function (p) { return p.associate === n && p.ptpDate; }));
    var a = {
      name: n, active: st.active, overdue: st.overdue, gt60: st.gt60, arap: st.possibleArAp, total: st.total,
      touchedToday: st.touchedToday, todayCov: st.active ? st.touchedToday / st.active : 0, mtdCov: st.mtdCov,
      stale: st.stale, ptpOpen: 0, broken: 0, keptRate: ps.keptRate, remarksFilled: st.remarksFilled,
      remarksPct: st.overdueAccts ? st.remarksOnOverdue / st.overdueAccts : null,
      red: st.red, yellow: st.yellow, green: st.green,
      ioDone: (ioBy[n] || {}).done || 0, ioPending: (ioBy[n] || {}).pending || 0, ioMonth: (ioBy[n] || {}).month || 0
    };
    b.rows.forEach(function (r) {
      r.owner = n;
      wbDecorateRow_(r, ptpBy[r.pan], io.byPan[r.pan], nextFu[r.pan], today);
      a.ptpOpen += r.ptpOpen;
      a.broken += r.ptpBroken;
      rows.push(r);
    });
    return a;
  }).filter(Boolean);
  var top = function (list, key, n) {
    return list.sort(function (x, y) { return y[key] - x[key]; }).slice(0, n || 25).map(wbSlim_);
  };
  return {
    teamLead: teamLead, names: names, today: today, builtAt: builtAt,
    associates: associates,
    queues: {
      broken: top(rows.filter(function (r) { return r.ptpBroken > 0; }), 'overdue'),
      stale: top(rows.filter(function (r) { return r.overdue > 0 && r.stale; }), 'overdue'),
      gt60NoPtp: top(rows.filter(function (r) { return r.gt60 > 0 && !r.ptpOpen; }), 'gt60'),
      noRemark: top(rows.filter(function (r) { return r.overdue > 0 && !r.remarks; }), 'overdue'),
      red: top(rows.filter(function (r) { return r.confidence === 'Red'; }), 'overdue'),
      exposure: top(rows.filter(function (r) { return r.exposure === 'Yes' && r.overdue > 0; }), 'overdue'),
      ioPending: top(rows.filter(function (r) { return r.io === 'Pending' && r.overdue > 0; }), 'ioRate')
    }
  };
}

/** Management overview: portfolio, ageing, confidence, IO, trend, breakdowns, top PANs, data health checks. */
function wbGetOverview(force) {
  var ss = SpreadsheetApp.getActive();
  var info = wbRoleInfo_();
  if (info.role === 'Associate' || info.role === 'Team Lead') throw new Error('The overview is for management');
  var names = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  if (force) { names.forEach(wbDropBook_); wbDropOwners_(); }
  var books = wbBooks_(names, false);
  var today = wbKey_(new Date());
  var monthStart = today.slice(0, 8) + '01';
  var ptpRows = wbReadPtp_(ss).rows;
  var ptpBy = wbPtpRollup_(ptpRows, today);
  var io = wbReadIo_(ss);
  var ioBy = wbIoByAssoc_(io.rows, monthStart);
  var teamBy = {};
  wbTeam_().forEach(function (t) { teamBy[t.name] = t; });
  var tot = wbEmptyTotals_();
  var rows = [];
  var builtAt = '';
  var assocs = names.map(function (n) {
    var b = books[n];
    if (!b) return null;
    if (!builtAt || b.builtAt < builtAt) builtAt = b.builtAt;
    var st = b.stats;
    var ps = wbPtpStats_(ptpRows.filter(function (p) { return p.associate === n && p.ptpDate; }));
    var a = { name: n, teamLead: (teamBy[n] || {}).teamLead || '', active: st.active, total: st.total, overdue: st.overdue,
      gt60: st.gt60, arap: st.possibleArAp, todayCov: st.active ? st.touchedToday / st.active : 0, mtdCov: st.mtdCov,
      stale: st.stale, ptpOpen: 0, ptpAmt: 0, broken: 0, keptRate: ps.keptRate,
      ioDone: (ioBy[n] || {}).done || 0, ioPending: (ioBy[n] || {}).pending || 0 };
    b.rows.forEach(function (r) {
      r.owner = n;
      r.teamLead = a.teamLead;
      wbDecorateRow_(r, ptpBy[r.pan], io.byPan[r.pan], null, today);
      a.ptpOpen += r.ptpOpen; a.ptpAmt += r.ptpAmt; a.broken += r.ptpBroken;
      rows.push(r);
    });
    wbAddTotals_(tot, st, a);
    return a;
  }).filter(Boolean);
  var kept = wbPtpStats_(ptpRows.filter(function (p) { return p.ptpDate; }));
  tot.keptRate = kept.keptRate;
  tot.todayCov = tot.active ? tot.touchedToday / tot.active : 0;
  tot.mtdCov = tot.active ? tot.mtdTouchWeighted / tot.active : 0;
  var ioAll = { done: 0, pending: 0, earned: 0, earnedMonth: 0 };
  io.rows.forEach(function (r) {
    if (r.done) { ioAll.done++; ioAll.earned += r.rate; if (r.signedOn >= monthStart) ioAll.earnedMonth += r.rate; } else ioAll.pending++;
  });
  var group = function (keyFn) {
    var g = {};
    rows.forEach(function (r) {
      if (!r.total) return;
      var k = keyFn(r) || '(blank)';
      var o = g[k] || (g[k] = { key: k, pans: 0, total: 0, overdue: 0, gt60: 0, arap: 0 });
      o.pans++; o.total += r.total; o.overdue += r.overdue; o.gt60 += r.gt60; o.arap += r.possibleArAp;
    });
    return Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.overdue - a.overdue; }).slice(0, 12);
  };
  return {
    today: today, builtAt: builtAt,
    total: tot, io: ioAll,
    associates: assocs,
    byModel: group(function (r) { return r.bizModel; }),
    byBu: group(function (r) { return String(r.buHead || '').split(',')[0].trim(); }),
    byTeamLead: group(function (r) { return r.teamLead || '(no team lead)'; }),
    topOverdue: rows.filter(function (r) { return r.overdue > 0; }).sort(function (a, b) { return b.overdue - a.overdue; })
      .slice(0, 20).map(wbSlim_),
    trend: wbReadSnapshots_(ss),
    health: wbHealth_(ss, books, names)
  };
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

/**
 * Daily (07:00):
 *  1. rebuild the open-invoice cache and drop cached books
 *  2. refresh PTP Tracker (current outstanding, settlement date, days vs PTP, status) and add newly overdue invoices
 *  3. auto-mark "Invoice Not Due" in today's column for PANs that have nothing overdue
 */
function WB_dailyMaintenance() {
  var ss = SpreadsheetApp.getActive();
  var cfg = wbSettings_();
  wbClearCaches_();
  wbOpenInvoices_(true);
  WB_refreshPtpStatuses(cfg.ADD_OVERDUE_TO_PTP !== 'No');
  if (cfg.AUTO_NOT_DUE !== 'No') wbAutoNotDue_(ss);
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
    var before = JSON.stringify(data);
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
        // Days vs PTP: positive = paid / still unpaid that many days after the promise; blank while it is in the future.
        var ref = outstanding <= 0 ? (settleKey || today) : today;
        row[H.days] = ref >= ptpKey || outstanding <= 0 ? wbDiffDays_(ptpKey, ref) : '';
      } else if (outstanding <= 0 && rec) {
        next = 'Paid';
      } else if (!st) {
        next = 'PTP Pending';
      }
      if (next !== st) {
        // Keep anything an associate typed into Status (e.g. "Ar-ap recvd", "Settled") in PTP Remarks.
        if (st && WB_STATUSES.indexOf(st) < 0 && H.remarks !== undefined && String(row[H.remarks]).indexOf(st) < 0) {
          row[H.remarks] = row[H.remarks] ? row[H.remarks] + ' | ' + st : st;
        }
        row[H.status] = next;
      }
    });
    if (data.length && JSON.stringify(data) !== before) sh.getRange(2, 1, data.length, lastCol).setValues(data);
    wbDropCache_('ptp');
    if (addMissing === true) {
      var owners = wbOwnerIndex_(true).byPan;
      var add = [];
      Object.keys(all).forEach(function (invNo) {
        var r = all[invNo];
        if (seen[invNo] || !(r.net > 0) || r.bucket === 'a.Not Due' || !r.bucket) return;
        var row = new Array(lastCol).fill('');
        row[H.invoice] = invNo; row[H.customer] = r.cust; row[H.brand] = r.brand;
        row[H.associate] = (owners[r.pan] || [])[0] ? owners[r.pan][0].assoc : r.assoc;
        row[H.dueDate] = r.dueDate ? wbDate_(r.dueDate) : '';
        row[H.added] = r.net; row[H.outstanding] = r.net; row[H.addedOn] = wbDate_(today);
        row[H.status] = 'PTP Pending';
        if (H.pan !== undefined) row[H.pan] = r.pan;
        add.push(row);
      });
      if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, lastCol).setValues(add);
      wbDropCache_('ptp');
    }
  } finally {
    lock.releaseLock();
  }
}

/** Hourly: keep the team / overview caches warm so team leads and management open instantly. */
function WB_warmCaches() {
  var ss = SpreadsheetApp.getActive();
  var names = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  names.forEach(wbDropBook_);
  wbBooks_(names, false);
  wbOwnerIndex_(true);
  wbOpenInvoices_(false);
  ['ptp', 'io', 'cons'].forEach(wbDropCache_);
  wbReadPtp_(ss);
  wbReadIo_(ss);
  wbConsolidated_(ss);
  wbPayIndex_(ss);
  wbReadLogTail_(ss, wbKey_(new Date()));
}

/** 22:00: one row per associate into WB Snapshots (trend history for the overview). */
function WB_nightlySnapshot() {
  var ss = SpreadsheetApp.getActive();
  var sh = wbEnsureSnapSheet_(ss);
  var today = wbKey_(new Date());
  var monthStart = today.slice(0, 8) + '01';
  var names = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  names.forEach(wbDropBook_);
  var books = wbBooks_(names, false);
  var ptpRows = wbReadPtp_(ss).rows;
  var ptpBy = wbPtpRollup_(ptpRows, today);
  var ioBy = wbIoByAssoc_(wbReadIo_(ss).rows, monthStart);
  var acts = {};
  wbReadLogTail_(ss, today).forEach(function (l) { if (l.date === today) acts[l.assoc] = (acts[l.assoc] || 0) + 1; });
  var out = [];
  names.forEach(function (n) {
    var b = books[n];
    if (!b) return;
    var st = b.stats;
    var p = { open: 0, amt: 0, broken: 0 };
    b.rows.forEach(function (r) {
      var x = ptpBy[r.pan];
      if (x) { p.open += x.open; p.amt += x.amt; p.broken += x.broken; }
    });
    out.push([wbDate_(today), n, st.active, st.total, st.overdue, st.gt60, st.netPayable, st.possibleArAp, st.touchedToday,
      st.active ? st.touchedToday / st.active : 0, st.stale, p.open, p.amt, p.broken, (ioBy[n] || {}).done || 0,
      (ioBy[n] || {}).pending || 0, acts[n] || 0, st.red, st.yellow, st.green]);
  });
  // Replace today's rows if the snapshot runs twice.
  if (sh.getLastRow() >= 2) {
    var dates = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = dates.length - 1; i >= 0; i--) {
      if (dates[i][0] instanceof Date && wbKey_(dates[i][0]) === today) sh.deleteRow(i + 2);
    }
  }
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
  return out.length;
}

function wbAutoNotDue_(ss) {
  var today = wbKey_(new Date());
  wbAssociateSheets_(ss).forEach(function (sh) {
    var b = wbReadAssocSheet_(sh);
    var col = b.dateCols[today];
    if (!col) return;
    var rows = b.rows.filter(function (r) { return !r.today && r.overdue === 0 && r.b0 > 0; });
    if (!rows.length) return;
    // Write the whole column block once (fast) - only the blank cells of qualifying rows change.
    var first = b.rows[0].row;
    var last = b.rows[b.rows.length - 1].row;
    var range = sh.getRange(first, col, last - first + 1, 1);
    var vals = range.getValues();
    rows.forEach(function (r) { if (vals[r.row - first][0] === '') vals[r.row - first][0] = 'Invoice Not Due'; });
    range.setValues(vals);
    wbDropBook_(sh.getName());
  });
}

// ---------------------------------------------------------------------------
// Internals: settings, team, roles
// ---------------------------------------------------------------------------

var wbSettingsMemo_ = null;
var wbTeamMemo_ = null;

function wbSettings_() {
  if (wbSettingsMemo_) return wbSettingsMemo_;
  var out = {};
  WB_SETTINGS_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  var sh = SpreadsheetApp.getActive().getSheetByName(WB.SHEET_SETTINGS);
  if (sh && sh.getLastRow() >= 4) {
    sh.getRange(4, 7, sh.getLastRow() - 3, 2).getValues().forEach(function (r) {
      var k = wbStr_(r[0]);
      if (k) out[k] = wbStr_(r[1]);
    });
  }
  wbSettingsMemo_ = out;
  return out;
}

/** Team roster from WB Settings, plus any associate tab that is not listed yet (as an Associate). */
function wbTeam_() {
  if (wbTeamMemo_) return wbTeamMemo_;
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(WB.SHEET_SETTINGS);
  var out = [];
  if (sh && sh.getLastRow() >= 4) {
    sh.getRange(4, 1, sh.getLastRow() - 3, WB.TEAM_HEADERS.length).getValues().forEach(function (r) {
      var name = wbStr_(r[0]);
      if (!name) return;
      var role = wbStr_(r[1]) || 'Associate';
      out.push({
        name: name, role: WB.ROLES.indexOf(role) >= 0 ? role : 'Associate', teamLead: wbStr_(r[2]),
        email: wbStr_(r[3]).toLowerCase(), active: wbStr_(r[4]) !== 'No'
      });
    });
  }
  var listed = out.map(function (t) { return t.name; });
  wbAssociateSheets_(ss).forEach(function (s) {
    if (listed.indexOf(s.getName()) < 0) out.push({ name: s.getName(), role: 'Associate', teamLead: '', email: '', active: true });
  });
  wbTeamMemo_ = out;
  return out;
}

function wbTeamOf_(teamLead) {
  var ss = SpreadsheetApp.getActive();
  var tabs = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  return wbTeam_().filter(function (t) { return t.teamLead === teamLead && tabs.indexOf(t.name) >= 0; })
    .map(function (t) { return t.name; });
}

/**
 * Who is using the workbench. Matched by Google e-mail on WB Settings; otherwise the name they picked.
 * Until any Team Lead / Management / Admin role is filled in, everyone gets every view (set-up mode).
 */
function wbRoleInfo_() {
  var team = wbTeam_();
  var email = wbUser_().toLowerCase();
  var person = null;
  if (email) team.forEach(function (t) { if (t.email && t.email === email) person = t; });
  var configured = team.some(function (t) { return t.role !== 'Associate'; });
  var ss = SpreadsheetApp.getActive();
  var associates = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  var me = person ? person.name : (PropertiesService.getUserProperties().getProperty('wb_me') || '');
  if (!person) {
    var active = ss.getActiveSheet().getName();
    if (associates.indexOf(active) >= 0) me = active;
  }
  if (me && associates.indexOf(me) < 0 && !(person && person.role !== 'Associate')) me = '';
  return {
    email: email, person: person, identified: !!person, configured: configured, me: me,
    role: person ? person.role : (configured ? 'Associate' : 'Admin')
  };
}

/** Associate names for a scope, limited by RESTRICT_VIEWS. */
function wbScopeNames_(scope, info) {
  scope = scope || {};
  var ss = SpreadsheetApp.getActive();
  var tabs = wbAssociateSheets_(ss).map(function (s) { return s.getName(); });
  var names;
  if (scope.all) names = tabs.slice();
  else if (scope.teamLead) { names = wbTeamOf_(scope.teamLead); if (!names.length && tabs.indexOf(scope.teamLead) >= 0) names = [scope.teamLead]; }
  else names = tabs.indexOf(scope.assoc) >= 0 ? [scope.assoc] : [];
  wbCheckScope_(info, names);
  return names;
}

function wbCheckScope_(info, names) {
  if (wbSettings_().RESTRICT_VIEWS !== 'Yes') return;
  if (info.role === 'Management' || info.role === 'Admin') return;
  var allowed = info.role === 'Team Lead' ? wbTeamOf_(info.me).concat([info.me]) : [info.me];
  names.forEach(function (n) {
    if (allowed.indexOf(n) < 0) throw new Error('You can only open your own' + (info.role === 'Team Lead' ? ' / your team\'s' : '') + ' PANs');
  });
}

// ---------------------------------------------------------------------------
// Internals: associate tabs
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
  if (hit) {
    var names = JSON.parse(hit);
    var list = names.map(function (n) { return ss.getSheetByName(n); }).filter(Boolean);
    if (list.length === names.length) return list;
  }
  var out = ss.getSheets().filter(function (s) { return !s.isSheetHidden() && wbIsAssociateSheet_(s); });
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

/**
 * Read an associate tab: fixed columns (A..Green) + the follow-up date columns from the start of last month's
 * window up to today. Rows without a PAN are skipped; the formula rows below the last PAN are never read.
 */
function wbReadAssocSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var empty = { rows: [], dates: [], dateCols: {}, H: {}, lastPanRow: 2, row1Total: 0 };
  if (lastRow < 3) return empty;
  var top = sh.getRange(1, 1, 2, lastCol).getValues();
  var hdr = top[1];
  var H = wbHeaderIndex_(hdr);
  var dateCols = {};
  var dates = [];
  hdr.forEach(function (v, i) {
    if (v instanceof Date) { var k = wbKey_(v); dateCols[k] = i + 1; dates.push(k); }
  });
  var colA = sh.getRange(3, 1, lastRow - 2, 1).getValues();
  var lastPan = 0;
  for (var i = colA.length - 1; i >= 0; i--) { if (String(colA[i][0] || '').trim()) { lastPan = i + 1; break; } }
  if (!lastPan) { empty.H = H; empty.dates = dates; empty.dateCols = dateCols; return empty; }
  var fixedW = 1;
  Object.keys(H).forEach(function (k) { fixedW = Math.max(fixedW, H[k] + 1); });
  var fixed = sh.getRange(3, 1, lastPan, fixedW).getValues();
  var today = wbKey_(new Date());
  var winStart = wbAddDays_(today.slice(0, 8) + '01', -31);
  var winDates = dates.filter(function (d) { return d >= winStart && d <= today; }).sort();
  var win = [];
  var winFirst = 0;
  if (winDates.length) {
    winFirst = dateCols[winDates[0]];
    var winLast = dateCols[winDates[winDates.length - 1]];
    var lo = Math.min(winFirst, winLast);
    var hi = Math.max(winFirst, winLast);
    winFirst = lo;
    win = sh.getRange(3, lo, lastPan, hi - lo + 1).getValues();
  }
  var pastDates = winDates.slice().reverse();
  var num = function (row, k) { var v = H[k] === undefined ? 0 : row[H[k]]; return typeof v === 'number' ? v : Number(v) || 0; };
  var str = function (row, k) {
    var v = H[k] === undefined ? '' : row[H[k]];
    if (v === null || v === undefined) return '';
    return v instanceof Date ? wbKey_(v) : String(v);
  };
  var amt = function (row, k) { var v = H[k] === undefined ? '' : row[H[k]]; return v === '' || v === null ? '' : Number(v) || 0; };
  var cfg = wbSettings_();
  var staleDays = Number(cfg.STALE_DAYS) || 3;
  var rows = [];
  for (var r = 0; r < lastPan; r++) {
    var row = fixed[r];
    var pan = String(row[0] || '').trim();
    if (!pan) continue;
    var daily = {};
    winDates.forEach(function (d) {
      var v = win[r][dateCols[d] - winFirst];
      if (v !== '' && v !== null && v !== undefined) daily[d] = String(v);
    });
    var last = '';
    for (var j = 0; j < pastDates.length; j++) {
      if (WB.TOUCHED.indexOf(daily[pastDates[j]]) >= 0) { last = pastDates[j]; break; }
    }
    var o = {
      row: r + 3, pan: pan,
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
      red: amt(row, 'red'), yellow: amt(row, 'yellow'), green: amt(row, 'green'),
      today: daily[today] || '', lastTouch: last,
      mtdTouches: Object.keys(daily).filter(function (d) {
        return d.slice(0, 7) === today.slice(0, 7) && d <= today && WB.TOUCHED.indexOf(daily[d]) >= 0;
      }).length,
      recent: [0, 1, 2, 3, 4, 5, 6].map(function (k) { return daily[wbAddDays_(today, -k)] || ''; }),
      daily: daily
    };
    ['customer', 'brands', 'kams', 'kamMgr', 'bizModel', 'buHead', 'cat1', 'cat2', 'bizfin', 'months'].forEach(function (k) {
      if (/^#(N\/A|REF!|VALUE!|ERROR!|DIV\/0!)/.test(o[k])) o[k] = '';
    });
    o.stale = o.overdue > 0 && wbWorkdaysSince_(last, today, cfg) >= staleDays;
    rows.push(o);
  }
  var totalCol = H.total;
  return {
    rows: rows, dates: dates, dateCols: dateCols, H: H, lastPanRow: lastPan + 2, winDates: winDates,
    row1Total: totalCol === undefined ? null : (typeof top[0][totalCol] === 'number' ? top[0][totalCol] : null)
  };
}

/** Working days after `last` up to and including yesterday (never touched = a big number). */
function wbWorkdaysSince_(last, today, cfg) {
  if (!last) return 999;
  var n = 0;
  for (var d = wbAddDays_(last, 1); d < today; d = wbAddDays_(d, 1)) if (wbIsWorkday_(d, cfg)) n++;
  return n;
}
function wbIsWorkday_(key, cfg) {
  var dw = wbDow_(key);
  if (dw === 0) return false;
  if (dw === 6 && (cfg || wbSettings_()).WORK_WEEK === 'Mon-Fri') return false;
  return true;
}

/** Parse one tab into a cacheable book: slim rows + stats (coverage, ageing, confidence, 21-day trend). */
function wbBuildBook_(sh) {
  var b = wbReadAssocSheet_(sh);
  var today = wbKey_(new Date());
  var monthStart = today.slice(0, 8) + '01';
  var cfg = wbSettings_();
  var active = b.rows.filter(function (r) { return r.total !== 0; });
  var st = {
    pans: b.rows.length, active: active.length, touchedToday: 0, stale: 0, total: 0, overdue: 0, gt60: 0,
    netPayable: 0, possibleArAp: 0, possibleArAp60: 0, possibleArApHist: 0, overdueAccts: 0, gt60Accts: 0,
    remarksFilled: 0, remarksOnOverdue: 0, exposureAccts: 0, red: 0, yellow: 0, green: 0,
    b: [0, 0, 0, 0, 0, 0, 0], mtdCov: 0, trend: [], row1Total: b.row1Total, sumTotal: 0,
    hasToday: !!b.dateCols[today], lastPanRow: b.lastPanRow
  };
  b.rows.forEach(function (r) {
    st.sumTotal += r.total;
    if (r.remarks) st.remarksFilled++;
    if (r.exposure === 'Yes') st.exposureAccts++;
    st.red += Number(r.red) || 0; st.yellow += Number(r.yellow) || 0; st.green += Number(r.green) || 0;
  });
  active.forEach(function (r) {
    if (WB.TOUCHED.indexOf(r.today) >= 0) st.touchedToday++;
    if (r.stale) st.stale++;
    st.total += r.total; st.overdue += r.overdue; st.gt60 += r.gt60; st.netPayable += r.netPayable;
    st.possibleArAp += r.possibleArAp; st.possibleArAp60 += r.possibleArAp60;
    if (r.arApHist === 'Yes') st.possibleArApHist += r.possibleArAp;
    if (r.overdue !== 0) { st.overdueAccts++; if (r.remarks) st.remarksOnOverdue++; }
    if (r.gt60 !== 0) st.gt60Accts++;
    for (var i = 0; i < 7; i++) st.b[i] += r['b' + i];
  });
  var workdays = (b.winDates || []).filter(function (d) { return d >= monthStart && d <= today && wbIsWorkday_(d, cfg); });
  var touchedOn = function (d) { return active.filter(function (r) { return WB.TOUCHED.indexOf(r.daily[d]) >= 0; }).length; };
  st.mtdCov = active.length && workdays.length
    ? workdays.reduce(function (s, d) { return s + touchedOn(d) / active.length; }, 0) / workdays.length : 0;
  for (var k = 20; k >= 0; k--) {
    var d = wbAddDays_(today, -k);
    var counts = {};
    active.forEach(function (r) { var v = r.daily[d]; if (v) counts[v] = (counts[v] || 0) + 1; });
    st.trend.push({ date: d, counts: counts, cov: active.length ? touchedOn(d) / active.length : 0 });
  }
  return {
    assoc: sh.getName(), builtAt: new Date().toISOString(),
    rows: b.rows.map(function (r) { return WB_BOOK_FIELDS.map(function (f) { return r[f]; }); }),
    stats: st
  };
}

/** Books for several associates. fresh=true reads the tabs live; otherwise cached (WB.BOOK_TTL). */
function wbBooks_(names, fresh) {
  var ss = SpreadsheetApp.getActive();
  var out = {};
  names.forEach(function (n) {
    var b = fresh ? null : wbCacheGet_(WB.BOOK_PREFIX + n);
    if (!b) {
      var sh = ss.getSheetByName(n);
      if (!sh) return;
      b = wbBuildBook_(sh);
      wbCachePut_(WB.BOOK_PREFIX + n, b, WB.BOOK_TTL);
    }
    out[n] = {
      assoc: n, builtAt: b.builtAt, stats: b.stats,
      rows: b.rows.map(function (a) { var o = {}; WB_BOOK_FIELDS.forEach(function (f, i) { o[f] = a[i]; }); return o; })
    };
  });
  return out;
}

function wbDropBook_(name) {
  if (!name) return;
  var cache = CacheService.getScriptCache();
  cache.remove(WB.BOOK_PREFIX + name + '_meta');
}

/** Add PTP roll-up, IO status, next follow-up, confidence and priority to a book row. */
function wbDecorateRow_(r, roll, ioRec, nextFu, today) {
  roll = roll || {};
  r.ptpOpen = roll.open || 0; r.ptpAmt = roll.amt || 0; r.ptpBroken = roll.broken || 0;
  r.ptpDueToday = roll.dueToday || 0; r.ptpNext = roll.next || '';
  r.io = ioRec ? (ioRec.done ? 'Signed' : 'Pending') : '';
  r.ioRate = ioRec ? ioRec.rate : 0;
  r.nextFollowUp = nextFu || '';
  r.daysSince = r.lastTouch ? wbDiffDays_(r.lastTouch, today) : null;
  var best = '';
  var max = 0;
  [['Red', r.red], ['Yellow', r.yellow], ['Green', r.green]].forEach(function (x) {
    if ((Number(x[1]) || 0) > max) { max = Number(x[1]); best = x[0]; }
  });
  r.confidence = best;
  r.priority = wbPriority_(r, today);
  return r;
}

function wbSlim_(r) {
  return {
    pan: r.pan, customer: r.customer, owner: r.owner, brands: r.brands, bizModel: r.bizModel, exposure: r.exposure,
    total: r.total, overdue: r.overdue, gt60: r.gt60, possibleArAp: r.possibleArAp, netPayable: r.netPayable,
    ptpOpen: r.ptpOpen, ptpNext: r.ptpNext, ptpBroken: r.ptpBroken, daysSince: r.daysSince, today: r.today,
    remarks: r.remarks, tlRemarks: r.tlRemarks, confidence: r.confidence, io: r.io, ioRate: r.ioRate,
    recent: r.recent, priority: r.priority, stale: r.stale
  };
}

function wbPriority_(r, today) {
  // Higher = work first. Money at risk (log scale) + staleness + promises gone wrong + flags.
  var s = 0;
  s += r.overdue > 0 ? Math.log10(r.overdue + 1) * 10 : 0;
  s += r.gt60 > 0 ? Math.log10(r.gt60 + 1) * 6 : 0;
  s += r.daysSince === null ? 25 : Math.min(r.daysSince, 10) * 3;
  s += (r.ptpBroken || 0) * 20 + (r.ptpDueToday || 0) * 15;
  if (r.exposure === 'Yes') s += 10;
  if (r.possibleArAp > 0) s += 5;
  if (r.confidence === 'Red') s += 8;
  if (r.today) s -= 40;
  if (r.nextFollowUp && r.nextFollowUp <= today) s += 15;
  return Math.round(s);
}

/** One PAN's full row from a tab, with the 14-day follow-up strip. */
function wbPanRow_(sh, pan) {
  if (!sh) return null;
  var r = wbFindRow_(sh, pan);
  if (!r) return null;
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(2, 1, 1, lastCol).getValues()[0];
  var vals = sh.getRange(r, 1, 1, lastCol).getValues()[0];
  var H = wbHeaderIndex_(hdr);
  var today = wbKey_(new Date());
  var num = function (k) { var v = H[k] === undefined ? 0 : vals[H[k]]; return typeof v === 'number' ? v : Number(v) || 0; };
  var str = function (k) {
    var v = H[k] === undefined ? '' : vals[H[k]];
    var s = v === null || v === undefined ? '' : (v instanceof Date ? wbKey_(v) : String(v));
    return /^#(N\/A|REF!|VALUE!|ERROR!)/.test(s) ? '' : s;
  };
  var amt = function (k) { var v = H[k] === undefined ? '' : vals[H[k]]; return v === '' || v === null ? '' : Number(v) || 0; };
  var daily = {};
  hdr.forEach(function (h, i) {
    if (h instanceof Date) { var k = wbKey_(h); if (vals[i] !== '' && vals[i] !== null) daily[k] = String(vals[i]); }
  });
  var past = Object.keys(daily).filter(function (d) { return d <= today; }).sort().reverse();
  var last = '';
  for (var i = 0; i < past.length; i++) if (WB.TOUCHED.indexOf(daily[past[i]]) >= 0) { last = past[i]; break; }
  var o = { row: r, pan: pan, owner: sh.getName() };
  Object.keys(WB_COLS).forEach(function (k) { if (k !== 'pan') o[k] = str(k); });
  ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'total', 'overdue', 'netPayable', 'possibleArAp', 'gt60', 'possibleArAp60']
    .forEach(function (k) { o[k] = num(k); });
  ['red', 'yellow', 'green'].forEach(function (k) { o[k] = amt(k); });
  o.today = daily[today] || '';
  o.lastTouch = last;
  o.daily14 = [];
  for (var k = 13; k >= 0; k--) { var d = wbAddDays_(today, -k); o.daily14.push({ date: d, v: daily[d] || '' }); }
  o.recent = [0, 1, 2, 3, 4, 5, 6].map(function (k) { return daily[wbAddDays_(today, -k)] || ''; });
  o.mtdTouches = Object.keys(daily).filter(function (d) { return d.slice(0, 7) === today.slice(0, 7) && d <= today && WB.TOUCHED.indexOf(daily[d]) >= 0; }).length;
  o.stale = o.overdue > 0 && wbWorkdaysSince_(last, today, wbSettings_()) >= (Number(wbSettings_().STALE_DAYS) || 3);
  return o;
}

function wbFindRow_(sh, pan) {
  if (!sh || sh.getLastRow() < 3) return 0;
  var k = 'row|' + sh.getName() + '|' + pan;
  if (wbMemoStore_[k]) return wbMemoStore_[k]; // same execution: found a moment ago (writes never move rows)
  var f = sh.getRange(3, 1, sh.getLastRow() - 2, 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (f) wbMemoStore_[k] = f.getRow();
  return f ? f.getRow() : 0;
}

/** First row after the last PAN whose PAN cell is empty (the tabs keep formula rows ready below). */
function wbFreeRow_(sh) {
  var last = sh.getLastRow();
  if (last < 3) return 3;
  var colA = sh.getRange(3, 1, last - 2, 1).getValues();
  var lastPan = 0;
  for (var i = colA.length - 1; i >= 0; i--) { if (String(colA[i][0] || '').trim()) { lastPan = i + 1; break; } }
  return lastPan + 3;
}

/** PAN -> [{assoc, row}] from column A of every associate tab (cached 10 min). */
function wbOwnerIndex_(force) {
  if (!force) {
    if (wbMemoStore_.owners) return wbMemoStore_.owners;
    var hit = wbCacheGet_('wb_owner_idx');
    if (hit) return (wbMemoStore_.owners = hit);
  }
  var ss = SpreadsheetApp.getActive();
  var byPan = {};
  wbAssociateSheets_(ss).forEach(function (sh) {
    var last = sh.getLastRow();
    if (last < 3) return;
    sh.getRange(3, 1, last - 2, 1).getValues().forEach(function (v, i) {
      var p = String(v[0] || '').trim();
      if (p) (byPan[p] = byPan[p] || []).push({ assoc: sh.getName(), row: i + 3 });
    });
  });
  var out = { byPan: byPan, builtAt: new Date().toISOString() };
  wbCachePut_('wb_owner_idx', out, 600); // ~120 kB for 3k PANs: chunked (a single cache value is capped at 100 kB)
  wbMemoStore_.owners = out;
  return out;
}

/** Associate tab(s) holding the PAN. Verified against the tab so a stale cache never sends a write to the wrong row. */
function wbOwnersOf_(pan) {
  pan = String(pan || '').trim();
  if (!pan) return [];
  var ss = SpreadsheetApp.getActive();
  var hit = (wbOwnerIndex_().byPan[pan] || []).map(function (x) { return x.assoc; });
  var ok = hit.filter(function (n) { return wbFindRow_(ss.getSheetByName(n), pan); });
  if (ok.length) return ok;
  var found = [];
  wbAssociateSheets_(ss).forEach(function (sh) { if (wbFindRow_(sh, pan)) found.push(sh.getName()); });
  if (found.length) wbDropOwners_();
  return found;
}

function wbConsolidated_(ss) {
  return wbMemo_('cons', function () {
    var hit = wbCacheGet_(WB.CACHE_PREFIX + 'cons');
    if (hit) return hit;
    var fresh = wbReadConsolidated_(ss);
    wbCachePut_(WB.CACHE_PREFIX + 'cons', fresh, 1800);
    return fresh;
  });
}

function wbReadConsolidated_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_CONSOLIDATED);
  var out = { byPan: {} };
  if (!sh || sh.getLastRow() < 3) return out;
  sh.getRange(3, 1, sh.getLastRow() - 2, 3).getValues().forEach(function (r, i) {
    var p = String(r[0] || '').trim();
    if (!p || out.byPan[p]) return;
    var c = r[1] instanceof Date ? '' : String(r[1] || '');
    out.byPan[p] = { customer: /^#/.test(c) ? '' : c, assoc: String(r[2] || '').trim(), row: i + 3 };
  });
  return out;
}

function wbSetConsolidatedOwner_(ss, pan, owner) {
  var sh = ss.getSheetByName(WB.SHEET_CONSOLIDATED);
  if (!sh) return;
  var r = wbFindRow_(sh, pan);
  if (!r) {
    r = wbFreeRow_(sh);
    wbEnsureFormulaRow_(sh, r, Math.max(sh.getLastColumn() - 1, 0));
    sh.getRange(r, 1).setValue(pan);
  }
  sh.getRange(r, 3).setValue(owner);
  wbDropCache_('cons');
}

/**
 * Make sure `row` carries the tab's formulas before a PAN is written into it. The tabs keep ~1,000 ready formula
 * rows below the last PAN; if they ever run out, the sheet is extended and columns B.. are copied from the row above.
 */
function wbEnsureFormulaRow_(sh, row, width) {
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), row - sh.getMaxRows());
  if (row <= 3 || width < 1) return;
  var probe = sh.getRange(row, 2);
  if (probe.getFormula() || probe.getValue() !== '') return; // a ready formula row
  var src = sh.getRange(row - 1, 2, 1, width);
  if (!src.getFormulas()[0].some(function (f) { return !!f; })) return;
  src.copyTo(sh.getRange(row, 2, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
}

// ---------------------------------------------------------------------------
// Internals: invoices
// ---------------------------------------------------------------------------

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
  var g = function (k) { return C[k] < 0 ? '' : row[C[k]]; };
  return {
    pan: s(g('pan')), month: s(g('month')), invDate: d(g('invDate')), dueDate: d(g('dueDate')),
    credit: n(g('credit')), inv: s(g('inv')), cust: s(g('cust')), kam: s(g('kam')),
    kamMgr: s(g('kamMgr')), assoc: s(g('assoc')), tds: n(g('tds')), receipt: n(g('receipt')),
    receiptDate: d(g('receiptDate')), arap: n(g('arap')), net: n(g('net')), brand: s(g('brand')),
    ageing: n(g('ageing')), bucket: s(g('bucket'))
  };
}

/**
 * Open invoices (Net to be received != 0) indexed by PAN and invoice no.
 * Imported_Data is ~66k rows but only ~3.3k are open, so the open set is cached (chunked, shared by all users)
 * and rebuilt when the row count of Imported_Data changes or every 6 h.
 */
function wbOpenInvoices_(force) {
  var ss = SpreadsheetApp.getActive();
  var inv = wbInvSheet_(ss);
  var lastRow = inv.sh.getLastRow();
  var cache = CacheService.getScriptCache();
  var list = null;
  var builtAt = '';
  if (!force) {
    var hit = wbCacheGet_(WB.CACHE_PREFIX + 'open');
    if (hit && hit.lastRow === lastRow) { list = hit.list; builtAt = hit.builtAt; }
  }
  if (!list) {
    var values = lastRow >= inv.first ? inv.sh.getRange(inv.first, 1, lastRow - inv.first + 1, inv.width).getValues() : [];
    list = [];
    values.forEach(function (row) {
      var net = row[inv.C.net];
      if (!row[inv.C.inv] || !net || Number(net) === 0) return;
      var r = wbInvRecord_(row, inv.C);
      list.push(WB_OPEN_FIELDS.map(function (f) { return r[f]; }));
    });
    builtAt = new Date().toISOString();
    wbCachePut_(WB.CACHE_PREFIX + 'open', { lastRow: lastRow, list: list, builtAt: builtAt }, WB.CACHE_TTL);
  }
  var byPan = {};
  var byInv = {};
  list.forEach(function (a) {
    var o = {};
    WB_OPEN_FIELDS.forEach(function (f, i) { o[f] = a[i]; });
    (byPan[o.pan] = byPan[o.pan] || []).push(o);
    byInv[o.inv] = o;
  });
  return { byPan: byPan, byInv: byInv, count: list.length, builtAt: builtAt };
}

/** Every invoice (open + settled) keyed by invoice no - used by the scheduled PTP refresh only. */
function wbAllInvoiceIndex_(ss) {
  var inv = wbInvSheet_(ss);
  var lastRow = inv.sh.getLastRow();
  if (lastRow < inv.first) return {};
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
  if (inv.sh.getLastRow() < inv.first) return null;
  var f = inv.sh.getRange(inv.first, inv.C.inv + 1, inv.sh.getLastRow() - inv.first + 1, 1)
    .createTextFinder(invNo).matchEntireCell(true).findNext();
  if (!f) return null;
  return wbInvRecord_(inv.sh.getRange(f.getRow(), 1, 1, inv.width).getValues()[0], inv.C);
}

/** Latest settled invoices for the PAN (TextFinder keeps this cheap on 66k rows). */
function wbRecentPaid_(ss, pan, limit) {
  var inv = wbInvSheet_(ss);
  if (inv.sh.getLastRow() < inv.first) return [];
  var cells = inv.sh.getRange(inv.first, inv.C.pan + 1, inv.sh.getLastRow() - inv.first + 1, 1)
    .createTextFinder(pan).matchEntireCell(true).findAll();
  var rows = cells.map(function (c) { return c.getRow(); }).sort(function (a, b) { return b - a; }).slice(0, limit * 4);
  if (!rows.length) return [];
  // Rows are appended chronologically: take the newest. Read them in one block when they sit close together.
  var lo = rows[rows.length - 1];
  var hi = rows[0];
  var get;
  if (hi - lo < 4000) {
    var block = inv.sh.getRange(lo, 1, hi - lo + 1, inv.width).getValues();
    get = function (r) { return block[r - lo]; };
  } else {
    get = function (r) { return inv.sh.getRange(r, 1, 1, inv.width).getValues()[0]; };
  }
  var out = [];
  for (var i = 0; i < rows.length && out.length < limit; i++) {
    var rec = wbInvRecord_(get(rows[i]), inv.C);
    if (rec.net === 0 && rec.inv) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals: payables, IO rate card
// ---------------------------------------------------------------------------

/**
 * Payable Data - Daily has two blocks: A:D one row per PAN (PAN Number, PAN Name, Net Payable, Business Models)
 * and L:Q one row per vendor code (Vendor Code, Vendor Name, Business Model, Total Payable, Inventory, PAN Number).
 */
function wbPayablesOf_(ss, pan) {
  var idx = wbPayIndex_(ss);
  var s = idx.pan[pan];
  var out = { found: !!s, name: s ? s[0] : '', net: s ? s[1] : 0, model: s ? s[2] : '', vendors: [] };
  (idx.vendors[pan] || []).slice(0, 60).forEach(function (x) {
    out.vendors.push({ code: x[0], name: x[1], model: x[2], payable: x[3], inventory: x[4] });
  });
  out.vendors.sort(function (a, b) { return b.payable - a.payable; });
  return out;
}

/** Whole Payables tab in one read, indexed by PAN; cached until its row count changes (or 6 h). */
function wbPayIndex_(ss) {
  return wbMemo_('pay', function () {
    var sh = ss.getSheetByName(WB.SHEET_PAY);
    var empty = { pan: {}, vendors: {}, lastRow: 0 };
    if (!sh || sh.getLastRow() < 2) return empty;
    var lastRow = sh.getLastRow();
    var hit = wbCacheGet_(WB.CACHE_PREFIX + 'pay');
    if (hit && hit.lastRow === lastRow) return hit;
    var width = Math.min(sh.getLastColumn(), 17);
    var vals = sh.getRange(2, 1, lastRow - 1, width).getValues();
    var out = { pan: {}, vendors: {}, lastRow: lastRow };
    vals.forEach(function (r, i) {
      var p = wbStr_(r[0]);
      if (p && !out.pan[p]) out.pan[p] = [wbStr_(r[1]), wbNum_(r[2]), wbStr_(r[3]), i + 2];
      if (width >= 17) {
        var vp = wbStr_(r[16]);
        if (vp) (out.vendors[vp] = out.vendors[vp] || []).push([wbStr_(r[11]), wbStr_(r[12]), wbStr_(r[13]), wbNum_(r[14]), wbNum_(r[15])]);
      }
    });
    wbCachePut_(WB.CACHE_PREFIX + 'pay', out, WB.CACHE_TTL);
    return out;
  });
}

function wbIoCols_(hdr) {
  var norm = hdr.map(wbNorm_);
  var find = function (names, prefix) {
    for (var i = 0; i < names.length; i++) {
      var n = wbNorm_(names[i]);
      for (var j = 0; j < norm.length; j++) if (prefix ? norm[j].indexOf(n) === 0 : norm[j] === n) return j;
    }
    return -1;
  };
  var assocCols = [];
  norm.forEach(function (h, i) { if (h.indexOf('associate name') === 0 || h.indexOf('associate') === 0) assocCols.push(i); });
  return {
    pan: Math.max(find(['PAN']), 0), customer: find(['Customer Name']), avgInv: find(['Avg. Invoicing Last 6M'], true),
    band: find(['Billing Band']), arap50: find(['AR-AP > 50%?'], true), rate: find(['IO Sign-off Rate'], true),
    prevAssoc: assocCols.length > 1 ? assocCols[assocCols.length - 2] : -1,
    assoc: assocCols.length ? assocCols[assocCols.length - 1] : -1,
    link: find(['IO Sign off Link']), remarks: find(['Remarks']), folder: find(['Folder Link'], true),
    pdf: find(['IO Signed Brand PDF']), signedOn: find(['IO Signed On']), updatedBy: find(['IO Updated By'])
  };
}

/** IO Sign Off Rate Card -> {byPan, rows}. Signed = "IO Sign off Link" is filled. Cached 10 min, dropped on save. */
function wbReadIo_(ss) {
  return wbMemo_('io', function () {
    var hit = wbCacheGet_(WB.CACHE_PREFIX + 'io');
    var rows = hit ? wbUnpack_(hit) : null;
    if (!rows) {
      rows = wbReadIoSheet_(ss).rows;
      wbCachePut_(WB.CACHE_PREFIX + 'io', wbPack_(rows), 600);
    }
    var byPan = {};
    rows.forEach(function (r) { byPan[r.pan] = r; });
    return { byPan: byPan, rows: rows };
  });
}

function wbReadIoSheet_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_IO);
  var out = { byPan: {}, rows: [] };
  if (!sh || sh.getLastRow() < 2) return out;
  var lastCol = sh.getLastColumn();
  var vals = sh.getRange(1, 1, sh.getLastRow(), lastCol).getValues();
  var C = wbIoCols_(vals[0]);
  var g = function (row, k) { return C[k] < 0 ? '' : row[C[k]]; };
  for (var i = 1; i < vals.length; i++) {
    var row = vals[i];
    var pan = wbStr_(g(row, 'pan'));
    if (!wbIsPan_(pan) || out.byPan[pan]) continue;
    var so = g(row, 'signedOn');
    var rec = {
      row: i + 1, pan: pan, customer: wbStr_(g(row, 'customer')), avgInv: wbNum_(g(row, 'avgInv')),
      band: wbStr_(g(row, 'band')), arap50: wbStr_(g(row, 'arap50')), rate: wbNum_(g(row, 'rate')),
      prevAssoc: wbStr_(g(row, 'prevAssoc')), assoc: wbStr_(g(row, 'assoc')), link: wbStr_(g(row, 'link')),
      remarks: wbStr_(g(row, 'remarks')), folder: wbStr_(g(row, 'folder')), pdf: wbStr_(g(row, 'pdf')),
      signedOn: so instanceof Date ? wbKey_(so) : '', updatedBy: wbStr_(g(row, 'updatedBy'))
    };
    rec.done = !!rec.link;
    out.byPan[pan] = rec;
    out.rows.push(rec);
  }
  return out;
}

function wbIoByAssoc_(rows, monthStart) {
  var by = {};
  rows.forEach(function (r) {
    var o = by[r.assoc] || (by[r.assoc] = { pans: 0, done: 0, pending: 0, earned: 0, earnedMonth: 0, month: 0 });
    o.pans++;
    if (r.done) {
      o.done++; o.earned += r.rate;
      if (r.signedOn >= monthStart) { o.month++; o.earnedMonth += r.rate; }
    } else o.pending++;
  });
  return by;
}

// ---------------------------------------------------------------------------
// Internals: PTP Tracker
// ---------------------------------------------------------------------------

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
  wbAddHeaders_(sh, WB.PTP_EXTRA_HEADERS, 12);
  return sh;
}

function wbEnsureIoHeaders_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_IO);
  if (!sh) return null;
  wbAddHeaders_(sh, WB.IO_EXTRA_HEADERS, 12);
  return sh;
}

/** Append missing headers after the last filled header cell of row 1. */
function wbAddHeaders_(sh, headers, minCols) {
  var lastCol = Math.max(sh.getLastColumn(), minCols);
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var norm = hdr.map(wbNorm_);
  var missing = headers.filter(function (h) { return norm.indexOf(wbNorm_(h)) < 0; });
  if (!missing.length) return;
  var lastFilled = 0;
  hdr.forEach(function (h, i) { if (String(h || '').trim()) lastFilled = i + 1; });
  sh.getRange(1, lastFilled + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#e8f0fe');
}

/** PTP Tracker, parsed. Cached (10 min, dropped on every workbench write to the tracker). */
function wbReadPtp_(ss) {
  return wbMemo_('ptp', function () {
    var hit = wbCacheGet_(WB.CACHE_PREFIX + 'ptp');
    if (hit) return { rows: wbUnpack_(hit.rows), H: hit.H };
    var fresh = wbReadPtpSheet_(ss);
    wbCachePut_(WB.CACHE_PREFIX + 'ptp', { rows: wbPack_(fresh.rows), H: fresh.H }, 600);
    return fresh;
  });
}

function wbReadPtpSheet_(ss) {
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
    var outRaw = g(row, 'outstanding');
    rows.push({
      row: i + 1, invoice: inv, customer: String(g(row, 'customer') || ''), brand: String(g(row, 'brand') || ''),
      associate: String(g(row, 'associate') || '').trim(), dueDate: dk(g(row, 'dueDate')),
      added: Number(g(row, 'added')) || 0, outstanding: outRaw === '' ? 0 : Number(outRaw) || 0,
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
      if (H.associate !== undefined && !cur[H.associate] && u.defaults.associate) cur[H.associate] = u.defaults.associate;
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
  wbDropCache_('ptp');
}

/** Live PTP status. Legacy hand-typed statuses ("Settled", "PTP Breached") are respected when no date is set. */
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

/** PAN -> {open, amt, next, broken, dueToday} over PTP rows with a date and an unpaid balance. */
function wbPtpRollup_(rows, today) {
  var by = {};
  rows.forEach(function (p) {
    if (!p.pan || !p.ptpDate || !(p.outstanding > 0)) return;
    var b = by[p.pan] || (by[p.pan] = { open: 0, amt: 0, next: '', broken: 0, dueToday: 0 });
    b.open++;
    b.amt += p.ptpAmount === '' ? p.outstanding : Math.min(Number(p.ptpAmount) || 0, p.outstanding) || p.outstanding;
    if (p.ptpDate < today) b.broken++;
    else if (p.ptpDate === today) b.dueToday++;
    if (p.ptpDate >= today && (!b.next || p.ptpDate < b.next)) b.next = p.ptpDate;
  });
  return by;
}

function wbPtpStats_(rows) {
  var s = { given: 0, givenAmt: 0, kept: 0, keptAmt: 0, broken: 0, brokenAmt: 0, open: 0, openAmt: 0, partial: 0, missed: 0 };
  rows.forEach(function (p) {
    var st = wbPtpStatus_(p.ptpDate, p.outstanding, p.added, p.settlement);
    var amt = p.ptpAmount === '' ? (p.added || p.outstanding || 0) : Number(p.ptpAmount) || 0;
    s.given++; s.givenAmt += amt;
    if (st === 'Paid (PTP Kept)') { s.kept++; s.keptAmt += amt; }
    else if (st === 'Paid (after PTP)') { s.missed++; s.keptAmt += amt; }
    else if (st === 'PTP Broken') { s.broken++; s.brokenAmt += p.outstanding; }
    else { s.open++; s.openAmt += p.outstanding; if (st === 'Partially Paid') s.partial++; }
  });
  var closed = s.kept + s.missed + s.broken;
  s.keptRate = closed ? s.kept / closed : null;
  return s;
}

// ---------------------------------------------------------------------------
// Internals: overview totals, snapshots, health checks
// ---------------------------------------------------------------------------

function wbEmptyTotals_() {
  return { active: 0, pans: 0, total: 0, overdue: 0, gt60: 0, netPayable: 0, possibleArAp: 0, possibleArApHist: 0,
    possibleArAp60: 0, touchedToday: 0, stale: 0, red: 0, yellow: 0, green: 0, b: [0, 0, 0, 0, 0, 0, 0],
    ptpOpen: 0, ptpAmt: 0, broken: 0, mtdTouchWeighted: 0, overdueAccts: 0, gt60Accts: 0, exposureAccts: 0 };
}

function wbAddTotals_(tot, st, a) {
  tot.active += st.active; tot.pans += st.pans; tot.total += st.total; tot.overdue += st.overdue; tot.gt60 += st.gt60;
  tot.netPayable += st.netPayable; tot.possibleArAp += st.possibleArAp; tot.possibleArApHist += st.possibleArApHist;
  tot.possibleArAp60 += st.possibleArAp60; tot.touchedToday += st.touchedToday; tot.stale += st.stale;
  tot.red += st.red; tot.yellow += st.yellow; tot.green += st.green;
  tot.overdueAccts += st.overdueAccts; tot.gt60Accts += st.gt60Accts; tot.exposureAccts += st.exposureAccts;
  for (var i = 0; i < 7; i++) tot.b[i] += st.b[i];
  tot.ptpOpen += a.ptpOpen; tot.ptpAmt += a.ptpAmt; tot.broken += a.broken;
  tot.mtdTouchWeighted += st.mtdCov * st.active;
}

function wbReadSnapshots_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_SNAP);
  if (!sh || sh.getLastRow() < 2) return [];
  var by = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, WB.SNAP_HEADERS.length).getValues().forEach(function (r) {
    if (!(r[0] instanceof Date)) return;
    var d = wbKey_(r[0]);
    var o = by[d] || (by[d] = { date: d, active: 0, total: 0, overdue: 0, gt60: 0, touched: 0, broken: 0, ptpAmt: 0, ioSigned: 0 });
    o.active += wbNum_(r[2]); o.total += wbNum_(r[3]); o.overdue += wbNum_(r[4]); o.gt60 += wbNum_(r[5]);
    o.touched += wbNum_(r[8]); o.ptpAmt += wbNum_(r[12]); o.broken += wbNum_(r[13]); o.ioSigned += wbNum_(r[14]);
  });
  return Object.keys(by).sort().slice(-60).map(function (k) {
    var o = by[k];
    o.cov = o.active ? o.touched / o.active : 0;
    return o;
  });
}

/**
 * Data health checks - the things that silently make the Summary wrong.
 * Each check: {id, level: ok|warn|bad, title, detail, items:[{pan, customer, amount, note, owner}]}
 */
function wbHealth_(ss, books, names) {
  var checks = [];
  var today = wbKey_(new Date());
  var idx = wbOwnerIndex_(true);
  var open = wbOpenInvoices_(false);
  var cons = wbConsolidated_(ss);
  var fmt = wbInr_;

  // 1. Tab total row (SUBTOTAL) vs the PAN rows: filters / hidden rows / short SUBTOTAL ranges understate the Summary.
  var tabIssues = [];
  names.forEach(function (n) {
    var st = (books[n] || {}).stats;
    if (!st || st.row1Total === null || st.row1Total === undefined) return;
    if (Math.abs(st.row1Total - st.sumTotal) > 1) {
      tabIssues.push({ owner: n, amount: st.sumTotal - st.row1Total,
        note: 'Total row shows ' + fmt(st.row1Total) + ' but its PAN rows add up to ' + fmt(st.sumTotal) +
          ' - a filter is hiding rows or the SUBTOTAL range stops early.' });
    }
  });
  checks.push({ id: 'subtotal', level: tabIssues.length ? 'bad' : 'ok',
    title: tabIssues.length ? tabIssues.length + ' associate tab(s) under-report their total on the Summary' : 'Associate tab totals match their PAN rows',
    detail: 'The Summary reads each tab\'s total row, which uses SUBTOTAL (skips filtered-out rows).', items: tabIssues });

  // 2. Open invoices whose PAN is on no associate tab.
  var unassigned = [];
  Object.keys(open.byPan).forEach(function (p) {
    if (!p || idx.byPan[p]) return;
    var list = open.byPan[p];
    var amt = list.reduce(function (s, i) { return s + i.net; }, 0);
    if (amt !== 0) unassigned.push({ pan: p, customer: (list[0] || {}).cust || '', amount: amt, note: list.length + ' open invoice(s)' });
  });
  unassigned.sort(function (a, b) { return b.amount - a.amount; });
  var unTot = unassigned.reduce(function (s, x) { return s + x.amount; }, 0);
  checks.push({ id: 'unassigned', level: unassigned.length ? 'bad' : 'ok',
    title: unassigned.length ? unassigned.length + ' PAN(s) with ' + fmt(unTot) + ' open are on no associate tab' : 'Every PAN with an open invoice has an owner',
    detail: 'These are missing from the Summary total (the "Overall Check" gap). Assign them from here.', items: unassigned.slice(0, 50) });

  // 3. PANs on more than one tab (double counted).
  var dups = [];
  Object.keys(idx.byPan).forEach(function (p) {
    if (idx.byPan[p].length > 1) dups.push({ pan: p, customer: (cons.byPan[p] || {}).customer || '',
      note: idx.byPan[p].map(function (x) { return x.assoc + ' r' + x.row; }).join(', ') });
  });
  checks.push({ id: 'duplicates', level: dups.length ? 'bad' : 'ok',
    title: dups.length ? dups.length + ' PAN(s) appear on more than one tab' : 'No PAN is on two tabs',
    detail: 'Duplicates are counted twice in the Summary.', items: dups.slice(0, 50) });

  // 4. Consolidated owner differs from the tab that holds the PAN.
  var mism = [];
  Object.keys(idx.byPan).forEach(function (p) {
    var c = cons.byPan[p];
    var owner = idx.byPan[p][0].assoc;
    if (!c) mism.push({ pan: p, owner: owner, note: 'not on Consolidated' });
    else if (c.assoc && c.assoc !== owner && idx.byPan[p].length === 1) mism.push({ pan: p, customer: c.customer, owner: owner, note: 'Consolidated says ' + c.assoc });
  });
  checks.push({ id: 'consolidated', level: mism.length ? 'warn' : 'ok',
    title: mism.length ? mism.length + ' PAN(s) where Consolidated and the associate tabs disagree' : 'Consolidated matches the associate tabs',
    detail: 'Consolidated looks up remarks and R/Y/G by its Associate Name, so a wrong name shows blanks there.', items: mism.slice(0, 50) });

  // 5. "Vendor Does not Exist" although the PAN is in Payables (lookup range too short).
  var pay = {};
  var pidx = wbPayIndex_(ss).pan;
  Object.keys(pidx).forEach(function (p) { pay[p] = { row: pidx[p][3], net: pidx[p][1] }; });
  var vendorMiss = [];
  names.forEach(function (n) {
    ((books[n] || {}).rows || []).forEach(function (r) {
      if (/vendor does not exist/i.test(r.bizModel) && pay[r.pan]) {
        vendorMiss.push({ pan: r.pan, customer: r.customer, owner: n, amount: pay[r.pan].net,
          note: 'In Payables row ' + pay[r.pan].row + ' (net payable ' + fmt(pay[r.pan].net) + ')' });
      }
    });
  });
  checks.push({ id: 'payables', level: vendorMiss.length ? 'warn' : 'ok',
    title: vendorMiss.length ? vendorMiss.length + ' PAN(s) show "Vendor Does not Exist" but are in Payables' : 'Payables lookups find every vendor',
    detail: 'The Business Model / Net Payable formulas probably stop before the last Payables row, which also understates Possible AR AP.',
    items: vendorMiss.slice(0, 50) });

  // 6. Tabs without a column for today.
  var noToday = names.filter(function (n) { return (books[n] || {}).stats && !books[n].stats.hasToday; });
  checks.push({ id: 'dates', level: noToday.length ? 'warn' : 'ok',
    title: noToday.length ? noToday.length + ' tab(s) have no follow-up column for today' : 'Every tab has a column for today',
    detail: 'Add date columns to the right of the grid; the workbench cannot record today\'s status without one.',
    items: noToday.map(function (n) { return { owner: n, note: 'no ' + wbFmtDate_(today) + ' column' }; }) });

  // 7. Free-text PTP statuses.
  var ptp = wbReadPtp_(ss).rows;
  var odd = {};
  ptp.forEach(function (p) { if (p.status && WB_STATUSES.indexOf(p.status) < 0) odd[p.status] = (odd[p.status] || 0) + 1; });
  var oddKeys = Object.keys(odd);
  checks.push({ id: 'ptpText', level: oddKeys.length ? 'warn' : 'ok',
    title: oddKeys.length ? 'PTP Tracker has ' + oddKeys.reduce(function (s, k) { return s + odd[k]; }, 0) + ' hand-typed statuses' : 'PTP statuses are all standard',
    detail: 'The daily job turns dates like "25th sep" into PTP dates and keeps other text in PTP Remarks.',
    items: oddKeys.slice(0, 20).map(function (k) { return { note: '"' + k + '" × ' + odd[k] }; }) });

  return checks;
}

// ---------------------------------------------------------------------------
// Internals: writing to associate tabs
// ---------------------------------------------------------------------------

function wbMarkDaily_(ss, assoc, pan, value) {
  return wbMarkDailyMany_(ss, assoc, [pan], value) > 0;
}

/** Set today's daily status for several PANs on one tab. Never downgrades PTP / Expected Payment to Yes on the same day. */
function wbMarkDailyMany_(ss, assoc, pans, value) {
  if (WB.DAILY_VALUES.indexOf(value) < 0) return 0;
  var sh = assoc ? ss.getSheetByName(assoc) : null;
  if (!sh || sh.getLastRow() < 3) return 0;
  var hdr = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  var today = wbKey_(new Date());
  var col = -1;
  hdr.forEach(function (v, i) { if (v instanceof Date && wbKey_(v) === today) col = i + 1; });
  if (col < 0) return 0;
  var rank = { '': 0, 'No': 0, 'Invoice Not Due': 1, 'Yes': 2, 'Expected Payment': 3, 'PTP': 4, 'Leave': 5, 'Holiday': 5 };
  var colA = sh.getRange(3, 1, sh.getLastRow() - 2, 1).getValues();
  var want = {};
  pans.forEach(function (p) { want[String(p).trim()] = true; });
  var rows = [];
  colA.forEach(function (v, i) { if (want[String(v[0] || '').trim()]) rows.push(i + 3); });
  if (!rows.length) return 0;
  var first = rows[0];
  var last = rows[rows.length - 1];
  var range = sh.getRange(first, col, last - first + 1, 1);
  var vals = range.getValues();
  var changed = [];
  rows.forEach(function (r) {
    var cur = String(vals[r - first][0] || '');
    if ((rank[value] || 0) >= (rank[cur] || 0) || value === 'Leave' || value === 'Holiday') {
      if (cur !== value) changed.push(r);
      vals[r - first][0] = value;
    }
  });
  // Few cells: write them one by one (never touches rows someone else may be typing in). Many: one block write.
  if (changed.length <= 25) changed.forEach(function (r) { sh.getRange(r, col).setValue(value); });
  else range.setValues(vals);
  return rows.filter(function (r) { return vals[r - first][0] === value; }).length;
}

function wbSetRemark_(ss, assoc, pan, text) {
  var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'dd-MMM');
  return wbSetCell_(ss, assoc, pan, 'remarks', stamp + ': ' + text);
}

function wbSetCell_(ss, assoc, pan, key, value) {
  var o = {};
  o[key] = value;
  return wbSetCells_(ss, assoc, pan, o);
}

/** Write several logical fields (WB_COLS keys) on the PAN's row of the associate tab. */
function wbSetCells_(ss, assoc, pan, fields) {
  var sh = assoc ? ss.getSheetByName(assoc) : null;
  if (!sh) return false;
  var H = wbHeaderIndex_(sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0]);
  var r = wbFindRow_(sh, pan);
  if (!r) return false;
  var ok = false;
  Object.keys(fields).forEach(function (k) {
    if (H[k] === undefined) return;
    sh.getRange(r, H[k] + 1).setValue(fields[k]);
    ok = true;
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Internals: new tabs (log, settings, snapshots)
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

function wbEnsureSnapSheet_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_SNAP);
  if (!sh) {
    sh = ss.insertSheet(WB.SHEET_SNAP);
    sh.getRange(1, 1, 1, WB.SNAP_HEADERS.length).setValues([WB.SNAP_HEADERS])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** WB Settings: team roster in A:E (header row 3) and settings in G:I (header row 3). */
function wbEnsureSettingsSheet_(ss) {
  var sh = ss.getSheetByName(WB.SHEET_SETTINGS);
  if (sh) {
    // Add any new setting keys introduced by an upgrade.
    var have = sh.getLastRow() >= 4 ? sh.getRange(4, 7, sh.getLastRow() - 3, 1).getValues().map(function (r) { return wbStr_(r[0]); }) : [];
    var add = WB_SETTINGS_DEFAULTS.filter(function (d) { return have.indexOf(d[0]) < 0; });
    if (add.length) {
      var start = 4;
      while (have[start - 4]) start++;
      sh.getRange(start, 7, add.length, 3).setValues(add);
    }
    wbSettingsMemo_ = null;
    return sh;
  }
  sh = ss.insertSheet(WB.SHEET_SETTINGS);
  sh.getRange(1, 1).setValue('AR Workbench settings').setFontWeight('bold');
  sh.getRange(2, 1).setValue('Roles: Associate · Team Lead · Management · Admin. E-mail = the Google account the person uses. ' +
    'Team Lead = the name of their team lead (as written in the Name column).');
  sh.getRange(3, 1, 1, WB.TEAM_HEADERS.length).setValues([WB.TEAM_HEADERS]).setFontWeight('bold').setBackground('#e8f0fe');
  sh.getRange(3, 7, 1, 3).setValues([WB.SETTING_HEADERS]).setFontWeight('bold').setBackground('#e8f0fe');
  var names = wbAssociateSheets_(ss).map(function (s) { return [s.getName(), 'Associate', '', '', 'Yes']; });
  if (names.length) sh.getRange(4, 1, names.length, WB.TEAM_HEADERS.length).setValues(names);
  sh.getRange(4, 7, WB_SETTINGS_DEFAULTS.length, 3).setValues(WB_SETTINGS_DEFAULTS);
  sh.setFrozenRows(3);
  wbSettingsMemo_ = null;
  wbTeamMemo_ = null;
  return sh;
}

function wbLog_(ss, e) {
  var sh = wbEnsureLogSheet_(ss);
  var now = new Date();
  sh.appendRow([now, wbDate_(wbKey_(now)), e.assoc || '', e.pan || '', e.customer || '', e.type || '', e.outcome || '',
    e.invoices || '', e.amount || '', e.next ? wbDate_(e.next) : '', e.remarks || '', wbUser_()]);
}

function wbLogRow_(r) {
  return {
    ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), date: r[1] instanceof Date ? wbKey_(r[1]) : '',
    assoc: String(r[2]), pan: String(r[3]), customer: String(r[4]), type: String(r[5]), outcome: String(r[6]),
    invoices: String(r[7]), amount: r[8] === '' ? '' : Number(r[8]) || 0, next: r[9] instanceof Date ? wbKey_(r[9]) : '',
    remarks: String(r[10]), user: String(r[11])
  };
}

/**
 * The last 90 days of the activity log, cached and topped up incrementally (only rows added since the last read
 * are fetched). Returns entries on/after sinceKey, oldest first.
 */
function wbReadLogTail_(ss, sinceKey) {
  var all = wbMemo_('logtail', function () {
    var sh = ss.getSheetByName(WB.SHEET_LOG);
    if (!sh || sh.getLastRow() < 2) return [];
    var lastRow = sh.getLastRow();
    var floor = wbAddDays_(wbKey_(new Date()), -90);
    var hit = wbCacheGet_(WB.CACHE_PREFIX + 'logtail');
    var rows;
    if (hit && hit.lastRow <= lastRow && hit.floor === floor) {
      rows = hit.rows;
      if (lastRow > hit.lastRow) {
        sh.getRange(hit.lastRow + 1, 1, lastRow - hit.lastRow, WB.LOG_HEADERS.length).getValues()
          .forEach(function (r) { rows.push(wbLogRow_(r)); });
      }
    } else {
      rows = wbReadLogBack_(ss, floor);
    }
    rows = rows.filter(function (l) { return !l.date || l.date >= floor; });
    wbCachePut_(WB.CACHE_PREFIX + 'logtail', { lastRow: lastRow, floor: floor, rows: rows }, 3600);
    return rows;
  });
  if (sinceKey >= wbAddDays_(wbKey_(new Date()), -90)) return all.filter(function (l) { return !l.date || l.date >= sinceKey; });
  return wbReadLogBack_(ss, sinceKey);
}

/** Log rows from the bottom up until the date drops below sinceKey (the log is append-only, oldest first). */
function wbReadLogBack_(ss, sinceKey) {
  var sh = ss.getSheetByName(WB.SHEET_LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  var out = [];
  var end = sh.getLastRow();
  var block = 2000;
  while (end >= 2) {
    var start = Math.max(2, end - block + 1);
    var vals = sh.getRange(start, 1, end - start + 1, WB.LOG_HEADERS.length).getValues();
    var stop = false;
    for (var i = vals.length - 1; i >= 0; i--) {
      var l = wbLogRow_(vals[i]);
      if (l.date && l.date < sinceKey) { stop = true; break; }
      out.push(l);
    }
    if (stop) break;
    end = start - 1;
  }
  return out.reverse();
}

/** Activity on a PAN over the last 90 days, newest first (from the cached log tail - no extra sheet reads). */
function wbHistory_(ss, pan, limit) {
  return wbReadLogTail_(ss, wbAddDays_(wbKey_(new Date()), -90))
    .filter(function (l) { return l.pan === pan; }).reverse().slice(0, limit);
}

/** Latest "next follow-up" date per PAN from the last 60 days of the log (later entries override earlier ones). */
function wbNextFollowUps_(ss) {
  var out = {};
  wbReadLogTail_(ss, wbAddDays_(wbKey_(new Date()), -60)).forEach(function (l) {
    if (!l.pan || l.type === 'PTP') return;
    out[l.pan] = l.next || '';
  });
  return out;
}

// ---------------------------------------------------------------------------
// Internals: cache helpers
// ---------------------------------------------------------------------------

/** JSON in CacheService, split into 90 kB chunks (the per-value limit is 100 kB). */
function wbCachePut_(key, obj, ttl) {
  var json = JSON.stringify(obj);
  var size = 90000;
  var n = Math.ceil(json.length / size);
  var put = {};
  for (var c = 0; c < n; c++) put[key + '_' + c] = json.substr(c * size, size);
  put[key + '_meta'] = JSON.stringify({ chunks: n });
  try { CacheService.getScriptCache().putAll(put, ttl); } catch (e) { /* cache full / too big: skip */ }
}

function wbCacheGet_(key) {
  var cache = CacheService.getScriptCache();
  var meta = cache.get(key + '_meta');
  if (!meta) return null;
  var n = JSON.parse(meta).chunks;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys);
  if (!keys.every(function (k) { return got[k] !== undefined && got[k] !== null; })) return null;
  try { return JSON.parse(keys.map(function (k) { return got[k]; }).join('')); } catch (e) { return null; }
}

function wbDropOwners_() {
  delete wbMemoStore_.owners;
  CacheService.getScriptCache().remove('wb_owner_idx_meta');
}

/** Per-execution memo so one call never parses the same tab twice. */
var wbMemoStore_ = {};
function wbMemo_(k, fn) {
  if (!(k in wbMemoStore_)) wbMemoStore_[k] = fn();
  return wbMemoStore_[k];
}
function wbDropCache_(k) {
  delete wbMemoStore_[k];
  CacheService.getScriptCache().remove(WB.CACHE_PREFIX + k + '_meta');
}
/** Array of flat objects -> {f: fields, r: rows as arrays} (about half the size in the cache). */
function wbPack_(list) {
  var f = [];
  list.forEach(function (o) { Object.keys(o).forEach(function (k) { if (f.indexOf(k) < 0) f.push(k); }); });
  return { f: f, r: list.map(function (o) { return f.map(function (k) { return o[k] === undefined ? null : o[k]; }); }) };
}
function wbUnpack_(p) {
  if (!p || !p.f) return null;
  return p.r.map(function (a) { var o = {}; p.f.forEach(function (k, i) { if (a[i] !== null) o[k] = a[i]; }); return o; });
}

function wbClearCaches_() {
  var ss = SpreadsheetApp.getActive();
  var cache = CacheService.getScriptCache();
  cache.remove('wb_assoc_list');
  wbDropOwners_();
  cache.remove(WB.CACHE_PREFIX + 'open_meta');
  ['ptp', 'io', 'cons', 'pay', 'logtail'].forEach(function (k) { wbDropCache_(k); });
  ss.getSheets().forEach(function (s) { cache.remove(WB.BOOK_PREFIX + s.getName() + '_meta'); });
  wbSettingsMemo_ = null;
  wbTeamMemo_ = null;
}

function wbWithLock_(fn) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function wbTz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }
function wbKey_(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  if (!(d instanceof Date)) return '';
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
function wbDow_(key) { return new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))).getUTCDay(); }
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
function wbNum_(v) { return typeof v === 'number' ? v : Number(String(v === null || v === undefined ? '' : v).replace(/,/g, '')) || 0; }
function wbStr_(v) { return v === null || v === undefined ? '' : (v instanceof Date ? wbKey_(v) : String(v)).trim(); }
function wbIsPan_(s) { return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(s || '').trim()); }
function wbInr_(n) {
  n = Number(n) || 0;
  var a = Math.abs(n);
  var s = a >= 1e7 ? (a / 1e7).toFixed(2) + ' Cr' : a >= 1e5 ? (a / 1e5).toFixed(2) + ' L' : Math.round(a).toLocaleString('en-IN');
  return (n < 0 ? '-' : '') + '₹' + s;
}
function wbUser_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
