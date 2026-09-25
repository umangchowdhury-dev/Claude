# AR Associate Workbench

A Google Apps Script add-on for the **Associate Level Ageing Master – AR** Google Sheet. It gives each associate a workbench inside the sheet. From there they can open any PAN to see its invoices, record promises to pay (PTPs) for individual invoices, log follow-ups, draft reminder e-mails and track their own productivity. It all works inside the live tracker: no exports, and none of the existing formulas are touched.

It covers these items from the Summary tab's *Improvement Points* list:

| Improvement point | How it is covered |
|---|---|
| Clicking the line item will open up the invoice level data | Click a PAN in the sidebar, or turn on **🎯 Follow** and click a PAN row in your tab, Consolidated or PTP Tracker. |
| Not Due line items to be automatically marked as invoice not due | The daily 07:00 job fills today's column with `Invoice Not Due` for PANs that have nothing overdue. It only fills blank cells. |
| Mail count to be linked to manual follow up count | The **✉️ Reminder e-mail** button creates a Gmail draft, logs it as an e-mail follow-up and marks today as `Yes`. |
| PTP drop down | PTPs are recorded per invoice, with a date picker, quick-date buttons, part-payment amounts, payment mode and contact. |

## What associates get

**Today tab: the work queue**
- KPIs: overdue, >60 days, possible AR-AP, PANs touched today (with a progress bar), broken PTPs, and PANs not followed up for 3 or more days. Each tile opens a filtered list.
- 🔴 Broken PTPs, 📅 PTPs due today and ⏰ follow-ups scheduled for today.
- 🎯 **Suggested next 10**: a priority score based on overdue ₹, >60 ₹, days since the last follow-up, broken PTPs, exposure flag and possible AR-AP.
- One click to mark the whole day as Leave or Holiday.

**My PANs tab**
- Search by PAN, customer, brand or KAM (press `/` to jump to search).
- Filters: Overdue, Not done today, Untouched 3d+, >60, PTP broken, PTP open, AR-AP possible, Exposure, Only not-due, Credit balance.
- Sort by priority, overdue ₹, >60 ₹, total, AR-AP, days since follow-up or name.
- Each PAN has a 7-day follow-up strip (colour = Yes / PTP / Expected Payment / Not due / No / Leave).
- Bulk-select PANs to set today's status for all of them at once.

**PAN drill-down**
- Header with overdue, total, net payable (AP), possible AR-AP, an ageing bar across all 7 buckets, and flags (exposure, AR-AP history, POE, business model, IO incentive).
- Relationship: brands, KAMs, KAM managers, BU head, category heads, BizFin SPOC.
- The remark (editable, and it feeds Consolidated), the team lead remark, and a 14-day follow-up calendar.
- **Every open invoice** from `Imported_Data`: invoice no, invoice and due dates, brand, activity month, days, bucket, TDS, received, outstanding, PTP date and status, and tag. Columns are sortable, and **Select overdue** is one click.
- Actions on selected invoices:
  - 🤝 **PTP**: date plus amount per invoice (for part payments), mode, contact, remarks.
  - 🏷️ **Tag**: Disputed / AR-AP Proposed / AR-AP Approved / Expected Payment / Awaiting POE / Awaiting Reco / CN Requested / Escalated to KAM / Legal.
  - ✉️ **Mail**: a Gmail draft with an invoice statement table.
  - **Clear PTP**.
- 📞 **Log follow-up**: channel, outcome, notes, next follow-up date, and today's status.
- Recently settled invoices, and the full activity history for the PAN.
- ↗ **Go to row** jumps the grid to that PAN in the tracker tab.

**PTPs tab**: Broken / Due today / Partially paid / Upcoming / Tagged / Paid, with the live status of each.

**Productivity tab**
- Coverage today, average coverage month to date, activities today / this week / this month, PTPs given, PTP kept-rate, and PANs untouched for 3 or more days.
- A 3-week stacked chart of daily follow-ups.
- A team leaderboard: coverage, untouched count, activities, overdue and >60 for every associate.

Every view works in the narrow **sidebar** (non-blocking, so the sheet stays usable) and in a **full-screen** window with wide tables.

## What it writes (and nothing else)

