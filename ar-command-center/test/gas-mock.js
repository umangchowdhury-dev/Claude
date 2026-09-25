/*
 * In-memory mock of the Apps Script services used by src/*.gs, so the code runs in Node.
 * Two spreadsheets: the new one (active, starts empty) and the live one (openById).
 * Formatting / validation / protection calls are accepted and ignored.
 *
 * Run with TZ=Asia/Kolkata so JS Dates line up with the spreadsheet time zone.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const revive = (v) => (v && typeof v === 'object' && v.$d ? new Date(v.$d) : v === null || v === undefined ? '' : v);
const isBlank = (v) => v === '' || v === null || v === undefined;

/** Proxy that returns itself for any method not implemented (formatting & builders). */
function chain(target) {
  const p = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'then') return undefined;
      return () => p;
    }
  });
  return p;
}

class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); return chain(this); }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getSheet() { return this.sheet; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        line.push(v instanceof Date ? new Date(v.getTime()) : isBlank(v) ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getFormulas() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = (this.sheet.formulas || [])[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(src[this.col - 1 + c] || '');
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error(`setValues dims ${vals.length}x${vals[0].length} != ${this.nr}x${this.nc} on ${this.sheet.name}`);
    if (this.row + this.nr - 1 > this.sheet.maxRows) throw new Error(`Range beyond grid on ${this.sheet.name}: row ${this.row + this.nr - 1} > ${this.sheet.maxRows}`);
    if (this.col + this.nc - 1 > this.sheet.maxCols) throw new Error(`Range beyond grid on ${this.sheet.name}: col ${this.col + this.nc - 1} > ${this.sheet.maxCols}`);
    vals.forEach((line, r) => line.forEach((v, c) => {
      if (v === undefined) throw new Error(`undefined value written to ${this.sheet.name} r${this.row + r} c${this.col + c}`);
      this.sheet.set(this.row + r, this.col + c, v);
    }));
    this.sheet.writes += 1;
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    for (let r = 0; r < this.nr; r++) {
      const row = this.sheet.data[this.row - 1 + r];
      if (!row) continue;
      for (let c = 0; c < this.nc; c++) if (this.col - 1 + c < row.length) row[this.col - 1 + c] = '';
    }
    return this;
  }
  createTextFinder(text) {
    const self = this;
    let entire = false;
    const matches = () => {
      const res = [];
      for (let r = 0; r < self.nr; r++) for (let c = 0; c < self.nc; c++) {
        const v = (self.sheet.data[self.row - 1 + r] || [])[self.col - 1 + c];
        const s = isBlank(v) ? '' : String(v);
        if (entire ? s.toLowerCase() === text.toLowerCase() : s.toLowerCase().includes(text.toLowerCase())) res.push(new Range(self.sheet, self.row + r, self.col + c, 1, 1));
      }
      return res;
    };
    return { matchEntireCell(b) { entire = b; return this; }, findNext() { return matches()[0] || null; }, findAll() { return matches(); } };
  }
}

class Sheet {
  constructor(name, rows, hidden, formulas) {
    this.name = name; this.hidden = !!hidden; this.writes = 0; this.formulas = formulas;
    this.data = (rows || []).map((r) => r.map(revive));
    this.maxRows = Math.max(1000, this.data.length);
    this.maxCols = Math.max(26, ...this.data.map((r) => r.length), 1);
    this.active = { row: 1, col: 1 };
    this.protections = [];
    return chain(this);
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
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some((v) => !isBlank(v))) return r;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.data.forEach((row) => { for (let c = row.length; c > m; c--) if (!isBlank(row[c - 1])) { m = c; break; } });
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  deleteRows(start, n) { this.data.splice(start - 1, n); this.maxRows -= n; }
  deleteRow(r) { this.deleteRows(r, 1); }
  clear() { this.data = []; return this; }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') return new Range(this, 1, 1, 1, 1); // A1 notation: used only for formatting
    if (!(r >= 1) || !(c >= 1)) throw new Error(`Invalid range ${r},${c} on ${this.name}`);
    if (nr !== undefined && nr < 1) throw new Error(`The number of rows in the range must be at least 1 (got ${nr}) on ${this.name}`);
    if (nc !== undefined && nc < 1) throw new Error(`The number of columns in the range must be at least 1 (got ${nc}) on ${this.name}`);
    return new Range(this, r, c, nr || 1, nc || 1);
  }
  getActiveCell() { return new Range(this, this.active.row, this.active.col, 1, 1); }
  setActiveRange(rg) { this.active = { row: rg.row, col: rg.col }; return rg; }
  appendRow(vals) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r;
    vals.forEach((v, i) => this.set(r, i + 1, v));
    this.writes += 1;
  }
  getProtections() { return this.protections; }
  protect() { const p = chain({}); this.protections.push(p); return p; }
}

