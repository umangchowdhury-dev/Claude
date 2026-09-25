/**
 * Pull from the live tracker (read-only) into this sheet.
 *
 *  Raw data  (every sync, skipped when unchanged): Imported_Data -> Invoices, Payable Data - Daily -> Payables,
 *            Category Mapping, Brand Name Mapping, Exposure / Historic AR-AP PAN lists.
 *  Inputs    (TEST mode only): owner per PAN (Consolidated + associate tabs), Associate / Team Lead remarks,
 *            POE, Red/Yellow/Green, the daily follow-up grid, PTP Tracker rows, IO sign-off links, team roster.
 *
 * Merge rule for inputs: a value coming from the live sheet wins only when it CHANGED in the live sheet since the
 * last sync, so anything entered here is never overwritten by a stale live value.
 */

function CC_scheduledSync() {
  var p = ccPendingStage_();
  if (p === -2) return; // a continuation is already scheduled
  ccSync_({ resume: p >= 0 });
}

function CC_syncNow() {
  var p = ccPendingStage_();
  var r = ccSync_({ resume: p !== -1 });
  SpreadsheetApp.getActive().toast(r.summary, r.pending ? 'Sync continues in the background' : 'Sync finished', 10);
}

/**
 * Index of a paused sync's next step, or -1. A pause younger than 10 minutes is left to its own
 * one-off trigger (returns -2 so callers skip); an older one is treated as stuck and resumed.
 */
function ccPendingStage_() {
  var props = PropertiesService.getScriptProperties();
  var st = props.getProperty('cc_sync_stage');
  if (st === null || st === undefined || st === '') return -1;
  var at = Number(props.getProperty('cc_sync_stage_at') || 0);
  return Date.now() - at < 10 * 60 * 1000 && ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'CC_resumeSync'; }) ? -2 : Number(st);
}

/** One-off trigger target: continue a sync that stopped to stay inside Google's 6-minute limit. */
function CC_resumeSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'CC_resumeSync') ScriptApp.deleteTrigger(t);
  });
  ccSync_({ resume: true });
}

/**
 * Sync in stages. Google stops a script after 6 minutes, so before each stage we check the time left;
 * when a stage might not fit, progress is saved and a one-off trigger continues a minute later.
 */
var CC_SYNC_STAGES = [
  { name: 'invoices', needSec: 150 },
  { name: 'mirrors', needSec: 60 },
  { name: 'inputs', needSec: 150 },
  { name: 'rebuild', needSec: 150 }
];

