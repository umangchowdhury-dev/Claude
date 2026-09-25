/*
 * Minimal in-memory mock of the Apps Script services used by Code.gs, so the server code can be
 * exercised with Node. Load a workbook fixture ({sheets:[{name, hidden, rows:[[...]]}]}, dates as
 * {"$d":"yyyy-MM-ddTHH:mm:ss"} local time) and evaluate Code.gs inside a vm context.
 *
 * Run with TZ=Asia/Kolkata so JS Dates line up with the spreadsheet time zone.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function revive(v) {
  if (v && typeof v === 'object' && v.$d) return new Date(v.$d);
  return v === null || v === undefined ? '' : v;
}

class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        line.push(v instanceof Date ? new Date(v.getTime()) : (v === undefined || v === null ? '' : v));
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error(`setValues dims ${vals.length}x${vals[0].length} != ${this.nr}x${this.nc}`);
    vals.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    this.sheet.writes += 1;
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); this.sheet.writes += 1; return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  createTextFinder(text) {
    const self = this;
    let entire = false;
    const matches = () => {
      const res = [];
      for (let r = 0; r < self.nr; r++) for (let c = 0; c < self.nc; c++) {
        const v = (self.sheet.data[self.row - 1 + r] || [])[self.col - 1 + c];
        const s = v === undefined || v === null ? '' : String(v);
        if (entire ? s.toLowerCase() === text.toLowerCase() : s.toLowerCase().includes(text.toLowerCase())) {
          res.push(new Range(self.sheet, self.row + r, self.col + c, 1, 1));
        }
      }
      return res;
    };
    return {
      matchEntireCell(b) { entire = b; return this; },
      findNext() { return matches()[0] || null; },
      findAll() { return matches(); }
    };
  }
}

class Sheet {
  constructor(name, rows, hidden) {
    this.name = name; this.hidden = !!hidden; this.writes = 0;
    this.data = rows.map((r) => r.map(revive));
    this.active = { row: 1, col: 1 };
  }
  getName() { return this.name; }
  isSheetHidden() { return this.hidden; }
  set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.data.forEach((row) => { for (let c = row.length; c > m; c--) if (row[c - 1] !== '' && row[c - 1] !== undefined && row[c - 1] !== null) { m = c; break; } });
    return m;
  }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') throw new Error('A1 ranges not supported in mock');
    if (!(r >= 1) || !(c >= 1)) throw new Error(`Invalid range ${r},${c}`);
    if (nr !== undefined && nr < 1) throw new Error(`The number of rows in the range must be at least 1 (got ${nr})`);
    if (nc !== undefined && nc < 1) throw new Error(`The number of columns in the range must be at least 1 (got ${nc})`);
    return new Range(this, r, c, nr || 1, nc || 1);
  }
  getActiveCell() { return new Range(this, this.active.row, this.active.col, 1, 1); }
  setActiveRange(r) { this.active = { row: r.row, col: r.col }; return r; }
  appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, i) => this.set(r, i + 1, v)); this.writes += 1; }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor(fixture) {
    this.sheets = fixture.sheets.map((s) => new Sheet(s.name, s.rows, s.hidden));
    this.activeSheet = this.sheets[0];
  }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  getActiveSheet() { return this.activeSheet; }
  setActiveSheet(sh) { this.activeSheet = sh; return sh; }
  setActive(name, row, col) { this.activeSheet = this.getSheetByName(name); this.activeSheet.active = { row, col: col || 1 }; }
  insertSheet(n) { const s = new Sheet(n, [], false); this.sheets.push(s); return s; }
  getSpreadsheetTimeZone() { return 'Asia/Kolkata'; }
  toast() {}
}

function formatDate(d, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (fmt === 'yyyy-MM-dd') return `${get('year')}-${get('month')}-${get('day')}`;
  if (fmt === 'dd-MMM') return `${get('day')}-${MON[+get('month') - 1]}`;
  throw new Error('formatDate fmt not mocked: ' + fmt);
}

function load(fixture, opts = {}) {
  const ss = new Spreadsheet(fixture);
  const cache = new Map();
  const userProps = new Map();
  const drafts = [];
  const triggers = [];
  const ctx = {
    console,
    Date, // share the host Date so `instanceof Date` works for fixture values inside the sandbox
    SpreadsheetApp: {
      getActive: () => ss,
      getUi: () => ({ alert() {}, showSidebar() {}, showModalDialog() {}, createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { if (String(v).length > 100 * 1024) throw new Error('Argument too large'); cache.set(k, String(v)); },
        getAll: (keys) => { const o = {}; keys.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
        putAll: (o) => { Object.keys(o).forEach((k) => { if (String(o[k]).length > 100 * 1024) throw new Error('Argument too large: ' + k); cache.set(k, String(o[k])); }); }
      })
    },
    PropertiesService: { getUserProperties: () => ({ getProperty: (k) => (userProps.has(k) ? userProps.get(k) : null), setProperty: (k, v) => userProps.set(k, v) }) },
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate },
    Session: { getActiveUser: () => ({ getEmail: () => opts.email || 'associate@example.com' }) },
    GmailApp: { createDraft: (to, subject, body, o) => { drafts.push({ to, subject, body, o }); return { getId: () => 'draft-' + drafts.length }; } },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t })),
      newTrigger: (fn) => {
        const b = { forSpreadsheet() { return b; }, onOpen() { return b; }, timeBased() { return b; }, everyDays() { return b; }, everyHours() { return b; }, atHour() { return b; }, create() { triggers.push(fn); } };
        return b;
      }
    },
    HtmlService: {
      createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, setWidth() { return this; }, setHeight() { return this; } }) })
    }
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return { ctx, ss, cache, drafts, triggers };
}

/** Apps Script's google.script.run refuses Dates (and some other types) in return values - emulate that check. */
function assertSerializable(v, where = 'result') {
  if (v instanceof Date) throw new Error(`Date object in ${where} - google.script.run cannot return Dates`);
  if (typeof v === 'function') throw new Error(`function in ${where}`);
  if (v && typeof v === 'object') for (const k of Object.keys(v)) assertSerializable(v[k], `${where}.${k}`);
}

module.exports = { load, assertSerializable };
