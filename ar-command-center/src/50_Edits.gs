/**
 * Writes shared by the grid (onEdit) and the workbench, so both paths behave identically:
 *   ccSetInputs_      PAN Inputs + patch the PAN Master row
 *   ccSetFollowUp_    Follow-ups upsert (+ PAN Master today / last follow-up)
 *   ccLog_            Activity Log
 */

function onEdit(e) {
  try { ccHandleEdit_(e); } catch (err) { console.error(err && err.stack ? err.stack : err); }
}

function ccHandleEdit_(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  var name = sh.getName();
  var r0 = e.range.getRow();
  var c0 = e.range.getColumn();
  var nr = e.range.getNumRows();
  var nc = e.range.getNumColumns();
  if (r0 + nr - 1 < 2) return;
  var user = ccUser_();

  if (name === CC.T.PAN) {
    var H = ccPanColIndex_();
    var inputCols = {};
    CC_PAN_COLS.forEach(function (c, i) { if (c.input) inputCols[i + 1] = c.key; });
    var from = Math.max(r0, 2);
    var n = r0 + nr - from;
    var vals = sh.getRange(from, 1, n, CC_PAN_COLS.length).getValues();
    vals.forEach(function (row) {
      var pan = ccStr_(row[0]);
      if (!pan) return;
      var fields = {};
      var status = null;
      for (var c = c0; c < c0 + nc; c++) {
        var key = inputCols[c];
        if (!key) continue;
        var v = row[c - 1];
        if (key === 'todayStatus') status = ccStr_(v);
        else fields[key] = v instanceof Date ? ccKey_(v) : v;
      }
      var owner = fields.owner !== undefined ? ccStr_(fields.owner) : ccStr_(row[H.owner]);
      if (Object.keys(fields).length) ccSetInputs_(pan, fields, user, { skipPanMaster: false });
      if (status !== null) ccSetFollowUp_(ccToday_(), pan, owner, status, 'Sheet', user, true);
      if (Object.keys(fields).length || status !== null) {
        ccLog_({ assoc: owner, pan: pan, customer: ccStr_(row[H.customer]), type: 'Edit',
          outcome: Object.keys(fields).concat(status !== null ? ['todayStatus'] : []).join(', ') + ' updated in PAN Master',
          remarks: fields.remarks || fields.tlRemarks || status || '' });
      }
    });
    return;
  }

  if (name === CC.T.PTP) {
    var editable = { 9: 1, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1 };
    var touched = false;
    for (var c2 = c0; c2 < c0 + nc; c2++) if (editable[c2]) touched = true;
    if (!touched) return;
    var from2 = Math.max(r0, 2);
    var rng = sh.getRange(from2, 1, r0 + nr - from2, CC_PTP_COLS.length);
    var rows = rng.getValues();
    var today = ccToday_();
    rows.forEach(function (row) {
      if (!row[0]) return;
      var ptpKey = row[8] instanceof Date ? ccKey_(row[8]) : '';
      var settle = row[9] instanceof Date ? ccKey_(row[9]) : '';
      row[11] = ccPtpStatus_(ptpKey, row[6], row[5], settle, today);
      row[10] = ptpKey && ptpKey <= today ? ccDiffDays_(ptpKey, settle || today) : '';
      row[18] = user || 'sheet edit';
      row[19] = new Date();
    });
    rng.setValues(rows);
    return;
  }

  if (name === CC.T.IO) {
    var from3 = Math.max(r0, 2);
    var rng3 = sh.getRange(from3, 1, r0 + nr - from3, CC_IO_COLS.length);
    var rows3 = rng3.getValues();
    rows3.forEach(function (row) {
      if (!row[0]) return;
      if (row[8] && !(row[12] instanceof Date)) row[12] = ccDate_(ccToday_());
      row[13] = user || 'sheet edit';
    });
    rng3.setValues(rows3);
    return;
  }

  if (name === CC.T.FU) {
    var from4 = Math.max(r0, 2);
    var rng4 = sh.getRange(from4, 5, r0 + nr - from4, 3);
    rng4.setValues(rng4.getValues().map(function () { return ['Sheet', user, new Date()]; }));
  }
}

// ---------------------------------------------------------------------------

/** fields: any of owner, redAmt, amberAmt, greenAmt, poe, nextFu ('yyyy-MM-dd'), remarks, tlRemarks */
function ccSetInputs_(pan, fields, user, opts) {
  opts = opts || {};
  var sh = ccSheet_(CC.T.INPUTS);
  var col = CC_IN;
  var f = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findNext() : null;
  var rowNo;
  var row;
  if (f) {
    rowNo = f.getRow();
    row = sh.getRange(rowNo, 1, 1, CC_INPUT_COLS.length).getValues()[0];
  } else {
    rowNo = Math.max(sh.getLastRow(), 1) + 1;
    if (sh.getMaxRows() < rowNo) sh.insertRowsAfter(sh.getMaxRows(), rowNo - sh.getMaxRows());
    row = ccFit_([pan], CC_INPUT_COLS.length);
  }
  Object.keys(fields).forEach(function (k) {
    if (col[k] === undefined || k === 'pan' || k.charAt(0) === 'l') return;
    var v = fields[k];
    if (k === 'nextFu') v = v ? ccDate_(ccKey_(v)) : '';
    row[col[k]] = v === null || v === undefined ? '' : v;
  });
  var now = new Date();
  row[CC_IN.by] = user || '';
  row[CC_IN.on] = now;
  sh.getRange(rowNo, 1, 1, CC_INPUT_COLS.length).setValues([row]);
  if (!opts.skipPanMaster) {
    var patch = {};
    Object.keys(fields).forEach(function (k) {
      patch[k] = k === 'nextFu' ? (fields[k] ? ccDate_(ccKey_(fields[k])) : '') : fields[k];
    });
    if (fields.redAmt !== undefined || fields.amberAmt !== undefined || fields.greenAmt !== undefined) {
      var cur = ccPanRowObj_(pan) || {};
      ['redAmt', 'amberAmt', 'greenAmt'].forEach(function (k) { if (fields[k] === undefined) patch[k] = cur[k]; });
      patch.confidence = ccConfidenceOf_(patch);
    }
    patch.updatedBy = user || '';
    patch.updatedOn = now;
    ccPatchPanMaster_(pan, patch);
  }
  return true;
}