function ccSync_(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { summary: 'Another sync is running - skipped' };
  var props = PropertiesService.getScriptProperties();
  var started = new Date();
  var budgetMs = opts.budgetMs !== undefined ? opts.budgetMs : 270000; // stop starting new work after 4.5 min (Google's hard limit is 6)
  var cfg = ccConfig_();
  var from = opts.resume ? Number(props.getProperty('cc_sync_stage') || 0) : 0;
  var done = opts.resume ? JSON.parse(props.getProperty('cc_sync_done') || '[]') : [];
  var result = 'OK';
  var pending = false;
  var handles = {};
  var open = function (id) { return handles[id] || (handles[id] = SpreadsheetApp.openById(id)); };
  // Visible straight away; if Google kills the run, this line stays "RUNNING" and the next run picks up.
  var logRow = ccSyncLog_([started, '', '', cfg.MODE, opts.resume ? 'continuing from step ' + (from + 1) + ' of ' + CC_SYNC_STAGES.length : 'started', 'RUNNING']);
  try {
    for (var i = from; i < CC_SYNC_STAGES.length; i++) {
      var st = CC_SYNC_STAGES[i];
      var elapsed = new Date() - started;
      if (i > from && elapsed + st.needSec * 1000 > budgetMs) {
        props.setProperty('cc_sync_stage', String(i));
          props.setProperty('cc_sync_stage_at', String(Date.now()));
        props.setProperty('cc_sync_done', JSON.stringify(done));
        ScriptApp.newTrigger('CC_resumeSync').timeBased().after(60 * 1000).create();
        pending = true;
        result = 'PAUSED before "' + st.name + '" - continues automatically in ~1 min';
        break;
      }
      if (st.name === 'invoices' && cfg.RAW_ID && cfg.RAW_ID !== 'THIS') {
        var inv = ccPullInvoices_(open(cfg.RAW_ID), started.getTime() + budgetMs);
        done = done.concat(inv.out);
        if (inv.paused) {
          props.setProperty('cc_sync_stage', String(i));
          props.setProperty('cc_sync_stage_at', String(Date.now()));
          props.setProperty('cc_sync_done', JSON.stringify(done));
          ScriptApp.newTrigger('CC_resumeSync').timeBased().after(60 * 1000).create();
          pending = true;
          result = 'PAUSED while copying invoices (' + inv.progress + ') - continues automatically in ~1 min';
          break;
        }
      }
      if (st.name === 'mirrors' && cfg.RAW_ID && cfg.RAW_ID !== 'THIS') done = done.concat(ccPullMirrors_(open(cfg.RAW_ID)));
      if (st.name === 'inputs' && cfg.MODE === 'TEST' && cfg.LIVE_SHEET_ID) done = done.concat(ccPullInputs_(open(cfg.LIVE_SHEET_ID)));
      if (st.name === 'rebuild') {
        var lastRb = Number(props.getProperty('cc_last_rebuild_ms') || 0);
        var sameDay = lastRb && ccKey_(new Date(lastRb)) === ccToday_();
        if (!opts.forceRebuild && props.getProperty('cc_dirty') !== '1' && sameDay && Date.now() - lastRb < 2 * 3600 * 1000) {
          done.push('Nothing changed - PAN Master / Dashboard kept');
          props.setProperty('cc_last_sync', Utilities.formatDate(new Date(), ccTz_(), 'dd-MMM-yy HH:mm'));
          continue;
        }
        var stats = ccRebuild_();
        done.push('PAN Master ' + stats.pans + ' PANs, ' + stats.openInvoices + ' open invoices');
        props.setProperty('cc_last_sync', Utilities.formatDate(new Date(), ccTz_(), 'dd-MMM-yy HH:mm'));
      }
    }
    if (!pending) { props.deleteProperty('cc_sync_stage'); props.deleteProperty('cc_sync_done'); props.deleteProperty('cc_sync_stage_at'); }
  } catch (e) {
    result = 'ERROR: ' + (e && e.message ? e.message : e);
    props.deleteProperty('cc_sync_stage');
    props.deleteProperty('cc_sync_done');
    throw e;
  } finally {
    var secs = Math.round((new Date() - started) / 1000);
    ccSyncLog_([started, new Date(), secs, cfg.MODE, done.join(' | '), result], logRow);
    lock.releaseLock();
  }
  return { summary: pending ? 'Part done - the rest continues automatically in about a minute (see Sync Log).' : done.join('\n'), result: result, pending: pending };
}

/** Append a Sync Log line (or overwrite line `rowNo`). Returns the row number. */
function ccSyncLog_(row, rowNo) {
  var sh = ccSheet_(CC.T.SYNC);
  if (rowNo && rowNo <= sh.getLastRow()) {
    sh.getRange(rowNo, 1, 1, row.length).setValues([row]);
    return rowNo;
  }
  var extra = sh.getLastRow() - 500; // keep the last 500 runs
  if (extra > 0) sh.deleteRows(2, extra);
  sh.appendRow(row);
  return sh.getLastRow();
}

// ---------------------------------------------------------------------------
// Raw data
// ---------------------------------------------------------------------------

/**
 * Imported_Data -> Invoices, written in batches. Progress is saved after every batch, so a copy that does
 * not fit in one run carries on in the next one (same data = same fingerprint) instead of starting over.
 * Returns {out: [...], paused: bool, progress: 'rows/total'}.
 */
var CC_INV_BATCH = 4000;

