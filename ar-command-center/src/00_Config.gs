/**
 * AR Command Center - one Google Sheet for associates, team leads and management.
 *
 * TEST mode : this sheet pulls everything from the current live tracker (read-only) every N minutes,
 *             rebuilds it into a simpler model and lets you try the new workflow without touching the
 *             live sheet.
 * LIVE mode : this sheet becomes the tracker. Only the raw data (invoices, payables, mappings) keeps
 *             coming from the source sheet; remarks / follow-ups / PTPs are entered here.
 *
 * Tabs (in order):
 *   Home, Dashboard, PAN Master, PTP Tracker, Follow-ups, Activity Log, IO Sign-off, Snapshots, Team, Config,
 *   then data tabs: Invoices, Payables, Map: Category, Map: Brand, List: Exposure PANs,
 *   List: Historic AR-AP PANs, PAN Inputs, Sync Log.
 */

var CC = {
  T: {
    HOME: 'Home', DASH: 'Dashboard', PAN: 'PAN Master', PTP: 'PTP Tracker', FU: 'Follow-ups',
    LOG: 'Activity Log', IO: 'IO Sign-off', SNAP: 'Snapshots', TEAM: 'Team', CONFIG: 'Config',
    INV: 'Invoices', PAY: 'Payables', CAT: 'Map: Category', BRAND: 'Map: Brand',
    EXPO: 'List: Exposure PANs', HIST: 'List: Historic AR-AP PANs', INPUTS: 'PAN Inputs', SYNC: 'Sync Log'
  },
  // Names of the tabs in the live (old) tracker.
  LIVE: {
    INV: 'Imported_Data', PAY: 'Payable Data - Daily', CAT: 'Category Mapping', BRAND: 'Brand Name Mapping for vlookup',
    EXPO: 'ExposureDefaulting PANs', HIST: 'Historically AR AP Done PANs', IO: 'IO Sign Off Rate Card',
    CONS: 'Consolidated', PTP: 'PTP Tracker'
  },
  DAILY_VALUES: ['Yes', 'No', 'Leave', 'Holiday', 'Invoice Not Due', 'PTP', 'Expected Payment'],
  CONFIDENCE: ['Red', 'Amber', 'Green'],
  INVOICE_TAGS: ['', 'Disputed', 'AR-AP Proposed', 'AR-AP Approved', 'Expected Payment', 'Awaiting POE',
    'Awaiting Reco / Remittance', 'Credit Note Requested', 'Escalated to KAM', 'Legal'],
  ROLES: ['Associate', 'Team Lead', 'Management', 'Admin'],
  BUCKETS: ['a.Not Due', 'b.0-30', 'c.31-60', 'd.61-90', 'e.91-120', 'f.121-150', 'g.>151'],
  STATUSES: ['PTP Pending', 'PTP Given', 'PTP Due Today', 'PTP Broken', 'Partially Paid', 'Paid',
    'Paid (PTP Kept)', 'Paid (after PTP)'],
  CACHE_PREFIX: 'cc_open_v1_',
  CACHE_TTL: 21600,
  INR_FORMAT: '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0',
  COLORS: { head: '#1f3864', headFont: '#ffffff', input: '#fff2cc', inputHead: '#bf9000', data: '#eeeeee', note: '#5f6368' }
};

/** Config keys with defaults and help text (rendered on the Config tab). */
var CC_CONFIG_DEFAULTS = [
  ['MODE', 'TEST', 'TEST = pull remarks / follow-ups / PTPs from the live sheet as well. LIVE = this sheet is the tracker; only raw data is pulled.'],
  ['LIVE_SHEET_ID', '', 'ID of the current live tracker (the long code in its URL between /d/ and /edit). Read-only access is enough.'],
  ['RAW_DATA_SHEET_ID', '', 'Where Imported_Data / Payables / mappings come from. Blank = same as LIVE_SHEET_ID. Use THIS to maintain them directly in this sheet.'],
  ['SYNC_EVERY_MINUTES', '30', 'How often to pull (1, 5, 10, 15 or 30). Re-run Setup after changing.'],
  ['FOLLOWUP_START', '2026-08-01', 'First date shown in the daily follow-up grid on the Dashboard.'],
  ['STALE_DAYS', '3', 'A PAN with overdue and no follow-up for this many days is flagged "not followed up".'],
  ['WORK_WEEK', 'Mon-Sat', 'Mon-Sat or Mon-Fri. Sundays (and Saturdays for Mon-Fri) are excluded from moving averages.'],
  ['RESTRICT_VIEWS', 'No', 'Yes = associates can only open their own PANs in the workbench; team leads their team.'],
  ['AUTO_NOT_DUE', 'Yes', 'Daily job marks "Invoice Not Due" for PANs with nothing overdue (only blank cells).'],
  ['ADD_OVERDUE_TO_PTP', 'Yes', 'Daily job adds newly overdue open invoices to PTP Tracker as "PTP Pending".'],
  ['EMAIL_SIGNATURE', 'Accounts Receivable', 'Signature line for reminder e-mail drafts.']
];