/** One PAN Master row as {key: value} (null when not found). */
function ccPanRowObj_(pan) {
  var sh = SpreadsheetApp.getActive().getSheetByName(CC.T.PAN);
  if (!sh || sh.getLastRow() < 2) return null;
  var f = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (!f) return null;
  var v = sh.getRange(f.getRow(), 1, 1, CC_PAN_COLS.length).getValues()[0];
  var o = {};
  CC_PAN_COLS.forEach(function (c, i) { o[c.key] = v[i]; });
  return o;
}

/** Update some PAN Master cells for one PAN in place (no rebuild). */
function ccPatchPanMaster_(pan, patch) {
  var sh = SpreadsheetApp.getActive().getSheetByName(CC.T.PAN);
  if (!sh || sh.getLastRow() < 2) return false;
  var f = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findNext();
  if (!f) return false;
  var H = ccPanColIndex_();
  var rng = sh.getRange(f.getRow(), 1, 1, CC_PAN_COLS.length);
  var row = rng.getValues()[0];
  Object.keys(patch).forEach(function (k) { if (H[k] !== undefined) row[H[k]] = patch[k] === undefined || patch[k] === null ? '' : patch[k]; });
  rng.setValues([row]);
  return true;
}

var CC_STATUS_RANK = { '': 0, 'No': 0, 'Invoice Not Due': 1, 'Yes': 2, 'Expected Payment': 3, 'PTP': 4, 'Leave': 5, 'Holiday': 5 };

/**
 * Upsert the follow-up for (date, PAN). A richer status (PTP) is not downgraded to Yes the same day unless
 * `force` (a person explicitly chose it in the grid). Empty status deletes the entry.
 */
function ccSetFollowUp_(dateKey, pan, assoc, status, source, user, force) {
  if (status && CC.DAILY_VALUES.indexOf(status) < 0) throw new Error('Invalid status ' + status);
  var sh = ccSheet_(CC.T.FU);
  var rowNo = 0;
  var cur = '';
  if (sh.getLastRow() >= 2) {
    var cells = sh.getRange(2, 2, sh.getLastRow() - 1, 1).createTextFinder(pan).matchEntireCell(true).findAll();
    for (var i = cells.length - 1; i >= 0; i--) {
      var r = cells[i].getRow();
      if (ccKey_(sh.getRange(r, 1).getValue()) === dateKey) { rowNo = r; cur = ccStr_(sh.getRange(r, 4).getValue()); break; }
    }
  }
  var now = new Date();
  if (!status) {
    if (rowNo) sh.deleteRow(rowNo);
  } else if (rowNo) {
    if (force || (CC_STATUS_RANK[status] || 0) >= (CC_STATUS_RANK[cur] || 0)) {
      sh.getRange(rowNo, 3, 1, 5).setValues([[assoc, status, source, user || '', now]]);
    } else {
      status = cur;
    }
  } else {
    ccAppendRows_(sh, [[ccDate_(dateKey), pan, assoc, status, source, user || '', now]]);
  }
  if (dateKey === ccToday_()) {
    var patch = { todayStatus: status };
    if (ccTouched_(status)) { patch.lastTouch = ccDate_(dateKey); patch.daysSince = 0; }
    ccPatchPanMaster_(pan, patch);
  }
  return status;
}

function ccLog_(e) {
  var sh = ccSheet_(CC.T.LOG);
  var now = new Date();
  ccAppendRows_(sh, [[now, ccDate_(ccKey_(now)), e.assoc || '', e.pan || '', e.customer || '', e.type || '', e.outcome || '',
    e.invoices || '', e.amount || '', e.next ? ccDate_(e.next) : '', e.remarks || '', ccUser_()]]);
}

function ccReadLog_(ss) {
  var sh = (ss || SpreadsheetApp.getActive()).getSheetByName(CC.T.LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, CC_LOG_COLS.length).getValues().map(function (r) {
    return {
      ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), date: r[1] instanceof Date ? ccKey_(r[1]) : '',
      assoc: String(r[2]), pan: String(r[3]), customer: String(r[4]), type: String(r[5]), outcome: String(r[6]),
      invoices: String(r[7]), amount: r[8], next: r[9] instanceof Date ? ccKey_(r[9]) : '', remarks: String(r[10]),
      user: String(r[11])
    };
  });
}