function ccPullInvoices_(src, deadlineMs) {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  var inv = src.getSheetByName(CC.LIVE.INV);
  if (!inv) return { out: ['Imported_Data not found'], paused: false };
  var last = inv.getLastRow();
  var top = inv.getRange(1, 1, Math.min(10, last), Math.min(inv.getLastColumn(), 60)).getValues();
  var hr = -1;
  for (var i = 0; i < top.length; i++) if (ccNorm_(top[i][0]) === 'pan #' || ccNorm_(top[i][0]) === 'pan') { hr = i; break; }
  if (hr < 0) throw new Error('Imported_Data: header row with "PAN #" not found');
  var hdr = top[hr];
  var width = 0;
  hdr.forEach(function (h, j) { if (h !== '' && h !== null) width = j + 1; });
  hdr = hdr.slice(0, width);
  var data = last > hr + 1 ? inv.getRange(hr + 2, 1, last - hr - 1, width).getValues() : [];
  var gCol = hdr.map(ccNorm_).indexOf('invoice no');
  data = data.filter(function (r) { return r[0] !== '' || (gCol >= 0 && r[gCol] !== ''); });
  var fp = ccFingerprint_(hdr, data);
  if (props.getProperty('cc_fp_inv') === fp) return { out: ['Invoices unchanged'], paused: false };

  var dst = ccSheet_(CC.T.INV);
  var prog = JSON.parse(props.getProperty('cc_inv_progress') || 'null');
  var next = prog && prog.fp === fp ? prog.next : 0;
  if (next === 0) {
    // fresh copy: size the grid once, wipe old content, write the header
    var need = data.length + 1;
    if (dst.getMaxRows() < need) dst.insertRowsAfter(dst.getMaxRows(), need - dst.getMaxRows());
    if (dst.getMaxColumns() < width) dst.insertColumnsAfter(dst.getMaxColumns(), width - dst.getMaxColumns());
    if (dst.getLastRow() > 0) dst.getRange(1, 1, dst.getLastRow(), Math.max(dst.getLastColumn(), width)).clearContent();
    dst.getRange(1, 1, 1, width).setValues([hdr]).setFontWeight('bold').setBackground(CC.COLORS.data);
    dst.setFrozenRows(1);
  }
  while (next < data.length) {
    if (next > 0 && Date.now() > deadlineMs - 30000) {
      props.setProperty('cc_inv_progress', JSON.stringify({ fp: fp, next: next }));
      return { out: ['Invoices ' + next + '/' + data.length + ' copied'], paused: true, progress: next + '/' + data.length };
    }
    var chunk = data.slice(next, next + CC_INV_BATCH);
    dst.getRange(next + 2, 1, chunk.length, width).setValues(chunk);
    next += chunk.length;
    props.setProperty('cc_inv_progress', JSON.stringify({ fp: fp, next: next }));
  }
  // remove rows left over from a longer previous copy
  var lastNow = dst.getLastRow();
  if (lastNow > data.length + 1) dst.getRange(data.length + 2, 1, lastNow - data.length - 1, Math.max(dst.getLastColumn(), width)).clearContent();
  props.deleteProperty('cc_inv_progress');
  props.setProperty('cc_fp_inv', fp);
  ccMarkDirty_();
  CacheService.getScriptCache().remove(CC.CACHE_PREFIX + 'meta');
  out.push('Invoices ' + data.length + ' rows');
  return { out: out, paused: false };
}

function ccPullMirrors_(src) {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  [[CC.LIVE.PAY, CC.T.PAY, 17], [CC.LIVE.CAT, CC.T.CAT, 9], [CC.LIVE.BRAND, CC.T.BRAND, 4],
   [CC.LIVE.EXPO, CC.T.EXPO, 1], [CC.LIVE.HIST, CC.T.HIST, 1]].forEach(function (m) {
    var s = src.getSheetByName(m[0]);
    if (!s || s.getLastRow() < 1) return;
    var vals = s.getRange(1, 1, s.getLastRow(), Math.min(m[2], Math.max(s.getLastColumn(), 1))).getValues();
    while (vals.length && vals[vals.length - 1].every(function (v) { return v === '' || v === null; })) vals.pop();
    var key = 'cc_fp_' + m[1];
    var fpm = ccFingerprint_(vals[0], vals);
    if (props.getProperty(key) === fpm) { out.push(m[1] + ' unchanged'); return; }
    var d = ccSheet_(m[1]);
    ccWriteTable_(d, vals, 1);
    d.getRange(1, 1, 1, vals[0].length).setFontWeight('bold').setBackground(CC.COLORS.data);
    d.setFrozenRows(1);
    props.setProperty(key, fpm);
    ccMarkDirty_();
    out.push(m[1] + ' ' + (vals.length - 1) + ' rows');
  });
  return out;
}