class Spreadsheet {
  constructor(fixture) {
    this.sheets = ((fixture && fixture.sheets) || []).map((s) => new Sheet(s.name, s.rows, s.hidden, s.formulas));
    if (!this.sheets.length) this.sheets.push(new Sheet('Sheet1', []));
    this.activeSheet = this.sheets[0];
    return chain(this);
  }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  getActiveSheet() { return this.activeSheet; }
  setActiveSheet(s) { this.activeSheet = s; return s; }
  moveActiveSheet(pos) { const i = this.sheets.indexOf(this.activeSheet); this.sheets.splice(i, 1); this.sheets.splice(pos - 1, 0, this.activeSheet); }
  deleteSheet(s) { this.sheets.splice(this.sheets.indexOf(s), 1); }
  setActive(name, row, col) { this.activeSheet = this.getSheetByName(name); this.activeSheet.active = { row, col: col || 1 }; }
  insertSheet(n) { const s = new Sheet(n, [], false); this.sheets.push(s); return s; }
  getSpreadsheetTimeZone() { return 'Asia/Kolkata'; }
}

function formatDate(d, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  switch (fmt) {
    case 'yyyy-MM-dd': return `${get('year')}-${get('month')}-${get('day')}`;
    case 'dd-MMM': return `${get('day')}-${MON[+get('month') - 1]}`;
    case 'dd-MMM-yy HH:mm': return `${get('day')}-${MON[+get('month') - 1]}-${get('year').slice(2)} ${get('hour')}:${get('minute')}`;
    default: throw new Error('formatDate fmt not mocked: ' + fmt);
  }
}

function store() {
  const m = new Map();
  return {
    getProperty: (k) => (m.has(k) ? m.get(k) : null), setProperty: (k, v) => { m.set(k, String(v)); },
    get: (k) => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { if (String(v).length > 100 * 1024) throw new Error('Argument too large'); m.set(k, String(v)); },
    remove: (k) => m.delete(k),
    deleteProperty: (k) => { m.delete(k); },
    getAll: (keys) => { const o = {}; keys.forEach((k) => { if (m.has(k)) o[k] = m.get(k); }); return o; },
    putAll: (o) => { Object.keys(o).forEach((k) => { if (String(o[k]).length > 100 * 1024) throw new Error('Argument too large: ' + k); m.set(k, String(o[k])); }); },
    _map: m
  };
}

function load(opts = {}) {
  const ss = new Spreadsheet(opts.fixture);
  const live = opts.live ? new Spreadsheet(opts.live) : null;
  const cache = store();
  const userProps = store();
  const scriptProps = store();
  const drafts = [];
  const triggers = [];
  const alerts = [];
  let email = opts.email === undefined ? 'associate@example.com' : opts.email;
  const builder = () => chain({ build: () => ({}) });
  const ctx = {
    console,
    Date,
    SpreadsheetApp: {
      getActive: () => ss,
      openById: (id) => { if (!live || id !== (opts.liveId || 'LIVE')) throw new Error('No spreadsheet ' + id); return live; },
      getUi: () => ({
        alert: (m) => alerts.push(m),
        prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => opts.promptAnswer || '' }),
        Button: { OK: 'OK' }, ButtonSet: { OK_CANCEL: 1 },
        showSidebar() {}, showModalDialog() {},
        createMenu: () => chain({})
      }),
      newDataValidation: builder,
      newConditionalFormatRule: builder,
      ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' }
    },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getUserProperties: () => userProps, getScriptProperties: () => scriptProps },
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    GmailApp: { createDraft: (to, subject, body, o) => { drafts.push({ to, subject, body, o }); return { getId: () => 'draft-' + drafts.length }; } },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t, _fn: t })),
      deleteTrigger: (t) => { const i = triggers.indexOf(t._fn); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => { const b = chain({ create: () => { triggers.push(fn); } }); return b; }
    },
    HtmlService: { createTemplateFromFile: () => chain({ evaluate: () => chain({}) }), createHtmlOutputFromFile: () => chain({ getContent: () => '' }) }
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'src');
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  });
  return { ctx, ss, live, cache, scriptProps, userProps, drafts, triggers, alerts, setEmail: (e) => { email = e; } };
}

/** google.script.run cannot return Dates - emulate that restriction. */
function assertSerializable(v, where = 'result') {
  if (v instanceof Date) throw new Error(`Date object in ${where} - google.script.run cannot return Dates`);
  if (typeof v === 'function') throw new Error(`function in ${where}`);
  if (v && typeof v === 'object') for (const k of Object.keys(v)) assertSerializable(v[k], `${where}.${k}`);
}

/** Read a tab as objects keyed by header row 1. */
function table(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const [hdr, ...rows] = sh.data;
  return rows.filter((r) => r && r.some((v) => !isBlank(v))).map((r) => Object.fromEntries(hdr.map((h, i) => [h, isBlank(r[i]) ? '' : r[i]])));
}

module.exports = { load, assertSerializable, table };
