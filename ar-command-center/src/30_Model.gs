/**
 * Rebuild: Invoices + Payables + mappings + PAN Inputs + Follow-ups + PTP Tracker  ->  PAN Master + Dashboard.
 *
 * Every calculated column of the old Consolidated / associate tabs is reproduced here in script (instead of
 * ~40k SUMIFS / FILTER formulas), which keeps the sheet fast:
 *   Customer Name        first Customer Name for the PAN in Invoices              (old XLOOKUP)
 *   Brand Names / KAMs / KAM Managers   unique values over all the PAN's invoices   (old TEXTJOIN(UNIQUE(FILTER)))
 *   Due Activity Months  unique activity months of invoices with Net to be received <> 0, else "NA"
 *   BU Head / Category Heads / BizFin    unique names after splitting the comma lists
 *   Business Model / Net Payable        Payables (PAN Number -> Business Models / Net Payable), else
 *                                       "Vendor Does not Exist" / 0
 *   Historically AR AP / Exposure       PAN present in the respective list tab
 *   IO Sign Off Incentive               IO Sign-off rate for the PAN, "NA" when missing or 0
 *   Buckets                             SUM of Net to be received by Ageing Bucket
 *   Total / Overdue / >60               sum of buckets / all but Not Due / 61-90 and older
 *   Possible AR AP                      MIN(Overdue, Net Payable) when Net Payable > 0     (Consolidated rule)
 *   Possible AR AP (on total)           MIN(Total, Net Payable) when Net Payable > 0       (associate-tab rule)
 *   Possible AR AP > 60 days            MIN(>60, Net Payable) when Net Payable > 0
 */

