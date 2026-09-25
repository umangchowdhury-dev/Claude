# AR Command Center

A **new Google Sheet** that replaces the "Associate Level Ageing Master – AR" tracker. It serves associates, team leads and management in one place: the PAN book, invoice drill-down, PTPs per invoice, follow-ups, reviews, dashboards and history.

It starts in **TEST mode**. In TEST mode it copies everything from the current live sheet every 30 minutes. It only reads the live sheet and never changes it. This lets you review the new sheet side by side with the old one before anyone moves over. When you're happy, switch it to **LIVE mode** and it becomes the tracker (see [Cut-over](#cut-over-test--live)).

## Set it up (≈10 minutes, once)

1. Create a blank Google Sheet, for example *AR Command Center (TEST)*.
2. Open **Extensions → Apps Script**. Delete the empty `Code.gs`, then create these files and paste in the contents from `src/`:

   | Apps Script file | Type | From |
   |---|---|---|
   | `00_Config` | Script | `src/00_Config.gs` |
   | `10_Setup` | Script | `src/10_Setup.gs` |
   | `20_Sync` | Script | `src/20_Sync.gs` |
   | `30_Model` | Script | `src/30_Model.gs` |
   | `40_Dashboard` | Script | `src/40_Dashboard.gs` |
   | `50_Edits` | Script | `src/50_Edits.gs` |
   | `60_Api` | Script | `src/60_Api.gs` |
   | `90_Util` | Script | `src/90_Util.gs` |
   | `Workbench` | **HTML** | `src/Workbench.html` |
   | `appsscript.json` | manifest | `src/appsscript.json`. Turn on *Project Settings → Show "appsscript.json"* first. It sets the Asia/Kolkata time zone. |

3. Select **`CC_setup`** in the function drop-down and click **Run**. Approve the permissions it asks for: read other sheets, edit this sheet, create Gmail drafts, and run on a schedule.
4. When asked, paste the **URL of the live tracker**. Your account only needs *view* access to it.
5. Setup builds every tab and runs the first sync (2–4 minutes for the full data). Reload the sheet and the **🧾 AR Command Center** menu appears.
6. Fill in the **Team** tab. Associates are added automatically from the live tabs. Add each person's **e-mail**, their **Role** (Associate / Team Lead / Management / Admin) and their **Team Lead**. The workbench uses the e-mail to recognise who is opening it and which views to show.
7. Share the sheet with the team (edit access).

Schedules installed by setup:
- **Sync:** every 30 min (Config `SYNC_EVERY_MINUTES`).
- **Daily maintenance:** 07:00 (PTP statuses, auto "Invoice Not Due", new overdue invoices into the PTP Tracker).
- **Nightly snapshot:** 23:00 (trend history for management).

## Tabs

| Tab | What it is | Who edits |
|---|---|---|
| **Home** | Guide, mode, last sync | – |
| **Dashboard** | The old *Summary*, plus management sections. Rebuilt on every sync. | nobody (calculated) |
| **PAN Master** | The old *Consolidated* and **all 15 associate tabs in one**: one row per PAN. Filter by *Associate* for "my tab". Yellow columns are editable. | associates / team leads (yellow columns) |
| **PTP Tracker** | One row per invoice: PTP date, amount, mode, contact, tag, live status | associates (workbench or yellow columns) |
| **Follow-ups** | Daily status per PAN per day. Replaces the ~110 date columns on every associate tab. | workbench / PAN Master "Today's Status" |
| **Activity Log** | Every call, e-mail, PTP, tag, remark, reassignment: who / when / what | automatic |
| **IO Sign-off** | The old *IO Sign Off Rate Card*, plus a sign-off date | associates (link / remarks) |
| **Snapshots** | Nightly per-associate history, for trends | automatic |
| **Team / Config** | Roster, roles, team leads, e-mails; settings | admin |
| Invoices, Payables, Map: Category, Map: Brand, List: Exposure PANs, List: Historic AR-AP PANs | Raw data copied from the source sheet | automatic |
| PAN Inputs, Sync Log | Behind-the-scenes store for everything typed in PAN Master; sync history | automatic |

## Where everything from the old sheet went

**Old tabs**

