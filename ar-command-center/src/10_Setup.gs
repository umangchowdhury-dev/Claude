/** Menu, one-time setup, triggers, tab layout. */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧾 AR Command Center')
    .addItem('Open workbench (sidebar)', 'CC_openSidebar')
    .addItem('Open workbench (full screen)', 'CC_openFullScreen')
    .addItem('Open selected PAN', 'CC_openSelectedPan')
    .addSeparator()
    .addItem('Sync from live sheet now', 'CC_syncNow')
    .addItem('Rebuild PAN Master & Dashboard', 'CC_rebuildNow')
    .addItem('Run daily maintenance now', 'CC_dailyMaintenance')
    .addSeparator()
    .addItem('Setup / repair (admin)', 'CC_setup')
    .addToUi();
}

function CC_openSidebar() {
  var t = HtmlService.createTemplateFromFile('Workbench');
  t.mode = 'sidebar';
  t.startPan = '';
  SpreadsheetApp.getUi().showSidebar(t.evaluate().setTitle('AR Command Center'));
}

function CC_openFullScreen(pan) {
  var t = HtmlService.createTemplateFromFile('Workbench');
  t.mode = 'full';
  t.startPan = typeof pan === 'string' ? pan : '';
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(1320).setHeight(840), 'AR Command Center');
}

function CC_openSelectedPan() {
  var sel = ccGetSelection();
  if (!sel.pan) { SpreadsheetApp.getUi().alert('Select a cell on a PAN row (PAN Master, PTP Tracker, Follow-ups, Invoices) first.'); return; }
  CC_openFullScreen(sel.pan);
}

function CC_rebuildNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    SpreadsheetApp.getUi().alert('A sync is running right now and will rebuild PAN Master & Dashboard at its end. Try again in a few minutes if needed.');
    return;
  }
  try { ccRebuild_(); } finally { lock.releaseLock(); }
  SpreadsheetApp.getActive().toast('PAN Master & Dashboard rebuilt', 'AR Command Center', 4);
}

/**
 * One-time setup (safe to re-run): creates / repairs every tab, validations, formats and triggers,
 * asks for the live sheet ID, then runs the first sync.
 */
function CC_setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Kolkata');
  ccSetupTabs_(ss);
  var cfg = ccConfig_();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  if (!cfg.LIVE_SHEET_ID && ui) {
    var r = ui.prompt('Connect the live tracker',
      'Paste the URL or ID of the current live "Associate Level Ageing Master - AR" sheet.\n' +
      'It is only read, never changed.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() === ui.Button.OK) ccSetConfig_('LIVE_SHEET_ID', ccExtractId_(r.getResponseText()));
  }
  ccInstallTriggers_();
  cfg = ccConfig_();
  if (cfg.LIVE_SHEET_ID) {
    var r = ccSync_();
    if (ui && r.pending) {
      ui.alert('Tabs are ready and the first copy of the data has started.\n\nThe rest continues automatically in the background (a few minutes). ' +
        'Watch the "Sync Log" tab - when the last line says OK, reload the sheet.\n\nMeanwhile fill in the Team tab (e-mails, roles, team leads).');
    } else if (ui) {
      ui.alert('AR Command Center is ready.\n\nFirst sync done. Review the Team tab (roles, team leads, e-mails), then open the workbench from the 🧾 menu.');
    }
  } else if (ui) {
    ui.alert('Tabs created. Add LIVE_SHEET_ID on the Config tab and run "Sync from live sheet now".');
  }
}

function ccExtractId_(s) {
  s = String(s || '').trim();
  var m = /\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  return m ? m[1] : s;
}

function ccSetConfig_(key, value) {
  var sh = ccSheet_(CC.T.CONFIG);
  var last = sh.getLastRow();
  var keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  var i = keys.indexOf(key);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(value);
  else sh.appendRow([key, value, '']);
}

function ccInstallTriggers_() {
  var cfg = ccConfig_();
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    // the sync interval may have changed - always recreate that one
    if (fn === 'CC_scheduledSync') ScriptApp.deleteTrigger(t); else have[fn] = true;
  });
  var every = Number(cfg.SYNC_EVERY_MINUTES) || 30;
  every = [1, 5, 10, 15, 30].indexOf(every) >= 0 ? every : 30;
  ScriptApp.newTrigger('CC_scheduledSync').timeBased().everyMinutes(every).create();
  if (!have.CC_dailyMaintenance) ScriptApp.newTrigger('CC_dailyMaintenance').timeBased().everyDays(1).atHour(7).create();
  if (!have.CC_nightlySnapshot) ScriptApp.newTrigger('CC_nightlySnapshot').timeBased().everyDays(1).atHour(23).create();
}

