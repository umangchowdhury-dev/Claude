/** Utilities shared by all files. */

function ccTz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }

/** Date -> 'yyyy-MM-dd' in the spreadsheet time zone ('' for non-dates). Strings pass through. */
function ccKey_(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, ccTz_(), 'yyyy-MM-dd');
}
function ccToday_() { return ccKey_(new Date()); }
/** 'yyyy-MM-dd' -> Date at local midnight (what Sheets shows as that date). */
function ccDate_(key) {
  if (!key) return '';
  var p = String(key).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function ccAddDays_(key, n) {
  var d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ccDiffDays_(a, b) {
  var t = function (k) { return Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); };
  return Math.round((t(b) - t(a)) / 86400000);
}
function ccDow_(key) { return new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))).getUTCDay(); }
function ccIsWorkday_(key, cfg) {
  var d = ccDow_(key);
  if (d === 0) return false;
  if (d === 6 && String((cfg || {}).WORK_WEEK || '').indexOf('Fri') >= 0) return false;
  return true;
}
function ccFmtDate_(key) {
  if (!key) return '';
  var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return key.slice(8, 10) + '-' + m[+key.slice(5, 7) - 1] + '-' + key.slice(2, 4);
}
/** "25th sep", "25 Sep", "25-sept" -> 'yyyy-MM-dd' in the given year ('' if not a date). */
function ccParseLooseDate_(s, year) {
  var m = /^\s*(\d{1,2})\s*(st|nd|rd|th)?[\s\-\/]*([a-z]{3})[a-z]*\.?\s*$/i.exec(s || '');
  if (!m) return '';
  var mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[3].toLowerCase());
  if (mon < 0 || +m[1] < 1 || +m[1] > 31) return '';
  return year + '-' + ('0' + (mon + 1)).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}
function ccNum_(v) { return typeof v === 'number' ? v : Number(String(v === null || v === undefined ? '' : v).replace(/,/g, '')) || 0; }
function ccStr_(v) { return v === null || v === undefined ? '' : (v instanceof Date ? ccKey_(v) : String(v)).trim(); }
function ccNorm_(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }
function ccInr_(n) {
  n = Number(n) || 0;
  var a = Math.abs(n);
  var s = a >= 1e7 ? (a / 1e7).toFixed(2) + ' Cr' : a >= 1e5 ? (a / 1e5).toFixed(2) + ' L' : Math.round(a).toLocaleString('en-IN');
  return (n < 0 ? '-' : '') + '₹' + s;
}
function ccInrFull_(n) {
  n = Math.round(Number(n) || 0);
  var s = String(Math.abs(n));
  var last3 = s.slice(-3);
  var rest = s.slice(0, -3);
  if (rest) last3 = ',' + last3;
  return (n < 0 ? '-' : '') + '₹' + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
}
function ccEsc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function ccUser_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function ccSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/**
 * Replace everything from `startRow` down with `rows` (2-D array), growing the grid when needed and
 * clearing leftovers from a longer previous version. Row 1..startRow-1 (headers) are untouched.
 */
function ccWriteTable_(sh, rows, startRow, startCol) {
  startRow = startRow || 2;
  startCol = startCol || 1;
  var width = rows.length ? rows[0].length : 0;
  var needRows = startRow + rows.length - 1;
  if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
  if (width && sh.getMaxColumns() < startCol + width - 1) sh.insertColumnsAfter(sh.getMaxColumns(), startCol + width - 1 - sh.getMaxColumns());
  var last = sh.getLastRow();
  var clearWidth = Math.max(width, 1);
  if (last >= startRow) sh.getRange(startRow, startCol, last - startRow + 1, clearWidth).clearContent();
  if (rows.length) sh.getRange(startRow, startCol, rows.length, width).setValues(rows);
}

/** Header row 1 + data -> {hdr, idx:{header->col0}, rows:[[...]]} */
function ccReadTable_(sh, width) {
  if (!sh || sh.getLastRow() < 1) return { hdr: [], idx: {}, rows: [] };
  var w = width || sh.getLastColumn();
  var all = sh.getRange(1, 1, sh.getLastRow(), Math.max(w, 1)).getValues();
  var hdr = all[0];
  var idx = {};
  hdr.forEach(function (h, i) { if (h !== '' && idx[h] === undefined) idx[h] = i; });
  return { hdr: hdr, idx: idx, rows: all.slice(1) };
}

/** Pad / trim a row to width. */
function ccFit_(row, width) {
  var r = row.slice(0, width);
  while (r.length < width) r.push('');
  return r;
}

function ccPanColIndex_() {
  var out = {};
  CC_PAN_COLS.forEach(function (c, i) { out[c.key] = i; });
  return out;
}
