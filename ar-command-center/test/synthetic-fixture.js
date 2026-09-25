/*
 * A small synthetic copy of the live "Associate Level Ageing Master - AR" workbook (no real data), laid out
 * exactly like the real one: Summary, Consolidated, PTP Tracker, associate tabs (header on row 2, Red/Yellow/Green,
 * daily date columns), Imported_Data (header on row 4), Payable Data - Daily, IO Sign Off Rate Card, mappings.
 * Dates are relative to today so the tests stay valid.
 */
'use strict';

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (offset) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
const D = (offset) => ({ $d: `${key(day(offset))}T00:00:00` });
const TODAY = key(new Date());
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const BUCKETS = ['a.Not Due', 'b.0-30', 'c.31-60', 'd.61-90', 'e.91-120', 'f.121-150', 'g.>151'];
const bucketOf = (a) => (a <= 0 ? BUCKETS[0] : a <= 30 ? BUCKETS[1] : a <= 60 ? BUCKETS[2] : a <= 90 ? BUCKETS[3] : a <= 120 ? BUCKETS[4] : a <= 150 ? BUCKETS[5] : BUCKETS[6]);

// [pan, invoice, dueOffset, net, brand, kam, receipt, receiptDateOffset]
const INVOICES = [
  ['AAAPA1111A', 'INV-A1', -200, 50000, 'Alpha', 'kam.one', 0, null],
  ['AAAPA1111A', 'INV-A2', -45, 20000, 'Alpha ', 'kam.two', 0, null],   // trailing space -> de-duplicated
  ['AAAPA1111A', 'INV-A3', 10, 5000, 'Alpha Kids', 'kam.one', 0, null],
  ['AAAPA1111A', 'INV-A0', -300, 0, 'Alpha', 'kam.one', 9000, -250],     // settled
  ['BBBPB2222B', 'INV-B1', -70, 30000, 'Beta', 'kam.one', 0, null],
  ['BBBPB2222B', 'INV-B2', -5, 0, 'Beta', 'kam.one', 12000, -1],         // settled yesterday, had a PTP
  ['CCCPC3333C', 'INV-C1', 15, 8000, 'Gamma', 'kam.one', 0, null],       // only not due
  ['DDDPD4444D', 'INV-D1', -95, 40000, 'Delta', 'kam.three', 0, null],   // Ravi (shown as "Legal" in Summary)
  ['DDDPD4444D', 'INV-D2', -20, 10000, 'Delta', 'kam.three', 0, null],
  ['FFFPF6666F', 'INV-F1', -10, 7000, 'Orphan', 'kam.one', 0, null]      // PAN on no tab -> Unassigned
];
const PANS = {
  AAAPA1111A: { cust: 'Alpha Foods Pvt Ltd', owner: 'Asha', expo: true },
  BBBPB2222B: { cust: 'Beta Beverages', owner: 'Asha' },
  CCCPC3333C: { cust: 'Gamma Snacks', owner: 'Asha' },
  EEEPE5555E: { cust: 'Zero Balance Co', owner: 'Asha' },
  DDDPD4444D: { cust: 'Delta Dairy', owner: 'Ravi', hist: true },
  FFFPF6666F: { cust: 'Orphan Traders', owner: '' }
};