// ---------------------------------------------------------------------------
// Tab layout
// ---------------------------------------------------------------------------

function ccSetupTabs_(ss) {
  var order = [CC.T.HOME, CC.T.DASH, CC.T.PAN, CC.T.PTP, CC.T.FU, CC.T.LOG, CC.T.IO, CC.T.SNAP, CC.T.TEAM,
    CC.T.CONFIG, CC.T.INV, CC.T.PAY, CC.T.CAT, CC.T.BRAND, CC.T.EXPO, CC.T.HIST, CC.T.INPUTS, CC.T.SYNC];
  order.forEach(function (n) { if (!ss.getSheetByName(n)) ss.insertSheet(n); });
  order.forEach(function (n, i) { ss.setActiveSheet(ss.getSheetByName(n)); ss.moveActiveSheet(i + 1); });
  // Drop the default empty "Sheet1"
  ss.getSheets().forEach(function (s) {
    if (order.indexOf(s.getName()) < 0 && /^Sheet\d*$/.test(s.getName()) && s.getLastRow() === 0) ss.deleteSheet(s);
  });

  // Config
  var cfgSh = ss.getSheetByName(CC.T.CONFIG);
  ccHeader_(cfgSh, ['Setting', 'Value', 'What it does']);
  var existing = {};
  if (cfgSh.getLastRow() >= 2) cfgSh.getRange(2, 1, cfgSh.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[r[0]] = true; });
  CC_CONFIG_DEFAULTS.forEach(function (d) { if (!existing[d[0]]) cfgSh.appendRow(d); });
  cfgSh.setColumnWidth(1, 190); cfgSh.setColumnWidth(2, 320); cfgSh.setColumnWidth(3, 620);
  cfgSh.getRange('B:B').setNumberFormat('@');
  cfgSh.setTabColor('#5f6368');

  // Team
  var team = ss.getSheetByName(CC.T.TEAM);
  ccHeader_(team, CC_TEAM_COLS);
  ccListValidation_(team.getRange(2, 2, 500, 1), CC.ROLES);
  ccListValidation_(team.getRange(2, 6, 500, 1), ['Yes', 'No']);
  [130, 110, 130, 90, 230, 60, 120, 260].forEach(function (w, i) { team.setColumnWidth(i + 1, w); });
  team.setTabColor('#5f6368');

  // PAN Master
  var pm = ss.getSheetByName(CC.T.PAN);
  ccHeader_(pm, CC_PAN_COLS.map(function (c) { return c.h; }));
  pm.setFrozenColumns(2);
  pm.setRowHeight(1, 48);
  pm.getRange(1, 1, 1, CC_PAN_COLS.length).setWrap(true).setVerticalAlignment('middle');
  ccFormatPanColumns_(pm);
  pm.getRange(1, 1).setNote('One row per PAN. White columns are calculated from Invoices / Payables / PTP Tracker / Follow-ups on every sync. ' +
    'Yellow columns are yours to edit (or use the workbench) - edits are saved to PAN Inputs and survive every rebuild.');
  pm.setTabColor('#1a73e8');

  // PTP Tracker
  var ptp = ss.getSheetByName(CC.T.PTP);
  ccHeader_(ptp, CC_PTP_COLS);
  [9, 14, 15, 16, 17, 18].forEach(function (c) { ptp.getRange(1, c).setBackground(CC.COLORS.inputHead); });
  ptp.getRange('E:E').setNumberFormat('dd-mmm-yy'); ptp.getRange('H:J').setNumberFormat('dd-mmm-yy');
  ptp.getRange('F:G').setNumberFormat(CC.INR_FORMAT); ptp.getRange('N:N').setNumberFormat(CC.INR_FORMAT);
  ptp.getRange('T:T').setNumberFormat('dd-mmm-yy hh:mm');
  ccListValidation_(ptp.getRange(2, 15, Math.max(ptp.getMaxRows() - 1, 1), 1), ['NEFT / RTGS', 'AR-AP adjustment', 'Cheque', 'UPI', 'Other']);
  ccListValidation_(ptp.getRange(2, 18, Math.max(ptp.getMaxRows() - 1, 1), 1), CC.INVOICE_TAGS.filter(String));
  ptp.setFrozenColumns(1);
  ptp.setTabColor('#1a73e8');

  // Follow-ups
  var fu = ss.getSheetByName(CC.T.FU);
  ccHeader_(fu, CC_FU_COLS);
  fu.getRange('A:A').setNumberFormat('dd-mmm-yy'); fu.getRange('G:G').setNumberFormat('dd-mmm-yy hh:mm');
  ccListValidation_(fu.getRange(2, 4, Math.max(fu.getMaxRows() - 1, 1), 1), CC.DAILY_VALUES);
  fu.getRange(1, 1).setNote('Daily follow-up status per PAN (replaces the date columns of the old associate tabs). One row per PAN per day.');
  fu.setTabColor('#34a853');

  // Activity Log
  var log = ss.getSheetByName(CC.T.LOG);
  ccHeader_(log, CC_LOG_COLS);
  log.getRange('A:A').setNumberFormat('dd-mmm-yy hh:mm'); log.getRange('B:B').setNumberFormat('dd-mmm-yy');
  log.getRange('J:J').setNumberFormat('dd-mmm-yy'); log.getRange('I:I').setNumberFormat(CC.INR_FORMAT);
  log.setTabColor('#34a853');

  // IO Sign-off
  var io = ss.getSheetByName(CC.T.IO);
  ccHeader_(io, CC_IO_COLS);
  [9, 10, 11, 12, 13].forEach(function (c) { io.getRange(1, c).setBackground(CC.COLORS.inputHead); });
  io.getRange('M:M').setNumberFormat('dd-mmm-yy');
  io.setTabColor('#34a853');

  // Snapshots
  var snap = ss.getSheetByName(CC.T.SNAP);
  ccHeader_(snap, CC_SNAP_COLS);
  snap.getRange('A:A').setNumberFormat('dd-mmm-yy'); snap.getRange('E:I').setNumberFormat(CC.INR_FORMAT);
  snap.getRange('K:K').setNumberFormat('0%'); snap.getRange('N:N').setNumberFormat(CC.INR_FORMAT);
  snap.setTabColor('#9334e6');

  // Hidden-ish data tabs
  ccHeader_(ss.getSheetByName(CC.T.INPUTS), CC_INPUT_COLS);
  ccHeader_(ss.getSheetByName(CC.T.SYNC), ['Started', 'Finished', 'Seconds', 'Mode', 'What', 'Result']);
  [CC.T.INV, CC.T.PAY, CC.T.CAT, CC.T.BRAND, CC.T.EXPO, CC.T.HIST, CC.T.INPUTS, CC.T.SYNC].forEach(function (n) {
    ss.getSheetByName(n).setTabColor('#9aa0a6');
  });
  ss.getSheetByName(CC.T.INPUTS).getRange(1, 1).setNote('Store for everything typed into the yellow PAN Master columns. Do not edit by hand.');

  // Dashboard & Home are drawn by ccBuildDashboard_ / ccBuildHome_
  ss.getSheetByName(CC.T.DASH).setTabColor('#ea4335');
  ss.getSheetByName(CC.T.HOME).setTabColor('#ea4335');
  ccBuildHome_(ss);

  // Protect calculated tabs with a warning (still editable by admins, nobody overwrites by accident)
  [CC.T.DASH, CC.T.SNAP, CC.T.INPUTS, CC.T.SYNC, CC.T.INV, CC.T.PAY, CC.T.CAT, CC.T.BRAND, CC.T.EXPO, CC.T.HIST].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) sh.protect().setWarningOnly(true).setDescription('Maintained by AR Command Center');
  });
}