function ccRebuild_(opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.getActive();
  var cfg = ccConfig_();
  var today = ccToday_();
  var team = ccTeam_();
  var teamBy = {};
  team.forEach(function (t) { teamBy[t.name] = t; });

  var inv = ccReadInvoices_(ss, today);
  var pay = ccReadPayables_(ss);
  var expo = ccReadList_(ss, CC.T.EXPO);
  var hist = ccReadList_(ss, CC.T.HIST);
  var io = ccReadIo_(ss);
  var inputs = ccReadInputs_(ss);

  // PAN universe: every PAN with an owner / input row + every PAN with an open invoice.
  var pans = Object.keys(inputs.byPan);
  Object.keys(inv.agg).forEach(function (p) { if (inv.agg[p].openCount && !inputs.byPan[p]) pans.push(p); });
  var newInputs = [];
  pans.forEach(function (p) {
    if (inputs.byPan[p]) return;
    var guess = inv.agg[p] && inv.agg[p].assoc && teamBy[inv.agg[p].assoc] ? inv.agg[p].assoc : '';
    var row = ccFit_([p, guess], CC_INPUT_COLS.length);
    inputs.byPan[p] = row;
    newInputs.push(row);
  });
  if (newInputs.length) {
    var ish = ccSheet_(CC.T.INPUTS);
    var start = Math.max(ish.getLastRow(), 1) + 1;
    if (ish.getMaxRows() < start + newInputs.length - 1) ish.insertRowsAfter(ish.getMaxRows(), start + newInputs.length - 1 - ish.getMaxRows());
    ish.getRange(start, 1, newInputs.length, CC_INPUT_COLS.length).setValues(newInputs);
  }
  var ownerOf = {};
  pans.forEach(function (p) { ownerOf[p] = ccStr_(inputs.byPan[p][1]); });

  var ptp = ccRefreshPtp_(ss, inv, ownerOf, !!opts.addOverdue && cfg.ADD_OVERDUE_TO_PTP !== 'No', today);
  var fu = ccReadFollowUps_(ss);

  // Rows
  var workdays = [];
  for (var back = 1; workdays.length < 3 && back < 15; back++) {
    var d = ccAddDays_(today, -back);
    if (ccIsWorkday_(d, cfg)) workdays.push(d);
  }
  var last7 = [];
  for (var k = 6; k >= 0; k--) last7.push(ccAddDays_(today, -k));
  var rows = pans.map(function (p) {
    var a = inv.agg[p] || ccEmptyAgg_();
    var inp = inputs.byPan[p];
    var owner = ccStr_(inp[CC_IN.owner]);
    var t = teamBy[owner] || {};
    var payInfo = pay[p];
    var netPay = payInfo ? payInfo.net : 0;
    var b = a.b;
    var total = b.reduce(function (s, x) { return s + x; }, 0);
    var overdue = total - b[0];
    var gt60 = b[3] + b[4] + b[5] + b[6];
    var ioInfo = io[p];
    var daily = fu.byPan[p] || {};
    var lastTouch = '';
    Object.keys(daily).forEach(function (dk) {
      if (dk <= today && ccTouched_(daily[dk]) && dk > lastTouch) lastTouch = dk;
    });
    var pr = ptp.byPan[p] || { open: 0, amt: 0, next: '', broken: 0, dueToday: 0 };
    var r = {
      pan: p, customer: a.customer || ccStr_((pay[p] || {}).name), owner: owner, teamLead: t.teamLead || '',
      group: t.group || (owner ? '' : 'Unassigned'),
      brands: a.brands.join(', '), months: a.months.length ? a.months.join(', ') : 'NA',
      kamMgr: a.kamMgr.join(', '), kams: a.kams.join(', '),
      bizModel: payInfo ? (payInfo.model || '') : 'Vendor Does not Exist',
      arApHist: hist[p] ? 'Yes' : 'No', exposure: expo[p] ? 'Yes' : 'No',
      buHead: a.buHead.join(', '), cat1: a.cat1.join(', '), cat2: a.cat2.join(', '), bizfin: a.bizfin.join(', '),
      ioRate: ioInfo && ioInfo.rate ? ioInfo.rate : 'NA', ioDone: ioInfo ? (ioInfo.done ? 'Yes' : 'No') : '',
      b0: b[0], b1: b[1], b2: b[2], b3: b[3], b4: b[4], b5: b[5], b6: b[6],
      total: total, overdue: overdue, gt60: gt60, netPayable: netPay,
      possibleArAp: netPay > 0 ? Math.min(overdue, netPay) : 0,
      possibleArApTotal: netPay > 0 ? Math.min(total, netPay) : 0,
      possibleArAp60: netPay > 0 ? Math.min(gt60, netPay) : 0,
      openInv: a.openCount, oldest: a.oldest || '',
      ptpOpen: pr.open, ptpAmt: pr.amt, ptpNext: pr.next, ptpBroken: pr.broken, ptpDueToday: pr.dueToday,
      lastTouch: lastTouch, daysSince: lastTouch ? ccDiffDays_(lastTouch, today) : '',
      last7: last7.map(function (dk) { return ccStatusCode_(daily[dk]); }).join(' '),
      recent: last7.slice().reverse().map(function (dk) { return daily[dk] || ''; }),
      fuMtd: Object.keys(daily).filter(function (dk) { return dk.slice(0, 7) === today.slice(0, 7) && dk <= today && ccTouched_(daily[dk]); }).length,
      todayStatus: daily[today] || '',
      notFollowed3: total > 0 && workdays.length === 3 && workdays.every(function (dk) { return !daily[dk] || daily[dk] === 'No'; }),
      redAmt: inp[CC_IN.redAmt] === '' ? '' : ccNum_(inp[CC_IN.redAmt]),
      amberAmt: inp[CC_IN.amberAmt] === '' ? '' : ccNum_(inp[CC_IN.amberAmt]),
      greenAmt: inp[CC_IN.greenAmt] === '' ? '' : ccNum_(inp[CC_IN.greenAmt]),
      poe: ccStr_(inp[CC_IN.poe]),
      nextFu: inp[CC_IN.nextFu] instanceof Date ? ccKey_(inp[CC_IN.nextFu]) : ccStr_(inp[CC_IN.nextFu]),
      remarks: ccStr_(inp[CC_IN.remarks]), tlRemarks: ccStr_(inp[CC_IN.tlRemarks]),
      updatedBy: ccStr_(inp[CC_IN.by]), updatedOn: inp[CC_IN.on] instanceof Date ? inp[CC_IN.on] : ''
    };
    r.confidence = ccConfidenceOf_(r);
    r.priority = ccPriority_(r, today);
    return r;
  });

  // Auto "Invoice Not Due" for today (daily maintenance)
  if (opts.autoNotDue && cfg.AUTO_NOT_DUE !== 'No') {
    var auto = [];
    rows.forEach(function (r) {
      if (!r.todayStatus && r.owner && r.overdue === 0 && r.b0 > 0) {
        r.todayStatus = 'Invoice Not Due';
        auto.push([ccDate_(today), r.pan, r.owner, 'Invoice Not Due', 'Auto', '', new Date()]);
      }
    });
    if (auto.length) ccAppendRows_(ccSheet_(CC.T.FU), auto);
  }

  // Re-read inputs right before writing so anything saved while this rebuild was running is not shown stale.
  var latest = ccReadInputs_(ss).byPan;
  rows.forEach(function (r) {
    var inp = latest[r.pan];
    if (!inp) return;
    var owner = ccStr_(inp[CC_IN.owner]);
    if (owner !== r.owner) { var t2 = teamBy[owner] || {}; r.owner = owner; r.teamLead = t2.teamLead || ''; r.group = t2.group || (owner ? '' : 'Unassigned'); }
    ['redAmt', 'amberAmt', 'greenAmt'].forEach(function (k) { r[k] = inp[CC_IN[k]] === '' ? '' : ccNum_(inp[CC_IN[k]]); });
    r.poe = ccStr_(inp[CC_IN.poe]);
    r.nextFu = inp[CC_IN.nextFu] instanceof Date ? ccKey_(inp[CC_IN.nextFu]) : ccStr_(inp[CC_IN.nextFu]);
    r.remarks = ccStr_(inp[CC_IN.remarks]);
    r.tlRemarks = ccStr_(inp[CC_IN.tlRemarks]);
    r.updatedBy = ccStr_(inp[CC_IN.by]);
    r.updatedOn = inp[CC_IN.on] instanceof Date ? inp[CC_IN.on] : '';
    r.confidence = ccConfidenceOf_(r);
  });

  var order = {};
  team.forEach(function (t, i) { order[t.name] = i; });
  rows.sort(function (x, y) {
    var ox = order[x.owner] === undefined ? 999 : order[x.owner];
    var oy = order[y.owner] === undefined ? 999 : order[y.owner];
    return ox - oy || y.overdue - x.overdue || y.total - x.total;
  });
  ccWritePanMaster_(ss, rows);
  ccPutOpenCache_(inv);

  var model = { cfg: cfg, today: today, team: team, rows: rows, fu: fu, ptp: ptp, io: io, inv: inv, pay: pay };
  ccBuildDashboard_(ss, model);
  return { pans: rows.length, openInvoices: inv.openList.length, model: model };
}

