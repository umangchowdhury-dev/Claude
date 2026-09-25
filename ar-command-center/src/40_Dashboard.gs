/**
 * Dashboard tab = the old "Summary" (every column, same definitions) plus management sections.
 * Drawn from the rebuild model in one write; nothing on it is a live formula.
 */

/** One entry per associate (team order, "Unassigned" last) + a Total entry. Used by Dashboard, Snapshots and the UI. */
function ccSummaryByAssociate_(model) {
  var today = model.today;
  var monthStart = today.slice(0, 8) + '01';
  var names = [];
  model.team.forEach(function (t) { if (names.indexOf(t.name) < 0 && (t.role === 'Associate' || t.liveTab)) names.push(t.name); });
  model.rows.forEach(function (r) { var n = r.owner || 'Unassigned'; if (names.indexOf(n) < 0) names.push(n); });
  var teamBy = {};
  model.team.forEach(function (t) { teamBy[t.name] = t; });
  var ptpBy = {};
  model.ptp.rows.forEach(function (p) {
    if (!p.ptpDate) return;
    var o = ptpBy[p.associate] || (ptpBy[p.associate] = { kept: 0, late: 0, broken: 0 });
    if (p.live === 'Paid (PTP Kept)') o.kept++; else if (p.live === 'Paid (after PTP)') o.late++; else if (p.live === 'PTP Broken') o.broken++;
  });
  var ioBy = {};
  Object.keys(model.io).forEach(function (p) {
    var x = model.io[p];
    var o = ioBy[x.assoc] || (ioBy[x.assoc] = { pans: 0, done: 0, incentive: 0, incentiveMonth: 0 });
    o.pans++;
    if (x.done) { o.done++; o.incentive += x.rate; if (x.signDate >= monthStart) o.incentiveMonth += x.rate; }
  });
  var workdays = [];
  for (var d = monthStart; d <= today; d = ccAddDays_(d, 1)) if (ccIsWorkday_(d, model.cfg)) workdays.push(d);

  var blank = function (name) {
    var t = teamBy[name] || {};
    return { name: name, group: t.group || (name === 'Unassigned' ? 'Unassigned' : ''), teamLead: t.teamLead || '',
      totalAccounts: 0, nonZero: 0, overdueAccts: 0, gt60Accts: 0, remarksFilled: 0, exposureAccts: 0,
      b: [0, 0, 0, 0, 0, 0, 0], notFollowed3: 0, total: 0, overdue: 0, netPayable: 0, possibleArAp: 0,
      possibleArApHist: 0, gt60: 0, possibleArAp60: 0, red: 0, amber: 0, green: 0, touchedToday: 0,
      ptpOpen: 0, ptpAmt: 0, ptpBroken: 0, ptpDueToday: 0, mtdCov: 0, keptRate: null,
      ioPans: 0, ioDone: 0, ioPending: 0, ioIncentive: 0, ioIncentiveMonth: 0 };
  };
  var by = {};
  names.forEach(function (n) { by[n] = blank(n); });
  var tot = blank('Total');
  tot.isTotal = true;
  model.rows.forEach(function (r) {
    [by[r.owner || 'Unassigned'], tot].forEach(function (s) {
      s.totalAccounts++;
      if (r.total !== 0) s.nonZero++;
      if (r.overdue !== 0) s.overdueAccts++;
      if (r.gt60 !== 0) s.gt60Accts++;
      if (r.remarks) s.remarksFilled++;
      if (r.exposure === 'Yes') s.exposureAccts++;
      for (var i = 0; i < 7; i++) s.b[i] += r['b' + i];
      if (r.notFollowed3) s.notFollowed3++;
      s.total += r.total; s.overdue += r.overdue; s.netPayable += r.netPayable; s.possibleArAp += r.possibleArAp;
      if (r.arApHist === 'Yes') s.possibleArApHist += r.possibleArAp;
      s.gt60 += r.gt60; s.possibleArAp60 += r.possibleArAp60;
      s.red += Number(r.redAmt) || 0; s.amber += Number(r.amberAmt) || 0; s.green += Number(r.greenAmt) || 0;
      if (r.total !== 0 && ccTouched_(r.todayStatus)) s.touchedToday++;
      s.ptpOpen += r.ptpOpen; s.ptpAmt += r.ptpAmt; s.ptpBroken += r.ptpBroken; s.ptpDueToday += r.ptpDueToday;
    });
  });
  var list = names.map(function (n) { return by[n]; }).filter(function (s) { return s.totalAccounts || (teamBy[s.name] || {}).active; });
  list.forEach(function (s) {
    var counts = model.fu.byAssocDate[s.name] || {};
    s.mtdCov = s.nonZero && workdays.length ? workdays.reduce(function (acc, dk) { return acc + ccTouchedCount_(counts[dk]) / s.nonZero; }, 0) / workdays.length : 0;
    var p = ptpBy[s.name] || { kept: 0, late: 0, broken: 0 };
    var closed = p.kept + p.late + p.broken;
    s.keptRate = closed ? p.kept / closed : null;
    var io = ioBy[s.name] || { pans: 0, done: 0, incentive: 0, incentiveMonth: 0 };
    s.ioPans = io.pans; s.ioDone = io.done; s.ioPending = io.pans - io.done; s.ioIncentive = io.incentive; s.ioIncentiveMonth = io.incentiveMonth;
    tot.ioPans += s.ioPans; tot.ioDone += s.ioDone; tot.ioPending += s.ioPending; tot.ioIncentive += s.ioIncentive; tot.ioIncentiveMonth += s.ioIncentiveMonth;
  });
  var allCounts = {};
  list.forEach(function (s) {
    var c = model.fu.byAssocDate[s.name] || {};
    Object.keys(c).forEach(function (dk) { allCounts[dk] = (allCounts[dk] || 0) + ccTouchedCount_(c[dk]); });
  });
  tot.mtdCov = tot.nonZero && workdays.length ? workdays.reduce(function (a, dk) { return a + (allCounts[dk] || 0) / tot.nonZero; }, 0) / workdays.length : 0;
  var tp = { kept: 0, late: 0, broken: 0 };
  Object.keys(ptpBy).forEach(function (k) { tp.kept += ptpBy[k].kept; tp.late += ptpBy[k].late; tp.broken += ptpBy[k].broken; });
  tot.keptRate = tp.kept + tp.late + tp.broken ? tp.kept / (tp.kept + tp.late + tp.broken) : null;
  list.push(tot);
  return list;
}