/** Widths, number formats, yellow input columns, drop-downs and colour rules for the whole PAN Master grid. */
function ccFormatPanColumns_(pm) {
  var n = Math.max(pm.getMaxRows() - 1, 1);
  CC_PAN_COLS.forEach(function (c, i) {
    pm.setColumnWidth(i + 1, c.w);
    var col = pm.getRange(2, i + 1, n, 1);
    if (c.money) col.setNumberFormat(CC.INR_FORMAT);
    if (c.date) col.setNumberFormat('dd-mmm-yy');
    if (c.datetime) col.setNumberFormat('dd-mmm-yy hh:mm');
    if (c.input) {
      pm.getRange(1, i + 1).setBackground(CC.COLORS.inputHead);
      col.setBackground(CC.COLORS.input);
      if (c.list === 'DAILY') ccListValidation_(col, CC.DAILY_VALUES);
      if (c.list === 'CONF') ccListValidation_(col, CC.CONFIDENCE);
      if (c.list === 'YESNO') ccListValidation_(col, ['Yes', 'No']);
      if (c.key === 'owner') {
        var names = ccTeam_().map(function (t) { return t.name; });
        if (names.length) ccListValidation_(col, names);
      }
      if (c.date) col.setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
    }
  });
  ccRagFormatting_(pm);
}

function ccHeader_(sh, headers) {
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground(CC.COLORS.head).setFontColor(CC.COLORS.headFont);
  sh.setFrozenRows(1);
}