/** The colour holding the largest amount (associates can split a PAN across colours). */
function ccConfidenceOf_(r) {
  var best = '';
  var max = 0;
  [['Red', r.redAmt], ['Amber', r.amberAmt], ['Green', r.greenAmt]].forEach(function (x) {
    var v = Number(x[1]) || 0;
    if (v > max) { max = v; best = x[0]; }
  });
  return best;
}

function ccEmptyAgg_() {
  return { customer: '', brands: [], months: [], kamMgr: [], kams: [], buHead: [], cat1: [], cat2: [], bizfin: [],
    b: [0, 0, 0, 0, 0, 0, 0], openCount: 0, oldest: 0, assoc: '' };
}

function ccTouched_(v) { return !!v && v !== 'No' && v !== 'Leave' && v !== 'Holiday'; }
function ccStatusCode_(v) {
  return { 'Yes': '✓', 'PTP': 'P', 'Expected Payment': 'E', 'Invoice Not Due': 'ND', 'No': '✗', 'Leave': 'L', 'Holiday': 'H' }[v] || (v ? v.charAt(0) : '·');
}

function ccPriority_(r, today) {
  var s = 0;
  s += r.overdue > 0 ? Math.log10(r.overdue + 1) * 10 : 0;
  s += r.gt60 > 0 ? Math.log10(r.gt60 + 1) * 6 : 0;
  s += r.daysSince === '' ? 25 : Math.min(r.daysSince, 10) * 3;
  s += r.ptpBroken * 20 + r.ptpDueToday * 15;
  if (r.exposure === 'Yes') s += 10;
  if (r.possibleArAp > 0) s += 5;
  if (r.confidence === 'Red') s += 10;
  if (r.todayStatus) s -= 40;
  if (r.nextFu && r.nextFu <= today) s += 15;
  return Math.round(s);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Invoices tab -> per-PAN aggregates, open-invoice list, invoice index. */
function ccReadInvoices_(ss, today) {
  var sh = ss.getSheetByName(CC.T.INV);
  var out = { agg: {}, openList: [], byInv: {}, total: 0, rows: 0 };
  if (!sh || sh.getLastRow() < 2) return out;
  var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var C = ccInvCols_(vals[0]);
  var uniq = function (arr, v, split) {
    if (v === '' || v === null || v === undefined) return;
    (split ? String(v).split(',') : [v]).forEach(function (x) {
      x = String(x).trim();
      if (x && x !== '0' && arr.indexOf(x) < 0) arr.push(x);
    });
  };
  var g = function (row, k) { return C[k] < 0 ? '' : row[C[k]]; };
  for (var i = 1; i < vals.length; i++) {
    var row = vals[i];
    var pan = ccStr_(g(row, 'pan'));
    var no = ccStr_(g(row, 'inv'));
    if (!pan && !no) continue;
    out.rows++;
    var net = ccNum_(g(row, 'net'));
    var bucket = ccStr_(g(row, 'bucket'));
    var due = g(row, 'due') instanceof Date ? ccKey_(g(row, 'due')) : '';
    var ageing = g(row, 'ageing') === '' ? (due ? ccDiffDays_(due, today) : 0) : ccNum_(g(row, 'ageing'));
    if (net !== 0 && CC.BUCKETS.indexOf(bucket) < 0) bucket = ccBucketOf_(ageing);
    var rec = {
      pan: pan, month: ccStr_(g(row, 'month')), invDate: ccKey_(g(row, 'invDate')), dueDate: due,
      credit: ccNum_(g(row, 'credit')), inv: no, cust: ccStr_(g(row, 'cust')), kam: ccStr_(g(row, 'kam')),
      kamMgr: ccStr_(g(row, 'kamMgr')), assoc: ccStr_(g(row, 'assoc')), tds: ccNum_(g(row, 'tds')),
      receipt: ccNum_(g(row, 'receipt')), receiptDate: ccKey_(g(row, 'receiptDate')), arap: ccNum_(g(row, 'arap')),
      net: net, brand: ccStr_(g(row, 'brand')), ageing: ageing, bucket: bucket,
      buHead: ccStr_(g(row, 'buHead')), bizfin: ccStr_(g(row, 'bizfin'))
    };
    if (no) out.byInv[no] = rec;
    if (!pan) continue;
    var a = out.agg[pan] || (out.agg[pan] = ccEmptyAgg_());
    if (!a.customer && rec.cust) a.customer = rec.cust;
    if (!a.assoc && rec.assoc) a.assoc = rec.assoc;
    uniq(a.brands, rec.brand);
    uniq(a.kamMgr, rec.kamMgr);
    uniq(a.kams, rec.kam);
    uniq(a.buHead, g(row, 'buHead'), true);
    uniq(a.cat1, g(row, 'cat1'), true);
    uniq(a.cat2, g(row, 'cat2'), true);
    uniq(a.bizfin, g(row, 'bizfin'), true);
    if (net !== 0) {
      uniq(a.months, rec.month);
      var bi = CC.BUCKETS.indexOf(bucket);
      if (bi >= 0) a.b[bi] += net;
      a.openCount++;
      if (bi > 0 && ageing > a.oldest) a.oldest = ageing;
      out.total += net;
      out.openList.push(rec);
    }
  }
  return out;
}

function ccInvCols_(hdr) {
  var norm = hdr.map(ccNorm_);
  var find = function (names, prefix) {
    for (var i = 0; i < names.length; i++) {
      var n = ccNorm_(names[i]);
      for (var j = 0; j < norm.length; j++) if (prefix ? norm[j].indexOf(n) === 0 : norm[j] === n) return j;
    }
    return -1;
  };
  return {
    pan: find(['PAN #', 'PAN']), month: find(['Revised Activity month']), invDate: find(['Invoice Date']),
    due: find(['Due Date']), credit: find(['Credit Period']), inv: find(['Invoice no']), cust: find(['Customer Name']),
    kam: find(['KAM']), kamMgr: find(['KAM Manager']), assoc: find(['Associate']), tds: find(['TDS Amount']),
    receipt: find(['Receipt']), receiptDate: find(['Receipt Date']), arap: find(['AR AP adjustment']),
    net: find(['Net to be received']), brand: find(['Brand']), ageing: find(['Ageing in Days']),
    bucket: find(['Ageing Bucket']), buHead: find(['BU Head']),
    cat1: find(['Corrected Brand Manager (L2)'], true), cat2: find(['Corrected Brand Manager (L1)'], true),
    bizfin: find(['BizFin SPOC'])
  };
}

function ccBucketOf_(age) {
  if (age <= 0) return 'a.Not Due';
  if (age <= 30) return 'b.0-30';
  if (age <= 60) return 'c.31-60';
  if (age <= 90) return 'd.61-90';
  if (age <= 120) return 'e.91-120';
  if (age <= 150) return 'f.121-150';
  return 'g.>151';
}

/** Payables tab: summary block A:D (PAN Number, PAN Name, Net Payable, Business Models) - first match wins. */
function ccReadPayables_(ss) {
  var sh = ss.getSheetByName(CC.T.PAY);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
    var p = ccStr_(r[0]);
    if (p && !out[p]) out[p] = { name: ccStr_(r[1]), net: ccNum_(r[2]), model: ccStr_(r[3]) };
  });
  return out;
}