function buildLive() {
  const invHdr = ['PAN #', 'Revised Activity month', 'Original Invoice Date', 'Invoice Date', 'Due Date', 'Credit Period', 'Invoice no',
    'Customer Name', 'KAM', 'KAM Manager', 'Associate', 'TDS Amount', 'Receipt', 'Receipt Date', 'AR AP adjustment', 'Net to be received',
    'Parent Brand', 'Brand', 'Ageing in Days', 'Ageing Bucket', 'Brand Name as per Mapping Sheet', 'BU Head',
    'Corrected Brand Manager (L2)\n \n [Primary Relationship Owner with Brand]', 'Corrected Brand Manager (L1)\n \n [Primary Relationship Owner with Brand]', 'BizFin SPOC'];
  const imp = [[], [], ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 999], invHdr];
  INVOICES.forEach(([pan, no, due, net, brand, kam, receipt, rd]) => {
    const age = -due;
    imp.push([pan, net ? "P.Aug'2026" : "O.Jul'2026", D(due - 30), D(due - 30), D(due), 30, no, PANS[pan].cust, kam, 'mgr.one', PANS[pan].owner || 'Prepaid',
      0, receipt, rd === null ? '' : D(rd), 0, net, brand, brand, age, net ? bucketOf(age) : bucketOf(age), brand.trim(),
      'BU Boss, Other Boss', 'Cat Lead', 'Cat L1', 'Fin Spoc']);
  });

  const dates = [];
  for (let o = -20; o <= 10; o++) dates.push(D(o));
  const hdr = (remarks) => ['PAN', 'Customer Name', 'Brand Names', 'Due Activity Months', 'KAM Managers', 'KAMs', 'Business Model',
    'Historically AR AP Done or not ?', 'Exposure/Defaulting PAN ?', 'POE Required ?', 'BU Head', 'Category Head 1', 'Category Head 2', 'BizFin Spoc',
    'IO Sign Off Incentive - If Applicable', ...BUCKETS, 'Total Receivables', 'Total Overdue Receivables', 'Net Payable Balance', 'Possible AR AP',
    '>60 days receivables', 'Possible AR AP > 60 days', remarks, 'Team Lead Remarks', 'Red', 'Yellow', 'Green', ...dates];
  const row = (pan, o) => {
    const r = [pan, PANS[pan].cust, '', '', '', '', '', '', '', o.poe || '', '', '', '', '', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      o.remarks || '', o.tl || '', o.red || '', o.yellow || '', o.green || ''];
    dates.forEach((_, i) => r.push((o.daily || {})[i - 20] || ''));
    return r;
  };
  const asha = [[], hdr('Associate Remarks'),
    row('AAAPA1111A', { remarks: 'waiting for update', tl: 'push hard', red: 30000, green: 40000, poe: 'Yes', daily: { [-3]: 'Yes', [-1]: 'PTP' } }),
    row('BBBPB2222B', { daily: { [-10]: 'Yes' } }),
    row('CCCPC3333C', { daily: { [-1]: 'Invoice Not Due' } }),
    row('EEEPE5555E', {})];
  const ravi = [[], hdr('Remarks'), row('DDDPD4444D', { remarks: 'legal notice sent', yellow: 50000, daily: { [-2]: 'Yes' } })];

  const cons = [[], ['PAN', 'Customer Name', 'Associate Name']];
  Object.keys(PANS).forEach((p) => { if (PANS[p].owner) cons.push([p, PANS[p].cust, PANS[p].owner]); });

  const now = new Date();
  const loose = `${now.getDate()}th ${MON[now.getMonth()]}`;
  const ptp = [['Invoice No', 'Customer Name', 'Brand', 'Associate', 'Due Date', 'Outstanding When Added', 'Current Outstanding', 'Added On', 'PTP Date', 'Settlement Date', 'Days vs PTP', 'Status'],
    ['INV-A1', PANS.AAAPA1111A.cust, 'Alpha', 'Asha', D(-200), 50000, 50000, D(-1), '', '', '', 'PTP Pending'],
    ['INV-A2', PANS.AAAPA1111A.cust, 'Alpha', 'Asha', D(-45), 20000, 20000, D(-1), '', '', '', loose],
    ['INV-B1', PANS.BBBPB2222B.cust, 'Beta', 'Asha', D(-70), 30000, 30000, D(-5), D(-2), '', '', 'PTP Pending'],
    ['INV-B2', PANS.BBBPB2222B.cust, 'Beta', 'Asha', D(-5), 12000, 12000, D(-5), D(0), '', '', 'PTP Pending']];

  const pay = [['PAN Number', 'PAN Name', 'Net Payable (INR)', 'Business Models', '', '', '', '', '', '', '', 'Vendor Code', 'Vendor Name', 'Business Model', 'Total Payable (INR)', 'Inventory Value - incl. Tax (INR)', 'PAN Number'],
    ['BBBPB2222B', 'Beta Beverages', 25000, 'OR', '', '', '', '', '', '', '', 'V-1', 'Beta', 'OR', 25000, 0, 'BBBPB2222B'],
    ['AAAPA1111A', 'Alpha Foods', 100000, 'SOR', '', '', '', '', '', '', '', 'V-2', 'Alpha', 'SOR', 100000, 0, 'AAAPA1111A']];

  const io = [['PAN', 'Customer Name', 'Avg. Invoicing Last 6M (Rs.)', 'Billing Band', 'AR-AP > 50%?', 'IO Sign-off Rate (Rs.)', "Associate Name - Aug'26", "Associate Name - Sept'26", 'IO Sign off Link', 'Remarks', 'Folder Link:', 'IO Signed Brand PDF'],
    ['AAAPA1111A', 'Alpha Foods', '1,00,000', 'B3', 'No', 500, 'Asha', 'Asha', 'https://drive/io-alpha', '', '', ''],
    ['BBBPB2222B', 'Beta Beverages', '50,000', 'B2', 'No', 300, 'Asha', 'Asha', '', 'Agency', '', ''],
    ['DDDPD4444D', 'Delta Dairy', '10,000', 'B1', 'No', 0, 'Ravi', 'Ravi', '', '', '', '']];

  const summary = [['Particulars', 'Total Accounts'], ['Asha', 4], ['Legal', 1], ['Total', 5]];
  const summaryF = [['', ''], ['', '=COUNTA(Asha!A3:A500)'], ['', '=COUNTA(Ravi!A3:A490)'], ['', '=COUNTA(Consolidated!A3:A5897)']];

  return {
    sheets: [
      { name: 'Summary', rows: summary, formulas: summaryF },
      { name: 'Consolidated', rows: cons },
      { name: 'PTP Tracker', rows: ptp },
      { name: 'Asha', rows: asha },
      { name: 'Ravi', rows: ravi },
      { name: 'IO Sign Off Rate Card', rows: io },
      { name: 'Imported_Data', rows: imp },
      { name: 'Category Mapping', rows: [['Brand', 'BU', 'Super Category', 'Category', 'Subcategory', 'BU Head', 'L2', 'L1', 'BizFin SPOC'], ['Alpha', 'Food', 'Food', 'Snacks', 'Chips', 'BU Boss', 'Cat Lead', 'Cat L1', 'Fin Spoc']] },
      { name: 'Payable Data - Daily', rows: pay },
      { name: 'Brand Name Mapping for vlookup', hidden: true, rows: [['Brand (Sheet 1)', 'Matched Brand (Sheet 2)', 'Match Type', 'Confidence'], ['Alpha', 'Alpha', 'Exact match', 100]] },
      { name: 'ExposureDefaulting PANs', hidden: true, rows: [['PANs'], ['AAAPA1111A']] },
      { name: 'Historically AR AP Done PANs', hidden: true, rows: [['PANs'], ['DDDPD4444D']] }
    ]
  };
}

module.exports = { buildLive, key, day, D, TODAY };