/** Cheap change detector: row count + numeric column sums + a sample of keys. */
function ccFingerprint_(hdr, rows) {
  var n = rows.length;
  var w = hdr ? hdr.length : (rows[0] || []).length;
  var sums = [];
  for (var c = 0; c < w; c++) sums.push(0);
  var text = 0;
  rows.forEach(function (r) {
    for (var c2 = 0; c2 < w; c2++) {
      var v = r[c2];
      if (typeof v === 'number') sums[c2] += v;
      else if (v instanceof Date) sums[c2] += v.getTime() / 86400000;
      else if (v !== '' && v !== null && v !== undefined) text += String(v).length * (c2 + 1);
    }
  });
  var sample = [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1].map(function (i) { return n ? String(rows[Math.max(i, 0)][0]) : ''; });
  return [n, w, text, sums.map(function (s) { return Math.round(s * 100) / 100; }).join(','), sample.join('|')].join('#');
}

// ---------------------------------------------------------------------------
// Inputs from the live tracker (TEST mode)
// ---------------------------------------------------------------------------

var CC_LIVE_ALIASES = {
  pan: ['PAN'], poe: ['POE Required ?', 'POE Required'], remarks: ['Associate Remarks', 'Remarks'],
  tlRemarks: ['Team Lead Remarks'], red: ['Red'], yellow: ['Yellow'], green: ['Green'],
  total: ['Total Receivables']
};

function ccLiveIndex_(hdr) {
  var norm = hdr.map(ccNorm_);
  var out = {};
  Object.keys(CC_LIVE_ALIASES).forEach(function (k) {
    for (var i = 0; i < CC_LIVE_ALIASES[k].length; i++) {
      var j = norm.indexOf(ccNorm_(CC_LIVE_ALIASES[k][i]));
      if (j >= 0) { out[k] = j; break; }
    }
  });
  return out;
}

function ccIsLiveAssocSheet_(sh) {
  if (sh.getName() === CC.LIVE.CONS || sh.getLastRow() < 2 || sh.getLastColumn() < 30) return false;
  var h = sh.getRange(2, 1, 1, 34).getValues()[0].map(ccNorm_);
  return h[0] === 'pan' && h.indexOf('total receivables') >= 0 && h.indexOf('team lead remarks') >= 0;
}

function ccPullInputs_(live) {
  var out = [];
  var today = ccToday_();
  var tabs = live.getSheets().filter(function (s) { return !s.isSheetHidden() && ccIsLiveAssocSheet_(s); });

  // 1. Team roster (add anyone new; never overwrite roles / e-mails typed here)
  var added = ccSyncTeam_(live, tabs);
  if (added) out.push('Team +' + added);

  // 2. Owner map from Consolidated
  var owners = {};
  var cons = live.getSheetByName(CC.LIVE.CONS);
  if (cons && cons.getLastRow() >= 3) {
    cons.getRange(3, 1, cons.getLastRow() - 2, 3).getValues().forEach(function (r) {
      var p = ccStr_(r[0]);
      if (p) owners[p] = ccStr_(r[2]);
    });
  }

  // 3. Associate tabs: inputs + follow-up grid
  var liveInputs = {};
  var liveFu = {};
  var liveFuDates = {};
  tabs.forEach(function (sh) {
    var name = sh.getName();
    // Tabs carry formatting/formulas far below the last PAN - read only down to the last PAN row.
    var colA = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
    var lastPan = 2;
    for (var k = colA.length - 1; k >= 2; k--) if (colA[k][0] !== '' && colA[k][0] !== null) { lastPan = k + 1; break; }
    var vals = sh.getRange(1, 1, lastPan, sh.getLastColumn()).getValues();
    var hdr = vals[1];
    var H = ccLiveIndex_(hdr);
    var dateCols = [];
    hdr.forEach(function (v, i) { if (v instanceof Date) { var k = ccKey_(v); if (k <= today) dateCols.push([i, k]); } });
    for (var r = 2; r < vals.length; r++) {
      var row = vals[r];
      var pan = ccStr_(row[0]);
      if (!pan) continue;
      liveInputs[pan] = {
        owner: owners[pan] || name,
        remarks: H.remarks !== undefined ? ccStr_(row[H.remarks]) : '',
        tlRemarks: H.tlRemarks !== undefined ? ccStr_(row[H.tlRemarks]) : '',
        poe: H.poe !== undefined ? ccStr_(row[H.poe]) : '',
        redAmt: H.red !== undefined && row[H.red] !== '' ? ccNum_(row[H.red]) : '',
        amberAmt: H.yellow !== undefined && row[H.yellow] !== '' ? ccNum_(row[H.yellow]) : '',
        greenAmt: H.green !== undefined && row[H.green] !== '' ? ccNum_(row[H.green]) : ''
      };
      dateCols.forEach(function (dc) {
        liveFuDates[dc[1]] = true;
        var v = ccStr_(row[dc[0]]);
        if (v) liveFu[dc[1] + '|' + pan] = { date: dc[1], pan: pan, assoc: name, status: v };
      });
    }
  });
  // PANs listed in Consolidated but on no associate tab (e.g. unassigned)
  Object.keys(owners).forEach(function (p) {
    if (!liveInputs[p]) liveInputs[p] = { owner: owners[p], remarks: '', tlRemarks: '', poe: '', redAmt: '', amberAmt: '', greenAmt: '' };
  });
  out.push(ccMergeInputs_(liveInputs));
  out.push(ccMergeFollowUps_(liveFu, liveFuDates));

  // 4. PTP Tracker
  var ptp = live.getSheetByName(CC.LIVE.PTP);
  if (ptp && ptp.getLastRow() >= 2) out.push(ccMergePtp_(ptp.getRange(1, 1, ptp.getLastRow(), Math.min(ptp.getLastColumn(), 20)).getValues()));

  // 5. IO sign-off
  var io = live.getSheetByName(CC.LIVE.IO);
  if (io && io.getLastRow() >= 2) out.push(ccMergeIo_(io));
  return out;
}