function ccReadList_(ss, name) {
  var sh = ss.getSheetByName(name);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { var p = ccStr_(r[0]); if (p) out[p] = true; });
  return out;
}

function ccReadIo_(ss) {
  var sh = ss.getSheetByName(CC.T.IO);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, CC_IO_COLS.length).getValues().forEach(function (r, i) {
    var p = ccStr_(r[0]);
    if (!p || out[p]) return;
    out[p] = {
      row: i + 2, pan: p, customer: ccStr_(r[1]), band: ccStr_(r[3]), rate: ccNum_(r[5]),
      prevAssoc: ccStr_(r[6]), assoc: ccStr_(r[7]), link: ccStr_(r[8]), remarks: ccStr_(r[9]),
      done: !!ccStr_(r[8]), signDate: r[12] instanceof Date ? ccKey_(r[12]) : ''
    };
  });
  return out;
}

function ccReadInputs_(ss) {
  var sh = ccSheet_(CC.T.INPUTS);
  var t = ccReadTable_(sh, CC_INPUT_COLS.length);
  var byPan = {};
  t.rows.forEach(function (r, i) {
    var p = ccStr_(r[0]);
    if (p && !byPan[p]) { var fr = ccFit_(r, CC_INPUT_COLS.length); fr.rowNo = i + 2; byPan[p] = fr; }
  });
  return { sh: sh, byPan: byPan };
}