function ccTouchedCount_(cell) {
  if (!cell) return 0;
  return (cell['Yes'] || 0) + (cell['PTP'] || 0) + (cell['Expected Payment'] || 0);
}

function ccBuildDashboard_(ss, model) {
  var sh = ccSheet_(CC.T.DASH);
  var cfg = model.cfg;
  var today = model.today;
  var sum = ccSummaryByAssociate_(model);
  var tot = sum[sum.length - 1];
  var grid = [];
  var fmts = [];   // [row, col, nRows, nCols, kind]
  var W = 1;
  var put = function (row) { grid.push(row); W = Math.max(W, row.length); return grid.length; };
  var gap = function () { put(['']); };
  var title = function (text, note) { var r = put([text]); fmts.push([r, 1, 1, 1, 'title']); if (note) { put([note]); fmts.push([grid.length, 1, 1, 1, 'note']); } };
  var header = function (cells) { var r = put(cells); fmts.push([r, 1, 1, cells.length, 'head']); return r; };

  var lastSync = PropertiesService.getScriptProperties().getProperty('cc_last_sync') || '';
  put(['AR Command Center — Dashboard']); fmts.push([1, 1, 1, 1, 'h1']);
  put(['As of ' + ccFmtDate_(today) + ' · ' + (cfg.MODE === 'LIVE' ? 'LIVE mode' : 'TEST mode (pulling from the live sheet)') + (lastSync ? ' · last sync ' + lastSync : '')]);
  fmts.push([2, 1, 1, 1, 'note']);
  gap();

  // KPI strip
  var recon = tot.total - model.inv.total;
  var k1 = put(['Total receivables', 'Overdue', '>60 days', 'Possible AR-AP', 'Coverage today', 'Coverage MTD', 'Open PTPs', 'Broken PTPs', 'Reconciliation']);
  fmts.push([k1, 1, 1, 9, 'kpiHead']);
  var k2 = put([tot.total, tot.overdue, tot.gt60, tot.possibleArAp, tot.nonZero ? tot.touchedToday / tot.nonZero : 0, tot.mtdCov, tot.ptpOpen, tot.ptpBroken,
    Math.abs(recon) < 1 ? '✓ PAN Master = Invoices' : 'Off by ' + ccInrFull_(recon)]);
  fmts.push([k2, 1, 1, 4, 'kpiMoney']); fmts.push([k2, 5, 1, 2, 'kpiPct']); fmts.push([k2, 7, 1, 3, 'kpi']);
  gap();

  // A. Associate summary (old Summary tab)
  title('Associate summary', 'Same columns and definitions as the old Summary tab, plus team lead, coverage, PTP and IO sign-off. "Not followed up 3 days" = balance > 0 and no follow-up on the last 3 working days.');
  var hA = ['Particulars', 'Group', 'Team Lead', 'Total Accounts', 'Non Zero Accounts', 'Overdue Accounts', '>60 Accounts',
    'No. of Remarks filled accounts', 'No. of Exposure accounts', 'a.Not Due', 'b.0-30', 'c.31-60', 'd.61-90', 'e.91-120',
    'f.121-150', 'g.>151', 'No. of PANs not followed up for 3 days', 'Total Receivables', 'Total Overdue Receivables',
    'Net Payable Balance', 'Possible AR AP', 'Possible AR AP Historic PANs', '>60 days receivables', 'Possible AR AP > 60 days',
    'Red', 'Amber (Yellow)', 'Green', 'Touched today', 'Coverage today', 'Coverage MTD', 'Open PTPs', 'PTP amount',
    'Broken PTPs', 'PTP kept %', 'IO PANs', 'IO sign-offs done', 'Pending IO sign-offs', 'Incentive collected till date',
    'Incentive collected this month'];
  var rA = header(hA);
  sum.forEach(function (s) {
    var r = put([s.name, s.group, s.teamLead, s.totalAccounts, s.nonZero, s.overdueAccts, s.gt60Accts, s.remarksFilled, s.exposureAccts]
      .concat(s.b).concat([s.notFollowed3, s.total, s.overdue, s.netPayable, s.possibleArAp, s.possibleArApHist, s.gt60,
        s.possibleArAp60, s.red, s.amber, s.green, s.touchedToday, s.nonZero ? s.touchedToday / s.nonZero : 0, s.mtdCov,
        s.ptpOpen, s.ptpAmt, s.ptpBroken, s.keptRate === null ? '' : s.keptRate, s.ioPans, s.ioDone, s.ioPending,
        s.ioIncentive, s.ioIncentiveMonth]));
    if (s.isTotal) fmts.push([r, 1, 1, hA.length, 'total']);
  });
  var nA = sum.length;
  fmts.push([rA + 1, 10, nA, 7, 'money']); fmts.push([rA + 1, 18, nA, 10, 'money']); fmts.push([rA + 1, 29, nA, 2, 'pct']);
  fmts.push([rA + 1, 32, nA, 1, 'money']); fmts.push([rA + 1, 34, nA, 1, 'pct']); fmts.push([rA + 1, 38, nA, 2, 'money']);
  // Check rows (same idea as the old sheet)
  var body = sum.slice(0, -1);
  var colSum = function (f) { return body.reduce(function (a, s) { return a + f(s); }, 0); };
  put(['Check (sum of rows − Total)', '', '', colSum(function (s) { return s.totalAccounts; }) - tot.totalAccounts,
    colSum(function (s) { return s.nonZero; }) - tot.nonZero, '', '', '', '', '', '', '', '', '', '', '',
    colSum(function (s) { return s.notFollowed3; }) - tot.notFollowed3, colSum(function (s) { return s.total; }) - tot.total]);
  fmts.push([grid.length, 1, 1, 18, 'note']);
  put(['Overall check (Total Receivables − Invoices net to be received)', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', recon]);
  fmts.push([grid.length, 1, 1, 18, 'note']);
  gap();

  // B. Daily follow-ups grid with monthly moving averages
  title('Daily follow-ups done per associate', 'Count of PANs marked Yes / PTP / Expected Payment each day (the old grid counted "Yes" only). Moving average = average over working days on which the team worked.');
  var start = cfg.FOLLOWUP_START && /^\d{4}-\d{2}-\d{2}$/.test(cfg.FOLLOWUP_START) ? cfg.FOLLOWUP_START : today.slice(0, 8) + '01';
  var cols = [];
  for (var d = start; d <= today; d = ccAddDays_(d, 1)) {
    cols.push({ date: d });
    var next = ccAddDays_(d, 1);
    if (next.slice(0, 7) !== d.slice(0, 7) || d === today) cols.push({ avg: d.slice(0, 7) });
  }
  var teamDayTotal = {};
  body.forEach(function (s) {
    var c = model.fu.byAssocDate[s.name] || {};
    Object.keys(c).forEach(function (dk) { teamDayTotal[dk] = (teamDayTotal[dk] || 0) + ccTouchedCount_(c[dk]); });
  });
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var hB = ['Associate'].concat(cols.map(function (c) { return c.date ? ccDate_(c.date) : 'Moving Average ' + MON[+c.avg.slice(5) - 1] + ' ' + c.avg.slice(0, 4); }));
  var rB = header(hB);
  var dayRows = body.concat([tot]);
  dayRows.forEach(function (s) {
    var c = model.fu.byAssocDate[s.name] || {};
    var row = [s.name];
    cols.forEach(function (col) {
      if (col.date) {
        row.push(s.isTotal ? (teamDayTotal[col.date] || 0) : ccTouchedCount_(c[col.date]));
      } else {
        var days = Object.keys(teamDayTotal).filter(function (dk) { return dk.slice(0, 7) === col.avg && dk <= today && teamDayTotal[dk] > 0 && ccIsWorkday_(dk, cfg); });
        var v = days.reduce(function (a, dk) { return a + (s.isTotal ? teamDayTotal[dk] : ccTouchedCount_(c[dk])); }, 0);
        row.push(days.length ? Math.round(v / days.length * 10) / 10 : '');
      }
    });
    var r = put(row);
    if (s.isTotal) fmts.push([r, 1, 1, row.length, 'total']);
  });
  fmts.push([rB, 2, 1, cols.length, 'dateHead']);
  cols.forEach(function (c, i) {
    if (c.avg) fmts.push([rB, i + 2, dayRows.length + 1, 1, 'avgCol']);
    else if (!ccIsWorkday_(c.date, cfg)) fmts.push([rB + 1, i + 2, dayRows.length, 1, 'weekend']);
  });
  gap();

  // C. Team leads
  var tls = {};
  body.forEach(function (s) {
    var k = s.teamLead || '(no team lead set)';
    var o = tls[k] || (tls[k] = { n: 0, pans: 0, total: 0, overdue: 0, gt60: 0, touched: 0, stale: 0, broken: 0, arap: 0 });
    o.n++; o.pans += s.nonZero; o.total += s.total; o.overdue += s.overdue; o.gt60 += s.gt60; o.touched += s.touchedToday;
    o.stale += s.notFollowed3; o.broken += s.ptpBroken; o.arap += s.possibleArAp;
  });
  title('Team leads', 'Set team leads on the Team tab.');
  var rC = header(['Team Lead', 'Associates', 'Active PANs', 'Total Receivables', 'Overdue', '>60 days', 'Possible AR AP', 'Coverage today', 'Not followed 3 days', 'Broken PTPs']);
  var tlKeys = Object.keys(tls);
  tlKeys.forEach(function (k) { var o = tls[k]; put([k, o.n, o.pans, o.total, o.overdue, o.gt60, o.arap, o.pans ? o.touched / o.pans : 0, o.stale, o.broken]); });
  fmts.push([rC + 1, 4, tlKeys.length, 4, 'money']); fmts.push([rC + 1, 8, tlKeys.length, 1, 'pct']);
  gap();

  // D / E. Ageing by business model and by BU head
  var groupBy = function (keyFn) {
    var g = {};
    model.rows.forEach(function (r) {
      if (r.total === 0) return;
      var k = keyFn(r) || '(blank)';
      var o = g[k] || (g[k] = { n: 0, b: [0, 0, 0, 0, 0, 0, 0], total: 0, overdue: 0, gt60: 0, arap: 0 });
      o.n++; for (var i = 0; i < 7; i++) o.b[i] += r['b' + i];
      o.total += r.total; o.overdue += r.overdue; o.gt60 += r.gt60; o.arap += r.possibleArAp;
    });
    return Object.keys(g).map(function (k) { return [k, g[k]]; }).sort(function (a, b) { return b[1].overdue - a[1].overdue; });
  };
  [['Ageing by business model', function (r) { return r.bizModel; }], ['Ageing by BU head (first listed)', function (r) { return r.buHead.split(',')[0].trim(); }]].forEach(function (sec) {
    title(sec[0]);
    var rows = groupBy(sec[1]);
    var rh = header(['Group', 'PANs', 'a.Not Due', 'b.0-30', 'c.31-60', 'd.61-90', 'e.91-120', 'f.121-150', 'g.>151', 'Total', 'Overdue', '>60 days', 'Possible AR AP']);
    rows.forEach(function (x) { put([x[0], x[1].n].concat(x[1].b).concat([x[1].total, x[1].overdue, x[1].gt60, x[1].arap])); });
    if (rows.length) fmts.push([rh + 1, 3, rows.length, 11, 'money']);
    gap();
  });

  // F / G. Risk lists
  var riskCols = ['PAN', 'Customer', 'Associate', 'Overdue', '>60 days', 'Possible AR AP', 'Confidence', 'Last follow-up', 'Next PTP', 'Broken PTPs', 'Associate remarks'];
  var riskRow = function (r) {
    return [r.pan, r.customer, r.owner, r.overdue, r.gt60, r.possibleArAp, r.confidence, r.lastTouch ? ccDate_(r.lastTouch) : 'never',
      r.ptpNext ? ccDate_(r.ptpNext) : '', r.ptpBroken, r.remarks];
  };
  [['Top 25 overdue PANs', model.rows.filter(function (r) { return r.overdue > 0; }).sort(function (a, b) { return b.overdue - a.overdue; })],
   ['>60 days with no open PTP (top 25)', model.rows.filter(function (r) { return r.gt60 > 0 && !r.ptpOpen; }).sort(function (a, b) { return b.gt60 - a.gt60; })],
   ['Broken PTPs by PAN', model.rows.filter(function (r) { return r.ptpBroken > 0; }).sort(function (a, b) { return b.overdue - a.overdue; })]
  ].forEach(function (sec) {
    title(sec[0]);
    var rh = header(riskCols);
    var list = sec[1].slice(0, 25);
    list.forEach(function (r) { put(riskRow(r)); });
    if (list.length) { fmts.push([rh + 1, 4, list.length, 3, 'money']); fmts.push([rh + 1, 8, list.length, 2, 'date']); }
    else put(['Nothing to show']);
    gap();
  });

  // H. Improvement points carried over from the old Summary tab
  title('Improvement points (from the old Summary tab)');
  header(['Point', 'Status in the new sheet']);
  [['Category and Category SPOCs to be added', 'Done – BU Head, Category Heads (L2/L1), BizFin SPOC on every PAN'],
   ['Clicking the line item will open up the invoice level data', 'Done – workbench PAN drill-down; 🎯 Follow opens the PAN you click in any tab'],
   ['Payables data to be more accurate, automated and real time', 'Pulled automatically on every sync'],
   ['Historic possible AR AP PANs to be more accurate', 'Done – "Possible AR AP Historic PANs" column'],
   ['PTP drop down to be added', 'Done – per-invoice PTP with date, amount, mode, contact, tag, live status'],
   ['Not Due line items to be automatically marked as invoice not due', 'Done – daily 07:00 job (Config: AUTO_NOT_DUE)'],
   ['Mail count to be linked to manual follow up count', 'Done – ✉️ reminder drafts are logged and count as follow-ups'],
   ['Business Model data to be made accurate', 'From Payables (Vendor Does not Exist when the PAN is not a vendor)'],
   ['>60 days data to be updated', 'Done – >60 columns, >60 without PTP list']
  ].forEach(function (x) { put(x); });

  // Write
  var out = grid.map(function (r) { return ccFit_(r, W); });
  sh.clear();
  if (sh.getMaxColumns() < W) sh.insertColumnsAfter(sh.getMaxColumns(), W - sh.getMaxColumns());
  if (sh.getMaxRows() < out.length) sh.insertRowsAfter(sh.getMaxRows(), out.length - sh.getMaxRows());
  sh.getRange(1, 1, out.length, W).setValues(out);
  fmts.forEach(function (f) {
    var rg = sh.getRange(f[0], f[1], f[2], f[3]);
    switch (f[4]) {
      case 'h1': rg.setFontSize(18).setFontWeight('bold'); break;
      case 'title': rg.setFontSize(13).setFontWeight('bold').setFontColor(CC.COLORS.head); break;
      case 'note': rg.setFontColor(CC.COLORS.note).setFontStyle('italic'); break;
      case 'head': rg.setFontWeight('bold').setBackground(CC.COLORS.head).setFontColor(CC.COLORS.headFont).setWrap(true).setVerticalAlignment('middle'); break;
      case 'kpiHead': rg.setFontColor(CC.COLORS.note).setFontWeight('bold'); break;
      case 'kpiMoney': rg.setNumberFormat(CC.INR_FORMAT).setFontSize(14).setFontWeight('bold'); break;
      case 'kpiPct': rg.setNumberFormat('0%').setFontSize(14).setFontWeight('bold'); break;
      case 'kpi': rg.setFontSize(14).setFontWeight('bold'); break;
      case 'money': rg.setNumberFormat(CC.INR_FORMAT); break;
      case 'pct': rg.setNumberFormat('0%'); break;
      case 'date': rg.setNumberFormat('dd-mmm-yy'); break;
      case 'dateHead': rg.setNumberFormat('dd-mmm'); break;
      case 'total': rg.setFontWeight('bold').setBackground('#e8eaed'); break;
      case 'avgCol': rg.setBackground('#fef7e0').setFontWeight('bold'); break;
      case 'weekend': rg.setBackground('#f1f3f4'); break;
    }
  });
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 210);
  sh.setHiddenGridlines(true);
  return sum;
}