| Old tab | New home |
|---|---|
| Summary | **Dashboard → Associate summary**: every column, same definitions. Plus Team Lead, Group, touched today, coverage today / MTD, open & broken PTPs, PTP kept %, IO sign-offs & incentive. Also the Check and Overall-check rows, and the Improvement Points list with its status. |
| Summary date columns + monthly moving averages | **Dashboard → Daily follow-ups done per associate**, with a moving-average column after each month |
| Consolidated | **PAN Master** (all its columns; see below) |
| Neha, Ritu, Satpal, Sowmya, Arul, Nahas, Rajashekar, Virajita, Kaushal, Avinash, Disha, Prasanna, Akshay, Ayush | **PAN Master** rows owned by that associate, plus the **workbench** "PANs" view. Daily grid → **Follow-ups**. |
| PTP Tracker | **PTP Tracker** (same 12 columns plus PAN, PTP Amount, Payment Mode, Contact Person, PTP Remarks, Invoice Tag, Updated By / On) |
| IO Sign Off Rate Card | **IO Sign-off** (the same 12 columns plus Sign-off Date and Updated By). The per-associate summary is on the Dashboard. The old manual summary block is kept for reference. |
| Imported_Data | **Invoices** |
| Payable Data - Daily | **Payables** |
| Category Mapping / Brand Name Mapping for vlookup | **Map: Category / Map: Brand** |
| ExposureDefaulting PANs / Historically AR AP Done PANs | **List: Exposure PANs / List: Historic AR-AP PANs** |
| Claude Cache | not needed |

**Associate / Consolidated columns → PAN Master**

| Old column | New column | Calculation (same as the old formula unless noted) |
|---|---|---|
| PAN, Customer Name | same | first Customer Name for the PAN in Invoices |
| Associate Name (Consolidated) / tab name | **Associate** (editable: team leads can reassign) | |
| Brand Names, KAMs, KAM Managers | same | unique values over the PAN's invoices; trailing-space duplicates removed |
| Due / Pending Activity Months | Due Activity Months | activity months of invoices with a balance, else "NA" |
| Business Model, Net Payable Balance | same | from Payables. **Reads every row**: the old formula stopped at row 6352 (see findings). |
| Historically AR AP Done?, Exposure / Defaulting PAN? | same | PAN in the list tab |
| POE Required? | same (editable) | |
| BU Head, Category Head 1/2, BizFin Spoc | same | unique names from the invoices |
| IO Sign Off Incentive | same, plus **IO Signed?** | rate from IO Sign-off; "NA" when missing or 0 |
| a.Not Due … g.>151, Total, Overdue, >60 | same | sum of Net to be received by bucket |
| Possible AR AP (Consolidated rule) | **Possible AR AP** | MIN(Overdue, Net Payable) |
| Possible AR AP (associate-tab rule) | **Possible AR AP (on total)** | MIN(Total, Net Payable). The two old tabs used different rules, so both are kept. |
| Possible AR AP > 60 days | same | |
| Associate Remarks / Remarks, Team Lead Remarks | same (editable) | |
| Red / Yellow / Green | **Red / Amber (Yellow) / Green** (editable amounts), plus **Collection Confidence** (the colour with the largest amount) | |
| daily date columns | **Follow-ups** tab, plus **Today's Status** (editable), **Last Follow-up**, **Days Since F/U**, **Last 7 Days**, **Follow-ups MTD** | |
| – | **new:** Open Invoices, Oldest (days), Open PTPs, PTP Amount, Next PTP, Broken PTPs, Priority, Next Follow-up, Last Updated By / On, Team Lead, Group | |

## What each role gets (🧾 menu → Open workbench)

**Associates**
- **Today:** a work queue with broken PTPs, PTPs due today, follow-ups due today, a suggested next 10 by priority, and PANs untouched for 3+ days. One click marks the whole day as Leave or Holiday.
- **PANs:** search, 11 filters, sorting, and bulk-marking today's status.
- **Click any PAN** to see every open invoice. Tick invoices, then:
  - 🤝 **PTP**: date, per-invoice amount, mode, contact
  - 🏷️ **Tag**: Disputed / AR-AP / POE / Escalated…
  - ✉️ **Reminder e-mail**: a Gmail draft with the invoice statement. It counts as a follow-up.
- 📞 **Log follow-up**: channel, outcome, next follow-up date.
- 🚦 **Red / Amber / Green**, remarks, settled invoices, and full history.
- **Productivity:** coverage, activities, PTP kept-rate, a 3-week chart and a leaderboard.
- **🎯 Follow** (sidebar): click a PAN row anywhere in the sheet and it opens in the workbench.

**Team leads**, everything above, plus:
- A **Team review** tab. It has a table per associate: coverage today / MTD, stale PANs, broken PTPs, kept %, remarks filled, and R/A/G. It also has review queues: broken PTPs, not followed for 3 days, >60 days without a PTP, overdue with no remark, Red, and Exposure.
- Add **Team Lead remarks** and **reassign PANs**.
- Switch the view to any associate or to the whole team.

**Management**, everything above, plus:
- An **Overview** tab: portfolio KPIs, ageing, collection confidence, IO sign-off, a trend from the nightly snapshots, an associate table, breakdowns by business model / BU head / team lead, the top 20 overdue PANs, and a reconciliation badge.
- The **Dashboard** tab in the sheet itself: the full Summary, plus ageing by business model and BU, risk lists and checks.