| Where | What |
|---|---|
| The associate's own tab | The **Remarks** column (`dd-Mmm: …`) and **today's** daily follow-up cell, using only values from the existing drop-down (`Yes`, `PTP`, `Expected Payment`, `Invoice Not Due`, `Leave`, `Holiday`, `No`). A richer status such as PTP is never downgraded to Yes on the same day. |
| `PTP Tracker` | Upsert by Invoice No. Adds 8 columns to the right: `PAN, PTP Amount, Payment Mode, Contact Person, PTP Remarks, Invoice Tag, Updated By, Updated On`. The existing 12 columns keep their meaning. |
| `WB Activity Log` (new tab) | One row per action: timestamp, associate, PAN, type, outcome, invoices, amount, next follow-up, remarks, user. |

**Scheduled jobs** (installed by `WB_setup`):
- **07:00 daily, `WB_dailyMaintenance`**:
  - Rebuilds the invoice cache.
  - Refreshes PTP Tracker: Current Outstanding, Settlement Date (taken from Receipt Date), Days vs PTP, and Status (`PTP Given / Due Today / Broken / Partially Paid / Paid (PTP Kept) / Paid (after PTP) / Paid`).
  - Adds newly overdue invoices to PTP Tracker as `PTP Pending`.
  - Auto-marks `Invoice Not Due`.
- **Every 2 hours, `WB_refreshPtpStatuses`**: keeps PTP statuses current during the day.
- Free-text statuses such as `25th sep` that associates typed into the Status column are turned into a real PTP date. The original text is kept in PTP Remarks.

## Install (admin, ~5 minutes)

1. Open the live Google Sheet, then **Extensions → Apps Script**.
2. Create these three files (use **+ → Script** or **+ → HTML**) and paste in the contents from `src/`:
   - `Code.gs`: the whole file. If the project already has a `Code.gs`, add this as a new script file named `Workbench.gs` instead.
   - `Workbench.html`: create an HTML file named exactly `Workbench`.
   - `appsscript.json`: optional. Turn on *Project Settings → Show "appsscript.json"* first. It only sets the time zone to Asia/Kolkata and the V8 runtime.
3. Select `WB_setup` in the function drop-down, click **Run**, and approve the permissions. It uses Sheets, Gmail drafts and triggers.
4. Reload the sheet. The **🧾 AR Workbench** menu appears.

`WB_setup` installs its own open trigger (`WB_onOpen`) instead of a simple `onOpen()`, so it can't clash with a menu or script you already have. It is safe to run again.

The tab names it expects are `Consolidated`, `PTP Tracker` and `Imported_Data`. They are set at the top of `Code.gs` (`WB.SHEET_*`). Associate tabs are found automatically: any visible tab whose row 2 starts with `PAN` and contains `Total Receivables` and `Team Lead Remarks`. Adding a new associate tab needs no code change. Columns are matched by header name (with aliases such as `Remarks` / `Associate Remarks` and `Due` / `Pending Activity Months`), so the column order can change.

## Use (associates)

1. **🧾 AR Workbench → Open my workbench** from your own tab. Your name is picked automatically and remembered.
2. Start at **Today** and work the red and amber items first.
3. Click a PAN, tick invoices, then press **🤝 PTP** or **📞 Log follow-up**. The sheet updates itself.
4. Turn on **🎯 Follow** to open whichever PAN row you click in the grid.
5. **⤢** opens the full-screen view for wide invoice tables.

## Performance notes

`Imported_Data` has about 80k rows, but only about 3.5k invoices are open. The open set is cached with `CacheService`, shared by all users, split into chunks and kept for up to 6 hours. The cache rebuilds automatically when the row count of `Imported_Data` changes, or on **↻** or *Refresh invoice data now*. The first PAN opened after a data refresh takes a few seconds; after that, opens are sub-second. Settled invoice history is fetched per PAN with `TextFinder`, so the whole sheet is never scanned.

## Development

```bash
cd ar-workbench
TZ=Asia/Kolkata node --test test/*.test.js          # 19 tests against a synthetic workbook
TZ=Asia/Kolkata node test/preview.js --synthetic out # UI screenshots (needs Playwright/Chromium)
```

`test/gas-mock.js` is a small in-memory stand-in for SpreadsheetApp, CacheService, Lock, Properties, Gmail and ScriptApp. It runs the real `Code.gs` in a Node `vm`. `test/preview.js` loads the real `Workbench.html` in Chromium, with `google.script.run` bridged to that mock. Pass a JSON dump of a workbook instead of `--synthetic` to preview against real data. Keep such dumps out of the repo.