/** Follow-ups -> {byPan: {pan: {date: status}}, byAssocDate: {assoc: {date: {status: n}}}} */
function ccReadFollowUps_(ss) {
  var sh = ss.getSheetByName(CC.T.FU);
  var out = { byPan: {}, byAssocDate: {}, dates: {} };
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
    var d = ccKey_(r[0]);
    var p = ccStr_(r[1]);
    var st = ccStr_(r[3]);
    if (!d || !p || !st) return;
    (out.byPan[p] = out.byPan[p] || {})[d] = st;
    var a = ccStr_(r[2]);
    var ad = (out.byAssocDate[a] = out.byAssocDate[a] || {});
    var cell = (ad[d] = ad[d] || {});
    cell[st] = (cell[st] || 0) + 1;
    out.dates[d] = true;
  });
  return out;
}

// ---------------------------------------------------------------------------
// PTP Tracker refresh
// ---------------------------------------------------------------------------

function ccPtpStatus_(ptpKey, outstanding, added, settleKey, today) {
  today = today || ccToday_();
  var out = Number(outstanding);
  var known = outstanding !== '' && outstanding !== null && outstanding !== undefined && !isNaN(out);
  if (!ptpKey) return known && out <= 0 ? 'Paid' : 'PTP Pending';
  if (known && out <= 0) return (settleKey || today) <= ptpKey ? 'Paid (PTP Kept)' : 'Paid (after PTP)';
  if (ptpKey < today) return 'PTP Broken';
  if (known && added && out < Number(added)) return 'Partially Paid';
  if (ptpKey === today) return 'PTP Due Today';
  return 'PTP Given';
}