## Findings from reconciling against the live sheet (25-Sep data)

Every PAN and every column was compared with the live sheet: 3,033 PANs, all 15 associate tabs and the Summary. Receivables, all seven buckets, totals, remarks, team lead remarks, POE, R/A/G and the daily history all match. The differences come from these issues in the live sheet:

1. **Filters on associate tabs change the Summary.** The Summary uses `SUBTOTAL`, which skips hidden rows. At the time of the export, filters were active on Virajita's, Satpal's and Kaushal's tabs, so the Summary showed Virajita at ₹1.14 Cr instead of ₹26.04 Cr, and Satpal at ₹1.30 Cr instead of ₹5.54 Cr. The new sheet always counts every row.
2. **Payables lookups stop at row 6352.** *Payable Data - Daily* now has 7,059 rows. 57 PANs whose payables are below row 6352 show "Vendor Does not Exist" and ₹0 net payable, which also understates Possible AR AP.
3. **4 PANs with open invoices (₹16,16,708) are on no associate tab.** This is exactly the −16,16,708 in the old "Overall Check" row. The new sheet shows them as *Unassigned*, so they can be given to someone.
4. **Neha's Summary row has no formulas** for "Remarks filled" and "Exposure accounts". It shows 0; the actual counts are 63 and 18.
5. **PTP dates typed as text into Status** ("25th sep", "28th sep", 29 rows). These are converted into real PTP dates, and the original text is kept in PTP Remarks.
6. The old follow-up grid counted only **"Yes"**. The new grid counts Yes + PTP + Expected Payment. A PAN where a PTP was taken was followed up.

## Config

| Setting | Default | Meaning |
|---|---|---|
| MODE | TEST | TEST pulls remarks / follow-ups / PTPs from the live sheet too. LIVE pulls only raw data. |
| LIVE_SHEET_ID | – | the live tracker (a URL or ID) |
| RAW_DATA_SHEET_ID | = LIVE | where Imported_Data / Payables / mappings come from. Set it to `THIS` to paste them straight into this sheet's Invoices / Payables tabs. |
| SYNC_EVERY_MINUTES | 30 | 1 / 5 / 10 / 15 / 30. Re-run setup after changing it. |
| FOLLOWUP_START | 2026-08-01 | first date in the Dashboard follow-up grid |
| WORK_WEEK | Mon-Sat | used by "not followed up 3 days" and the moving averages |
| RESTRICT_VIEWS | No | Yes = associates see only their PANs, team leads only their team |
| AUTO_NOT_DUE / ADD_OVERDUE_TO_PTP | Yes | daily automation switches |

**Merge rule in TEST mode.** A remark, R/A/G value, POE, owner or PTP that you change in the new sheet is kept. A value from the live sheet replaces it only if that value **changes in the live sheet** after your edit. Follow-ups entered in the new sheet always win over the live grid for the same day.

## Cut-over (TEST → LIVE)

1. Review the new sheet for a few days and adjust it.
2. Pick a day. After the last evening sync, set **MODE = LIVE** on Config. Everything typed in the old sheet up to that sync is already here.
3. Tell associates to work only in the new sheet from then on. Keep the old sheet read-only for reference.
4. Raw data keeps coming from `RAW_DATA_SHEET_ID`. Point it at wherever Imported_Data and Payables are refreshed, or set it to `THIS` and paste them here.

## Limits worth knowing

- **Sync time.** A full sync reads about 1.7M cells, which takes about 1–3 minutes. Later syncs skip data that hasn't changed.
- **Daily trigger quota.** Google Workspace allows 6 hours of trigger time per day, so a 30-minute sync is comfortably inside that.
- **Script vs formulas.** PAN Master and the Dashboard are values written by the script, not formulas. That's why the sheet is fast. The trade-off is that raw data typed into Invoices only shows up after the next sync, or after **menu → Rebuild PAN Master & Dashboard**.
- **Identity.** The workbench knows who you are from your Google e-mail. If a colleague's account doesn't share its e-mail (for example a personal account), they pick their name once and it is remembered.

## Development

```bash
cd ar-command-center
TZ=Asia/Kolkata node --test test/*.test.js                 # 18 tests against a synthetic copy of the live layout
TZ=Asia/Kolkata node test/preview.js --synthetic out       # screenshots for associate / team lead / management (Playwright)
```

`test/gas-mock.js` is a small in-memory Apps Script: SpreadsheetApp with two spreadsheets, Cache, Properties, Lock, Gmail and ScriptApp. It runs the real `.gs` files in a Node `vm`. Pass a JSON export of a real workbook to `preview.js` to preview against real data. Keep such exports out of the repo.