function ccListValidation_(range, list) {
  range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build());
}

function ccRagFormatting_(pm) {
  var H = ccPanColIndex_();
  var n = Math.max(pm.getMaxRows() - 1, 1);
  var conf = pm.getRange(2, H.confidence + 1, n, 1);
  var status = pm.getRange(2, H.todayStatus + 1, n, 1);
  var days = pm.getRange(2, H.daysSince + 1, n, 1);
  var broken = pm.getRange(2, H.ptpBroken + 1, n, 1);
  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#f4c7c3').setRanges([pm.getRange(2, H.redAmt + 1, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#fce8b2').setRanges([pm.getRange(2, H.amberAmt + 1, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#b7e1cd').setRanges([pm.getRange(2, H.greenAmt + 1, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Red').setBackground('#f4c7c3').setRanges([conf]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Amber').setBackground('#fce8b2').setRanges([conf]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Green').setBackground('#b7e1cd').setRanges([conf]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('PTP').setBackground('#c9daf8').setRanges([status]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Yes').setBackground('#b7e1cd').setRanges([status]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(3).setFontColor('#c5221f').setBold(true).setRanges([days]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#f4c7c3').setRanges([broken]).build()
  ];
  pm.setConditionalFormatRules(rules);
}

function ccBuildHome_(ss) {
  var sh = ss.getSheetByName(CC.T.HOME);
  sh.clear();
  var cfg = ccConfig_();
  var lines = [
    ['AR Command Center', ''],
    ['One place for associates, team leads and management: PAN book, invoice drill-down, PTPs, follow-ups, reviews and dashboards.', ''],
    ['', ''],
    ['Mode', cfg.MODE === 'LIVE' ? 'LIVE - this sheet is the tracker' : 'TEST - pulling from the live sheet (read-only) every ' + cfg.SYNC_EVERY_MINUTES + ' min'],
    ['Last sync', PropertiesService.getScriptProperties().getProperty('cc_last_sync') || 'not yet'],
    ['', ''],
    ['Start here', ''],
    ['Associates', 'Menu 🧾 AR Command Center → Open workbench. Today tab = your work queue. Click a PAN for its invoices; tick invoices → 🤝 PTP / 📞 Follow-up / ✉️ Mail.'],
    ['Team leads', 'Workbench → Team tab: review queue per associate, add Team Lead remarks, reassign PANs. Or edit yellow columns in PAN Master.'],
    ['Management', 'Dashboard tab (refreshed on every sync) and Workbench → Overview: portfolio, ageing, trends, reconciliation.'],
    ['', ''],
    ['Tabs', ''],
    ['Dashboard', 'Old "Summary" + more: per associate/team lead KPIs, daily follow-up counts with monthly moving average, ageing by business model / BU, top risks, checks.'],
    ['PAN Master', 'Old "Consolidated" + all associate tabs in one: one row per PAN. Filter by Associate for "my tab". Yellow columns are editable.'],
    ['PTP Tracker', 'One row per invoice: PTP date, amount, mode, contact, tag, live status (Given / Due Today / Broken / Paid on time).'],
    ['Follow-ups', 'Daily status per PAN (Yes / PTP / Expected Payment / Invoice Not Due / No / Leave / Holiday) - replaces the date columns.'],
    ['Activity Log', 'Every call, e-mail, PTP, tag and remark with who / when.'],
    ['IO Sign-off', 'Old "IO Sign Off Rate Card" + sign-off date; per-associate summary is on the Dashboard.'],
    ['Snapshots', 'Nightly history per associate for trend analysis.'],
    ['Team / Config', 'Roster with roles, team leads and e-mails; settings.'],
    ['Invoices, Payables, Map:*, List:*', 'Raw data mirrored from the source sheet (old Imported_Data, Payable Data - Daily, Category Mapping, Brand Name Mapping, Exposure & Historic AR-AP PAN lists).']
  ];
  sh.getRange(1, 1, lines.length, 2).setValues(lines);
  sh.getRange('A1').setFontSize(20).setFontWeight('bold');
  sh.getRange('A2').setFontColor(CC.COLORS.note);
  [4, 5].forEach(function (r) { sh.getRange(r, 1).setFontWeight('bold'); });
  [7, 12].forEach(function (r) { sh.getRange(r, 1).setFontWeight('bold').setFontSize(13); });
  sh.getRange(8, 1, 3, 1).setFontWeight('bold'); sh.getRange(13, 1, 9, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 230); sh.setColumnWidth(2, 900);
  sh.getRange(1, 2, lines.length, 1).setWrap(true);
  sh.setHiddenGridlines(true);
}