/**
 * PAN Master columns. key = field name used in code; input = editable (yellow), captured by onEdit into PAN Inputs.
 */
var CC_PAN_COLS = [
  // Identity & relationship
  { key: 'pan', h: 'PAN', w: 100 },
  { key: 'customer', h: 'Customer Name', w: 220 },
  { key: 'owner', h: 'Associate', w: 95, input: true },
  { key: 'teamLead', h: 'Team Lead', w: 95 },
  { key: 'group', h: 'Group', w: 70 },
  { key: 'brands', h: 'Brand Names', w: 180 },
  { key: 'months', h: 'Due Activity Months', w: 150 },
  { key: 'kamMgr', h: 'KAM Managers', w: 140 },
  { key: 'kams', h: 'KAMs', w: 140 },
  { key: 'bizModel', h: 'Business Model', w: 110 },
  { key: 'arApHist', h: 'Historically AR AP Done?', w: 80 },
  { key: 'exposure', h: 'Exposure / Defaulting PAN?', w: 80 },
  { key: 'buHead', h: 'BU Head', w: 140 },
  { key: 'cat1', h: 'Category Head 1 (L2)', w: 140 },
  { key: 'cat2', h: 'Category Head 2 (L1)', w: 140 },
  { key: 'bizfin', h: 'BizFin SPOC', w: 140 },
  { key: 'ioRate', h: 'IO Sign Off Incentive', w: 80 },
  { key: 'ioDone', h: 'IO Signed?', w: 70 },
  // Money
  { key: 'b0', h: 'a.Not Due', w: 95, money: true },
  { key: 'b1', h: 'b.0-30', w: 95, money: true },
  { key: 'b2', h: 'c.31-60', w: 95, money: true },
  { key: 'b3', h: 'd.61-90', w: 95, money: true },
  { key: 'b4', h: 'e.91-120', w: 95, money: true },
  { key: 'b5', h: 'f.121-150', w: 95, money: true },
  { key: 'b6', h: 'g.>151', w: 95, money: true },
  { key: 'total', h: 'Total Receivables', w: 105, money: true },
  { key: 'overdue', h: 'Total Overdue Receivables', w: 105, money: true },
  { key: 'gt60', h: '>60 days receivables', w: 105, money: true },
  { key: 'netPayable', h: 'Net Payable Balance', w: 105, money: true },
  { key: 'possibleArAp', h: 'Possible AR AP', w: 105, money: true },
  { key: 'possibleArApTotal', h: 'Possible AR AP (on total)', w: 105, money: true },
  { key: 'possibleArAp60', h: 'Possible AR AP > 60 days', w: 105, money: true },
  { key: 'openInv', h: 'Open Invoices', w: 70 },
  { key: 'oldest', h: 'Oldest (days)', w: 70 },
  // PTP & follow-up (computed)
  { key: 'ptpOpen', h: 'Open PTPs', w: 70 },
  { key: 'ptpAmt', h: 'PTP Amount', w: 100, money: true },
  { key: 'ptpNext', h: 'Next PTP', w: 90, date: true },
  { key: 'ptpBroken', h: 'Broken PTPs', w: 70 },
  { key: 'lastTouch', h: 'Last Follow-up', w: 90, date: true },
  { key: 'daysSince', h: 'Days Since F/U', w: 70 },
  { key: 'last7', h: 'Last 7 Days', w: 110 },
  { key: 'fuMtd', h: 'Follow-ups MTD', w: 70 },
  { key: 'priority', h: 'Priority', w: 60 },
  // Inputs (yellow)
  { key: 'todayStatus', h: "Today's Status", w: 110, input: true, list: 'DAILY' },
  { key: 'redAmt', h: 'Red', w: 95, input: true, money: true },
  { key: 'amberAmt', h: 'Amber (Yellow)', w: 95, input: true, money: true },
  { key: 'greenAmt', h: 'Green', w: 95, input: true, money: true },
  { key: 'confidence', h: 'Collection Confidence', w: 90 },
  { key: 'poe', h: 'POE Required?', w: 70, input: true, list: 'YESNO' },
  { key: 'nextFu', h: 'Next Follow-up', w: 95, input: true, date: true },
  { key: 'remarks', h: 'Associate Remarks', w: 260, input: true },
  { key: 'tlRemarks', h: 'Team Lead Remarks', w: 220, input: true },
  { key: 'updatedBy', h: 'Last Updated By', w: 150 },
  { key: 'updatedOn', h: 'Last Updated On', w: 120, datetime: true }
];