/**
 * Refresh every PTP Tracker row from Invoices (PAN, current outstanding, settlement date, status, days vs PTP),
 * turn free-text dates typed into Status ("25th sep") into PTP dates, optionally add new overdue invoices.
 * Returns roll-ups per PAN plus the refreshed rows.
 */
function ccRefreshPtp_(ss, inv, ownerOf, addOverdue, today) {
  var sh = ccSheet_(CC.T.PTP);
  var W = CC_PTP_COLS.length;
  var t = ccReadTable_(sh, W);
  var rows = t.rows.map(function (r) { return ccFit_(r, W); }).filter(function (r) { return r[0] !== ''; });
  var year = Number(today.slice(0, 4));
  var seen = {};
  rows.forEach(function (row) {
    var no = ccStr_(row[0]);
    seen[no] = true;
    var rec = inv.byInv[no];
    if (rec) {
      if (!row[12]) row[12] = rec.pan;
      if (!row[3] && ownerOf[rec.pan]) row[3] = ownerOf[rec.pan];
      row[6] = rec.net;
      if (rec.net <= 0 && !(row[9] instanceof Date)) row[9] = ccDate_(rec.receiptDate || today);
    }
    var st = ccStr_(row[11]);
    var ptpKey = row[8] instanceof Date ? ccKey_(row[8]) : '';
    if (!ptpKey) {
      var parsed = ccParseLooseDate_(st, year);
      if (parsed) { ptpKey = parsed; row[8] = ccDate_(parsed); }
    }
    var settleKey = row[9] instanceof Date ? ccKey_(row[9]) : '';
    var outstanding = row[6] === '' ? '' : ccNum_(row[6]);
    var added = ccNum_(row[5]) || outstanding;
    var next = st;
    if (ptpKey) {
      next = ccPtpStatus_(ptpKey, outstanding, added, settleKey, today);
      var paid = outstanding !== '' && outstanding <= 0;
      var ref = paid ? (settleKey || today) : today;
      row[10] = ref >= ptpKey || paid ? ccDiffDays_(ptpKey, ref) : '';
    } else if (rec && rec.net <= 0) {
      next = 'Paid';
    } else if (!st) {
      next = 'PTP Pending';
    }
    if (next !== st) {
      if (st && CC.STATUSES.indexOf(st) < 0 && String(row[16]).indexOf(st) < 0) row[16] = row[16] ? row[16] + ' | ' + st : st;
      row[11] = next;
    }
  });
  var addedN = 0;
  if (addOverdue) {
    inv.openList.forEach(function (r) {
      if (seen[r.inv] || !(r.net > 0) || r.bucket === 'a.Not Due' || !r.bucket) return;
      var row = ccFit_([], W);
      row[0] = r.inv; row[1] = r.cust; row[2] = r.brand; row[3] = ownerOf[r.pan] || '';
      row[4] = r.dueDate ? ccDate_(r.dueDate) : ''; row[5] = r.net; row[6] = r.net; row[7] = ccDate_(today);
      row[11] = 'PTP Pending'; row[12] = r.pan;
      rows.push(row);
      seen[r.inv] = true;
      addedN++;
    });
  }
  ccWriteTable_(sh, rows, 2);

  var byPan = {};
  var list = rows.map(function (row) {
    var o = ccPtpRowObj_(row, today);
    if (o.pan && o.ptpDate && o.outstanding > 0) {
      var b = byPan[o.pan] || (byPan[o.pan] = { open: 0, amt: 0, next: '', broken: 0, dueToday: 0 });
      b.open++;
      b.amt += o.ptpAmount === '' ? o.outstanding : o.ptpAmount;
      if (o.ptpDate < today) b.broken++;
      else if (o.ptpDate === today) b.dueToday++;
      if (o.ptpDate >= today && (!b.next || o.ptpDate < b.next)) b.next = o.ptpDate;
    }
    return o;
  });
  return { byPan: byPan, rows: list, added: addedN };
}

