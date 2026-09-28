/*
 * Synthetic workbook that mirrors the real "Associate Level Ageing Master - AR" layout (no real data):
 *   - associate tabs (header on row 2, daily follow-up date columns, "Remarks" alias on one tab)
 *   - Consolidated (PAN -> associate)
 *   - PTP Tracker (legacy 12 columns, free-text statuses like "25th sep")
 *   - Imported_Data (header on row 4)
 * Dates are relative to the current day so tests stay valid over time.
 */
'use strict';
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = key(new Date());
const day = (offset) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
const D = (offset) => ({ $d: `${key(day(offset))}T00:00:00` });
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const BUCKET_HEADERS = ['a.Not Due', 'b.0-30', 'c.31-60', 'd.61-90', 'e.91-120', 'f.121-150', 'g.>151'];
function bucketOf(age) {
  if (age <= 0) return 'a.Not Due';
  if (age <= 30) return 'b.0-30';
  if (age <= 60) return 'c.31-60';
  if (age <= 90) return 'd.61-90';
  if (age <= 120) return 'e.91-120';
  if (age <= 150) return 'f.121-150';
  return 'g.>151';
}

// Invoices: [pan, invNo, dueOffsetDays, net, brand, receipt, receiptDateOffset]
const INVOICES = [
  ['AAAPA1111A', 'INV-A1', -200, 50000, 'Alpha', 0, null],
  ['AAAPA1111A', 'INV-A2', -45, 20000, 'Alpha', 0, null],
  ['AAAPA1111A', 'INV-A3', 10, 5000, 'Alpha', 0, null],
  ['AAAPA1111A', 'INV-A0', -300, 0, 'Alpha', 9000, -250],   // settled
  ['BBBPB2222B', 'INV-B1', -70, 30000, 'Beta', 0, null],
  ['BBBPB2222B', 'INV-B2', -5, 0, 'Beta', 12000, -1],       // settled yesterday (had a PTP)
  ['CCCPC3333C', 'INV-C1', 15, 8000, 'Gamma', 0, null],     // only not-due
  ['DDDPD4444D', 'INV-D1', -95, 40000, 'Delta', 0, null],   // Ravi's
  ['DDDPD4444D', 'INV-D2', -20, 10000, 'Delta', 0, null],
  ['FFFPF6666F', 'INV-F1', -40, 15000, 'Foxtrot', 0, null]  // on no associate tab (unassigned)
];
const PANS = {
  AAAPA1111A: { cust: 'Alpha Foods Pvt Ltd', owner: 'Asha', exposure: 'Yes' },
  BBBPB2222B: { cust: 'Beta Beverages', owner: 'Asha', exposure: 'No' },
  CCCPC3333C: { cust: 'Gamma Snacks', owner: 'Asha', exposure: 'No' },
  EEEPE5555E: { cust: 'Zero Balance Co', owner: 'Asha', exposure: 'No' },
  DDDPD4444D: { cust: 'Delta Dairy', owner: 'Ravi', exposure: 'No' },
  FFFPF6666F: { cust: 'Foxtrot Foods', owner: '', exposure: 'No' }
};