function ccSyncTeam_(live, tabs) {
  var sh = ccSheet_(CC.T.TEAM);
  var have = {};
  if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
  // Group labels from the live Summary (e.g. the "Legal" row points at the Ayush tab)
  var groups = {};
  var sum = live.getSheetByName('Summary');
  if (sum && sum.getLastRow() >= 2) {
    var labels = sum.getRange(1, 1, Math.min(sum.getLastRow(), 40), 2).getValues();
    var formulas = sum.getRange(1, 2, Math.min(sum.getLastRow(), 40), 1).getFormulas();
    labels.forEach(function (r, i) {
      var m = /([A-Za-z][\w ]*)!A3/.exec(formulas[i][0] || '');
      if (m && r[0] && String(r[0]).trim() !== m[1].trim()) groups[m[1].trim()] = String(r[0]).trim();
    });
  }
  var add = [];
  tabs.forEach(function (t) {
    var n = t.getName();
    if (!have[n]) add.push([n, 'Associate', '', groups[n] || 'Collections', '', 'Yes', n, 'Added by sync from the live sheet']);
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, CC_TEAM_COLS.length).setValues(add);
  return add.length;
}

/** PAN Inputs <- live values that changed since the last sync. */
function ccMergeInputs_(liveInputs) {
  var sh = ccSheet_(CC.T.INPUTS);
  var t = ccReadTable_(sh, CC_INPUT_COLS.length);
  var rows = t.rows.map(function (r) { return ccFit_(r, CC_INPUT_COLS.length); });
  var orig = rows.map(function (r) { return r.slice(); });
  var at = {};
  rows.forEach(function (r, i) { if (r[0]) at[String(r[0]).trim()] = i; });
  // [field in live, value col, live-last-seen col]
  var I = CC_IN;
  var map = [['owner', I.owner, I.lOwner], ['remarks', I.remarks, I.lRemarks], ['tlRemarks', I.tlRemarks, I.lTl], ['poe', I.poe, I.lPoe],
    ['redAmt', I.redAmt, I.lRed], ['amberAmt', I.amberAmt, I.lAmber], ['greenAmt', I.greenAmt, I.lGreen]];
  var changed = 0;
  var added = 0;
  Object.keys(liveInputs).forEach(function (pan) {
    var li = liveInputs[pan];
    var i = at[pan];
    if (i === undefined) {
      var nr = ccFit_([pan], CC_INPUT_COLS.length);
      rows.push(nr);
      i = at[pan] = rows.length - 1;
      added++;
    }
    var r = rows[i];
    map.forEach(function (m) {
      var v = li[m[0]] === undefined || li[m[0]] === null ? '' : li[m[0]];
      if (String(v) !== String(r[m[2]])) {
        r[m[1]] = v;
        r[m[2]] = v;
        changed++;
      }
    });
  });
  ccSyncRows_(sh, orig, rows);
  return 'Inputs +' + added + ' PANs, ' + changed + ' live changes';
}

/** Follow-ups <- live daily grid. Entries made here (Source != Live) win over live values for the same day. */
function ccMergeFollowUps_(liveFu, liveDates) {
  var sh = ccSheet_(CC.T.FU);
  var t = ccReadTable_(sh, CC_FU_COLS.length);
  var keep = t.rows.map(function (r) { return ccFit_(r, CC_FU_COLS.length); });
  var orig = keep.map(function (r) { return r.slice(); });
  var byKey = {};
  var removed = 0;
  keep.forEach(function (r, i) {
    if (!r[1]) return;
    var k = ccKey_(r[0]) + '|' + String(r[1]).trim();
    if (r[4] === 'Live' && liveDates[ccKey_(r[0])] && !liveFu[k]) { r[1] = ''; removed++; return; } // cleared in the live sheet
    byKey[k] = i;
  });
  var added = 0;
  var updated = 0;
  Object.keys(liveFu).forEach(function (k) {
    var f = liveFu[k];
    var i = byKey[k];
    if (i === undefined) {
      keep.push([ccDate_(f.date), f.pan, f.assoc, f.status, 'Live', '', '']);
      byKey[k] = keep.length - 1;
      added++;
    } else if (keep[i][4] === 'Live' && (keep[i][3] !== f.status || keep[i][2] !== f.assoc)) {
      keep[i][3] = f.status; keep[i][2] = f.assoc;
      updated++;
    }
  });
  if (removed || !orig.length) {
    // something was cleared in the live sheet (or first load): rewrite the log, sorted
    keep = keep.filter(function (r) { return r[1]; });
    keep.sort(function (a, b) {
      var ka = ccKey_(a[0]), kb = ccKey_(b[0]);
      return ka < kb ? -1 : ka > kb ? 1 : (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : (a[1] < b[1] ? -1 : 1));
    });
    ccWriteTable_(sh, keep, 2);
    ccMarkDirty_();
  } else {
    ccSyncRows_(sh, orig, keep); // only changed rows + new rows at the bottom
  }
  return 'Follow-ups ' + keep.length + ' (+' + added + ', ~' + updated + ', -' + removed + ')';
}

/** PTP Tracker <- live rows. Rows edited here (Updated By set) keep their PTP fields. */
function ccMergePtp_(liveVals) {
  var lh = liveVals[0].map(ccNorm_);
  var col = function (n) { return lh.indexOf(ccNorm_(n)); };
  var L = {};
  CC_PTP_COLS.forEach(function (h, i) { L[i] = col(h); });
  var sh = ccSheet_(CC.T.PTP);
  var t = ccReadTable_(sh, CC_PTP_COLS.length);
  var rows = t.rows.map(function (r) { return ccFit_(r, CC_PTP_COLS.length); });
  var orig = rows.map(function (r) { return r.slice(); });
  var at = {};
  rows.forEach(function (r, i) { if (r[0]) at[String(r[0]).trim()] = i; });
  var added = 0;
  var refreshed = 0;
  for (var i = 1; i < liveVals.length; i++) {
    var lv = liveVals[i];
    var inv = ccStr_(lv[L[0]]);
    if (!inv) continue;
    var j = at[inv];
    var fromLive = CC_PTP_COLS.map(function (_, c) { return L[c] >= 0 ? lv[L[c]] : ''; });
    if (j === undefined) {
      rows.push(fromLive);
      at[inv] = rows.length - 1;
      added++;
    } else if (!rows[j][18]) {
      // Untouched here: take what people type in the live sheet (details, PTP date, free-text status).
      // Current Outstanding / Settlement / Days / Status are recalculated here, so they are not copied back.
      [1, 2, 3, 4, 5, 7, 8].forEach(function (c) {
        if (L[c] < 0) return;
        var v = fromLive[c];
        if (c === 8 && !(v instanceof Date)) return;
        if (ccRowKey_([v]) !== ccRowKey_([rows[j][c]])) { rows[j][c] = v; refreshed++; }
      });
      var ls = ccStr_(fromLive[11]);
      if (ls && CC.STATUSES.indexOf(ls) < 0 && ls !== ccStr_(rows[j][11]) && String(rows[j][16]).indexOf(ls) < 0) { rows[j][11] = ls; refreshed++; }
    }
  }
  ccSyncRows_(sh, orig, rows);
  return 'PTP Tracker ' + rows.length + ' (+' + added + ')';
}

/** IO Sign-off <- live rate card. Links / remarks edited here (Updated By set) are kept. */
function ccMergeIo_(io) {
  var last = io.getLastRow();
  var vals = io.getRange(1, 1, last, 12).getValues();
  var sh = ccSheet_(CC.T.IO);
  var t = ccReadTable_(sh, CC_IO_COLS.length);
  var rows = t.rows.map(function (r) { return ccFit_(r, CC_IO_COLS.length); });
  var orig = rows.map(function (r) { return r.slice(); });
  var at = {};
  rows.forEach(function (r, i) { if (r[0]) at[String(r[0]).trim()] = i; });
  var n = 0;
  for (var i = 1; i < vals.length; i++) {
    var pan = ccStr_(vals[i][0]);
    if (!pan) continue;
    var j = at[pan];
    if (j === undefined) { rows.push(ccFit_(vals[i], CC_IO_COLS.length)); at[pan] = rows.length - 1; n++; continue; }
    var keepInputs = !!rows[j][13];
    for (var c = 0; c < 12; c++) if (!(keepInputs && c >= 8)) rows[j][c] = vals[i][c];
  }
  ccSyncRows_(sh, orig, rows);
  // Legacy per-associate summary block (pivot + manually typed monthly incentive) kept for reference.
  var legacy = io.getRange(1, 16, Math.min(last, 40), 7).getValues()
    .filter(function (r) { return r.some(function (v) { return v !== '' && v !== null; }); });
  var lw0 = sh.getMaxColumns() >= 22 ? sh.getRange(2, 16, legacy.length || 1, 7).getValues() : [];
  if (legacy.length && ccRowKey_(lw0.map(ccRowKey_)) !== ccRowKey_(legacy.map(ccRowKey_))) {
    var lw = 7;
    if (sh.getMaxColumns() < 16 + lw) sh.insertColumnsAfter(sh.getMaxColumns(), 16 + lw - sh.getMaxColumns());
    sh.getRange(1, 16, Math.max(sh.getLastRow(), legacy.length + 1), lw).clearContent();
    sh.getRange(1, 16).setValue('Legacy summary from the live sheet (for reference)').setFontWeight('bold');
    sh.getRange(2, 16, legacy.length, lw).setValues(legacy);
  }
  return 'IO Sign-off ' + rows.length + ' (+' + n + ')';
}

// ---------------------------------------------------------------------------
// Incremental writes
// ---------------------------------------------------------------------------

function ccRowKey_(r) {
  return JSON.stringify(r.map(function (v) { return v instanceof Date ? 'D' + v.getTime() : v === null || v === undefined ? '' : v; }));
}

/**
 * Write only what changed: `orig` is what the sheet holds from row 2 down, `rows` the wanted content with the
 * same rows in the same positions plus new rows at the end. Changed rows are rewritten one by one (many changes
 * -> one bulk write), new rows are appended. Returns the number of rows written.
 */
function ccSyncRows_(sh, orig, rows) {
  if (rows.length < orig.length) { ccWriteTable_(sh, rows, 2); ccMarkDirty_(); return rows.length; }
  var changed = [];
  for (var i = 0; i < orig.length; i++) if (ccRowKey_(orig[i]) !== ccRowKey_(rows[i])) changed.push(i);
  var extra = rows.slice(orig.length);
  if (!changed.length && !extra.length) return 0;
  ccMarkDirty_();
  var width = rows[0].length;
  if (changed.length > 200) {
    ccWriteTable_(sh, rows, 2);
    return rows.length;
  }
  changed.forEach(function (i) { sh.getRange(i + 2, 1, 1, width).setValues([rows[i]]); });
  if (extra.length) {
    var start = orig.length + 2;
    var need = start + extra.length - 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    sh.getRange(start, 1, extra.length, width).setValues(extra);
  }
  return changed.length + extra.length;
}

/** Something the PAN Master / Dashboard depend on changed -> the next rebuild must run. */
function ccMarkDirty_() { PropertiesService.getScriptProperties().setProperty('cc_dirty', '1'); }