var CC_INPUT_COLS = ['PAN', 'Owner', 'Red', 'Amber', 'Green', 'POE Required', 'Next Follow-up',
  'Associate Remarks', 'Team Lead Remarks', 'Updated By', 'Updated On',
  'Live Owner', 'Live Remarks', 'Live TL Remarks', 'Live POE', 'Live Red', 'Live Amber', 'Live Green'];
/** Column index (0-based) of each field in PAN Inputs. */
var CC_IN = { pan: 0, owner: 1, redAmt: 2, amberAmt: 3, greenAmt: 4, poe: 5, nextFu: 6, remarks: 7, tlRemarks: 8, by: 9, on: 10,
  lOwner: 11, lRemarks: 12, lTl: 13, lPoe: 14, lRed: 15, lAmber: 16, lGreen: 17 };

var CC_FU_COLS = ['Date', 'PAN', 'Associate', 'Status', 'Source', 'Updated By', 'Updated On'];

var CC_LOG_COLS = ['Timestamp', 'Date', 'Associate', 'PAN', 'Customer', 'Type', 'Outcome', 'Invoices', 'Amount',
  'Next Follow-up', 'Remarks', 'User'];

var CC_PTP_COLS = ['Invoice No', 'Customer Name', 'Brand', 'Associate', 'Due Date', 'Outstanding When Added',
  'Current Outstanding', 'Added On', 'PTP Date', 'Settlement Date', 'Days vs PTP', 'Status',
  'PAN', 'PTP Amount', 'Payment Mode', 'Contact Person', 'PTP Remarks', 'Invoice Tag', 'Updated By', 'Updated On'];

var CC_TEAM_COLS = ['Name', 'Role', 'Team Lead', 'Group', 'Email', 'Active', 'Live Tab Name', 'Notes'];

var CC_IO_COLS = ['PAN', 'Customer Name', 'Avg. Invoicing Last 6M (Rs.)', 'Billing Band', 'AR-AP > 50%?',
  'IO Sign-off Rate (Rs.)', 'Associate (previous month)', 'Associate (current)', 'IO Sign off Link', 'Remarks',
  'Folder Link', 'IO Signed Brand PDF', 'Sign-off Date', 'Updated By'];

var CC_SNAP_COLS = ['Date', 'Associate', 'Team Lead', 'Active PANs', 'Total Receivables', 'Overdue', '>60 days',
  'Net Payable', 'Possible AR AP', 'PANs Touched', 'Coverage %', 'Not Followed 3d', 'Open PTPs', 'PTP Amount',
  'Broken PTPs', 'Activities'];

// ---------------------------------------------------------------------------
// Config / Team readers
// ---------------------------------------------------------------------------

function ccConfig_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CC.T.CONFIG);
  var out = {};
  CC_CONFIG_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) out[String(r[0]).trim()] = r[1] instanceof Date ? ccKey_(r[1]) : String(r[1]).trim();
    });
  }
  out.MODE = (out.MODE || 'TEST').toUpperCase();
  out.LIVE_SHEET_ID = ccExtractId_(out.LIVE_SHEET_ID);
  out.RAW_DATA_SHEET_ID = out.RAW_DATA_SHEET_ID === 'THIS' ? 'THIS' : ccExtractId_(out.RAW_DATA_SHEET_ID);
  out.RAW_ID = out.RAW_DATA_SHEET_ID || out.LIVE_SHEET_ID;
  return out;
}

/** Team roster: [{name, role, teamLead, group, email, active, liveTab}] */
function ccTeam_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(CC.T.TEAM);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, CC_TEAM_COLS.length).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return {
        name: String(r[0]).trim(), role: String(r[1] || 'Associate').trim(), teamLead: String(r[2] || '').trim(),
        group: String(r[3] || '').trim(), email: String(r[4] || '').trim().toLowerCase(),
        active: String(r[5] || 'Yes').trim() !== 'No', liveTab: String(r[6] || r[0]).trim()
      };
    });
}

/** Associates who own PANs (role Associate, or anyone with a live tab). */
function ccAssociates_() {
  return ccTeam_().filter(function (t) { return t.active && (t.role === 'Associate' || t.liveTab); });
}

/** Who is using the workbench: matched by e-mail on the Team tab. */
function ccWhoAmI_() {
  var email = ccUser_().toLowerCase();
  var team = ccTeam_();
  var me = null;
  if (email) team.forEach(function (t) { if (t.email && t.email === email) me = t; });
  return { email: email, person: me };
}