function buildFixture() {
  // Imported_Data
  const invHdr = ['PAN #', 'Revised Activity month', 'Original Invoice Date', 'Invoice Date', 'Due Date', 'Credit Period', 'Invoice no',
    'Customer Name', 'KAM', 'KAM Manager', 'Associate', 'TDS Amount', 'Receipt', 'Receipt Date', 'AR AP adjustment', 'Net to be received',
    'Parent Brand', 'Brand', 'Ageing in Days', 'Ageing Bucket'];
  const invRows = [[], [], [], invHdr];
  INVOICES.forEach(([pan, no, due, net, brand, receipt, rd]) => {
    const age = -due;
    invRows.push([pan, "P.Aug'2026", D(due - 30), D(due - 30), D(due), 30, no, PANS[pan].cust, 'kam.one', 'kam.mgr', PANS[pan].owner,
      0, receipt, rd === null ? '' : D(rd), 0, net, brand, brand, age, bucketOf(age)]);
  });

  // Associate tabs
  const dates = [];
  for (let o = -20; o <= 10; o++) dates.push(D(o));
  const assocHdr = (remarksName) => ['PAN', 'Customer Name', 'Brand Names', 'Due Activity Months', 'KAM Managers', 'KAMs', 'Business Model',
    'Historically AR AP Done or not ?', 'Exposure/Defaulting PAN ?', 'POE Required ?', 'BU Head', 'Category Head 1', 'Category Head 2',
    'BizFin Spoc', 'IO Sign Off Incentive - If Applicable', ...BUCKET_HEADERS, 'Total Receivables', 'Total Overdue Receivables',
    'Net Payable Balance', 'Possible AR AP', '>60 days receivables', 'Possible AR AP > 60 days', remarksName, 'Team Lead Remarks',
    'Red', 'Yellow', 'Green', ...dates];
  const assocRow = (pan, dailyByOffset) => {
    const inv = INVOICES.filter((i) => i[0] === pan && i[3] !== 0);
    const b = BUCKET_HEADERS.map((h) => inv.filter((i) => bucketOf(-i[2]) === h).reduce((s, i) => s + i[3], 0));
    const total = b.reduce((s, x) => s + x, 0);
    const overdue = total - b[0];
    const gt60 = b[3] + b[4] + b[5] + b[6];
    const netPay = pan === 'BBBPB2222B' ? 25000 : 0;
    const model = pan === 'CCCPC3333C' ? 'Vendor Does not Exist' : 'OR';
    const row = [pan, PANS[pan].cust, 'Brand', "P.Aug'2026", 'kam.mgr', 'kam.one', model, 'No', PANS[pan].exposure, '', 'BU', 'Cat1', 'Cat2',
      'Fin', 'NA', ...b, total, overdue, netPay, netPay > 0 ? Math.min(overdue, netPay) : 0, gt60, netPay > 0 ? Math.min(gt60, netPay) : 0,
      'old remark', '', '', '', ''];
    dates.forEach((_, i) => row.push(dailyByOffset[i - 20] || ''));
    return row;
  };
  // Row 1 carries the SUBTOTAL totals; W1 (index 22) = Total Receivables of the visible rows.
  const totalRow = (w) => { const r = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'subtotal']; r[22] = w; return r; };
  // Tabs keep formula rows ready below the last PAN (PAN cell empty).
  const formulaRow = () => { const r = assocRow('AAAPA1111A', {}); r[0] = ''; r[1] = '#N/A'; for (let i = 15; i < 28; i++) r[i] = 0; r[28] = ''; return r; };
  const sheetAsha = [
    totalRow(113000),
    assocHdr('Associate Remarks'),
    assocRow('AAAPA1111A', { [-3]: 'Yes', [-1]: 'PTP' }),
    assocRow('BBBPB2222B', { [-10]: 'Yes' }),
    assocRow('CCCPC3333C', { [-1]: 'Invoice Not Due' }),
    assocRow('EEEPE5555E', {}),
    formulaRow(),
    formulaRow()
  ];
  const sheetRavi = [
    totalRow(40000), // a filter hides INV-D2's share: the Summary under-reports Ravi
    assocHdr('Remarks'), // Kaushal-style header variant
    assocRow('DDDPD4444D', { 0: 'Yes' }),
    formulaRow()
  ];

  // Consolidated
  const cons = [[], ['PAN', 'Customer Name', 'Associate Name']];
  Object.keys(PANS).forEach((p) => { if (PANS[p].owner) cons.push([p, PANS[p].cust, p === 'EEEPE5555E' ? 'Ravi' : PANS[p].owner]); });

  // IO Sign Off Rate Card (summary block on the right, as in the live sheet)
  const ioHdr = ['PAN', 'Customer Name', 'Avg. Invoicing Last 6M (Rs.)', 'Billing Band', 'AR-AP > 50%?', 'IO Sign-off Rate (Rs.)',
    "Associate Name - Aug'26", "Associate Name - Sept'26", 'IO Sign off Link', 'Remarks', 'Folder Link:', 'IO Signed Brand PDF'];
  const ioRow = (pan, rate, assoc, link, remarks) => [pan, PANS[pan].cust, '12,34,567', 'B5 - Top', 'No', rate, assoc, assoc, link || '', remarks || '', '', ''];
  const io = [ioHdr,
    ioRow('AAAPA1111A', 500, 'Asha', '', 'Sent to brand'),
    ioRow('BBBPB2222B', 300, 'Asha', 'https://drive.example/io-beta'),
    ioRow('DDDPD4444D', 200, 'Ravi', '')];
  io[1] = io[1].concat(['', '', '', '', '', '', 'Sign offs Done', 'Pending IO sign offs']);
  io[2] = io[2].concat(['', '', '', '', '', '', 1, 2]);

  // Payable Data - Daily: A:D one row per PAN, L:Q one row per vendor code
  const pay = [['PAN Number', 'PAN Name', 'Net Payable (INR)', 'Business Models', '', '', '', '', '', '', '', 'Vendor Code', 'Vendor Name', 'Business Model', 'Total Payable (INR)', 'Inventory Value - incl. Tax (INR)', 'PAN Number'],
    ['BBBPB2222B', 'BETA BEVERAGES', 25000, 'OR', '', '', '', '', '', '', '', 'KK-1', 'BETA BEVERAGES - BLR', 'OR', 15000, 0, 'BBBPB2222B'],
    ['CCCPC3333C', 'GAMMA SNACKS', 7000, 'SOR', '', '', '', '', '', '', '', 'KK-2', 'BETA BEVERAGES - DEL', 'OR', 20000, 500, 'BBBPB2222B'],
    ['', '', '', '', '', '', '', '', '', '', '', 'KK-3', 'GAMMA SNACKS', 'SOR', 7000, 0, 'CCCPC3333C']];

  // PTP Tracker (legacy layout, no PAN column)
  const now = new Date();
  const ptpHdr = ['Invoice No', 'Customer Name', 'Brand', 'Associate', 'Due Date', 'Outstanding When Added', 'Current Outstanding',
    'Added On', 'PTP Date', 'Settlement Date', 'Days vs PTP', 'Status'];
  const loose = `${now.getDate()}th ${MON[now.getMonth()]}`; // e.g. "25th sep" typed into Status
  const ptp = [ptpHdr,
    ['INV-A1', PANS.AAAPA1111A.cust, 'Alpha', 'Asha', D(-200), 50000, 50000, D(-1), '', '', '', 'PTP Pending'],
    ['INV-A2', PANS.AAAPA1111A.cust, 'Alpha', 'Asha', D(-45), 20000, 20000, D(-1), '', '', '', loose],
    ['INV-B1', PANS.BBBPB2222B.cust, 'Beta', 'Asha', D(-70), 30000, 30000, D(-5), D(-2), '', '', 'PTP Pending'],
    ['INV-B2', PANS.BBBPB2222B.cust, 'Beta', 'Asha', D(-5), 12000, 12000, D(-5), D(0), '', '', 'PTP Pending'],
    ['INV-D1', PANS.DDDPD4444D.cust, 'Delta', 'Ravi', D(-95), 40000, 40000, D(-1), '', '', '', 'PTP Pending']
  ];

  return {
    sheets: [
      { name: 'Summary', rows: [['Particulars']] },
      { name: 'Consolidated', rows: cons },
      { name: 'PTP Tracker', rows: ptp },
      { name: 'Asha', rows: sheetAsha },
      { name: 'Ravi', rows: sheetRavi },
      { name: 'IO Sign Off Rate Card', rows: io },
      { name: 'Imported_Data', rows: invRows },
      { name: 'Payable Data - Daily', rows: pay },
      { name: 'Hidden Helper', hidden: true, rows: [['x']] }
    ]
  };
}

module.exports = { buildFixture, key, day, TODAY };