function ccPtpRowObj_(row, today) {
  var dk = function (v) { return v instanceof Date ? ccKey_(v) : ''; };
  var o = {
    invoice: ccStr_(row[0]), customer: ccStr_(row[1]), brand: ccStr_(row[2]), associate: ccStr_(row[3]),
    dueDate: dk(row[4]), added: ccNum_(row[5]), outstanding: row[6] === '' ? 0 : ccNum_(row[6]), addedOn: dk(row[7]),
    ptpDate: dk(row[8]), settlement: dk(row[9]), days: row[10], status: ccStr_(row[11]), pan: ccStr_(row[12]),
    ptpAmount: row[13] === '' ? '' : ccNum_(row[13]), mode: ccStr_(row[14]), contact: ccStr_(row[15]),
    remarks: ccStr_(row[16]), tag: ccStr_(row[17]), updatedBy: ccStr_(row[18]),
    updatedOn: row[19] instanceof Date ? row[19].toISOString() : ''
  };
  o.live = ccPtpStatus_(o.ptpDate, row[6], o.added, o.settlement, today);
  if (o.ptpDate && o.outstanding > 0 && o.ptpDate < today) o.daysLate = ccDiffDays_(o.ptpDate, today);
  return o;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function ccWritePanMaster_(ss, rows) {
  var sh = ccSheet_(CC.T.PAN);
  var before = sh.getMaxRows();
  var out = rows.map(function (r) {
    return CC_PAN_COLS.map(function (c) {
      var v = r[c.key];
      if (v === undefined || v === null) return '';
      if (c.date && v) return ccDate_(v);
      return v;
    });
  });
  ccWriteTable_(sh, out, 2);
  if (sh.getMaxRows() !== before) ccFormatPanColumns_(sh);
}

function ccAppendRows_(sh, rows) {
  if (!rows.length) return;
  var start = Math.max(sh.getLastRow(), 1) + 1;
  var need = start + rows.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

/** Open invoices go to CacheService (chunked) so the workbench never re-reads 80k rows. */
function ccPutOpenCache_(inv) {
  var list = inv.openList.map(function (r) {
    return [r.pan, r.month, r.invDate, r.dueDate, r.credit, r.inv, r.cust, r.kam, r.kamMgr, r.assoc,
      r.tds, r.receipt, r.receiptDate, r.arap, r.net, r.brand, r.ageing, r.bucket];
  });
  var json = JSON.stringify(list);
  var size = 90000;
  var put = {};
  var n = Math.ceil(json.length / size);
  for (var c = 0; c < n; c++) put[CC.CACHE_PREFIX + c] = json.substr(c * size, size);
  put[CC.CACHE_PREFIX + 'meta'] = JSON.stringify({ chunks: n, builtAt: new Date().toISOString(), count: list.length });
  try { CacheService.getScriptCache().putAll(put, CC.CACHE_TTL); } catch (e) { /* too big for cache: fall back to reading */ }
}

var CC_OPEN_FIELDS = ['pan', 'month', 'invDate', 'dueDate', 'credit', 'inv', 'cust', 'kam', 'kamMgr', 'assoc',
  'tds', 'receipt', 'receiptDate', 'arap', 'net', 'brand', 'ageing', 'bucket'];

/** Open invoices by PAN / invoice, from cache or (cold) from the Invoices tab. */
function ccOpenInvoices_() {
  var cache = CacheService.getScriptCache();
  var metaRaw = cache.get(CC.CACHE_PREFIX + 'meta');
  var list = null;
  if (metaRaw) {
    var meta = JSON.parse(metaRaw);
    var keys = [];
    for (var i = 0; i < meta.chunks; i++) keys.push(CC.CACHE_PREFIX + i);
    var got = cache.getAll(keys);
    if (keys.every(function (k) { return got[k] !== undefined && got[k] !== null; })) {
      list = JSON.parse(keys.map(function (k) { return got[k]; }).join(''));
    }
  }
  var byPan = {};
  var byInv = {};
  if (!list) {
    var inv = ccReadInvoices_(SpreadsheetApp.getActive(), ccToday_());
    ccPutOpenCache_(inv);
    inv.openList.forEach(function (o) { (byPan[o.pan] = byPan[o.pan] || []).push(o); byInv[o.inv] = o; });
    return { byPan: byPan, byInv: byInv };
  }
  list.forEach(function (a) {
    var o = {};
    CC_OPEN_FIELDS.forEach(function (f, i) { o[f] = a[i]; });
    (byPan[o.pan] = byPan[o.pan] || []).push(o);
    byInv[o.inv] = o;
  });
  return { byPan: byPan, byInv: byInv };
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

/** 07:00 - PTP statuses, new overdue invoices into PTP Tracker, auto "Invoice Not Due". */
function CC_dailyMaintenance() {
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    ccRebuild_({ addOverdue: true, autoNotDue: true });
  } finally {
    lock.releaseLock();
  }
}

/** 23:00 - one row per associate into Snapshots (trend history for management). */
function CC_nightlySnapshot() {
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    var r = ccRebuild_();
    ccWriteSnapshot_(r.model);
  } finally {
    lock.releaseLock();
  }
}

function ccWriteSnapshot_(model) {
  var ss = SpreadsheetApp.getActive();
  var sh = ccSheet_(CC.T.SNAP);
  var today = model.today;
  var t = ccReadTable_(sh, CC_SNAP_COLS.length);
  var keep = t.rows.filter(function (r) { return r[0] && ccKey_(r[0]) !== today; }).map(function (r) { return ccFit_(r, CC_SNAP_COLS.length); });
  var acts = {};
  ccReadLog_(ss).forEach(function (l) { if (l.date === today) acts[l.assoc] = (acts[l.assoc] || 0) + 1; });
  ccSummaryByAssociate_(model).forEach(function (s) {
    if (!s.isTotal) keep.push([ccDate_(today), s.name, s.teamLead, s.nonZero, s.total, s.overdue, s.gt60, s.netPayable,
      s.possibleArAp, s.touchedToday, s.nonZero ? s.touchedToday / s.nonZero : 0, s.notFollowed3, s.ptpOpen, s.ptpAmt,
      s.ptpBroken, acts[s.name] || 0]);
  });
  ccWriteTable_(sh, keep, 2);
}
