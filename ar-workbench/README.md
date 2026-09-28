# AR Workbench v2

One Google Apps Script add-on for the **Associate Level Ageing Master – AR** sheet. It serves three roles from the same side panel (or a full-screen window), inside the live sheet:

- **Associates:** a personal workbench.
- **Team leads:** a review desk.
- **Management:** a command center.

The input tabs (`Imported_Data`, `Payable Data - Daily`, the mapping and list tabs) are refreshed daily as before, and none of their formulas change.

v2 merges the **AR Command Center** (`../ar-command-center`) into the workbench. You get team review, the management overview, IO sign-offs, R/A/G, reassigning PANs, snapshots and data health checks, without a second sheet or any syncing.

## What each role gets

**Associate**
- **🏠 Today**
  - A coverage ring for today against the goal: PANs with Yes / PTP / Expected Payment ÷ PANs with a balance.
  - Overdue, >60, broken PTPs and PANs not followed up.
  - Lists: broken PTPs, PTPs due today, the suggested next 10 by priority, follow-ups due, PANs not followed up, and IO sign-off quick wins.
  - One click marks the whole day as Leave or Holiday.
- **📒 PANs:** search (PAN, customer, brand, KAM, remark), 15 filters, 8 sorts and a 7-day follow-up strip. Select several PANs to set today's status or reassign them.
- **Click a PAN** in the panel, or with **🎯 Follow** on (the default), click a PAN row anywhere in the sheet:
  - **Simple first.** Customer, flags (Exposure, AR-AP history, POE, IO signed/pending, R/A/G, PTP, today's status), then overdue, >60, total and possible AR-AP, and an ageing bar.
  - **Every open invoice**, with a **PTP date box on each one** that saves as soon as you pick a date.
  - **One PTP date for** overdue invoices without a PTP, all overdue, all open or the selected invoices, in one click.
  - **📋 Copy for mail**
    - Pick the invoices (overdue / all / selected) and the columns (invoice no, dates, brand, activity month, days overdue, TDS, received, AR-AP adjustment, outstanding, payment commitment).
    - Choose **full mail** (greeting, table, sign-off) or **table only**.
    - **Copy**, then paste into the brand mail. It pastes as a formatted table in Gmail and Outlook.
    - Or turn the same content into a **Gmail draft** (with "CC KAMs" when `KAM_EMAIL_DOMAIN` is set). Copying or drafting can count as today's follow-up.
  - **🤝 PTP** with part-payment amounts, mode, contact and remarks. **📞 Log** a follow-up (channel, outcome, next date). **🏷️ Tag** invoices (Disputed, AR-AP proposed, …).
  - **✍️ IO sign-off:** status, sign-off link, signed PDF, date and remarks, written to the IO Sign Off Rate Card.
  - **🚦 Confidence:** Red / Amber / Green amounts and POE, written to the tab.
  - Collapsible "view more" sections:
    - Contacts (brands, KAMs, KAM managers, BU head, category heads, BizFin).
    - Payables & AR-AP, with every vendor code, payable and inventory.
    - IO sign-off, confidence, remarks and team lead remarks.
    - A 14-day follow-up calendar, recently settled invoices, and the full activity history.
- **🤝 PTPs:** broken / due today / partially paid / upcoming / tagged / paid.
- **✍️ IO:** your rate-card PANs; signed, pending, incentive earned (total and this month) and still to earn. Update any of them from the list.
- **📈 Stats:** coverage today and month to date, activities, PTP kept-rate, IO signed, a 3-week chart and a team leaderboard.
- **🔍 Search (Ctrl+K):** any PAN, customer, brand or invoice number (open or settled), across every associate.

**Team lead** gets everything above for their team (the view picker switches between the team and any associate), plus:
- **👥 Team:**
  - Per-associate overdue, >60, coverage today / MTD, not followed up, open and broken PTPs, kept %, remarks on overdue PANs, an R/A/G bar, and IO signed / pending.
  - Seven review queues: broken PTPs, not followed up, >60 without PTP, overdue without remark, Red, Exposure with overdue, and IO pending with the highest incentive.
- **Team lead remarks** from the PAN view, and **🔀 reassign** PANs (see "What it writes").

**Management** gets everything, plus **🧭 Overview**:
- Portfolio KPIs.
- Ageing, the R/A/G split, and the trend from nightly snapshots.
- A sortable associate table.
- Breakdowns by business model, BU head and team lead.
- The top 20 overdue PANs.
- **🩺 Data health checks** (below).

**🧾 AR Workbench → Open workbench (large window)** is the main way in. It's a floating window, so you can still click in the sheet behind it; set its size with `WINDOW_SIZE` on WB Settings. Google fixes side panels at 300px, so the side panel stays as a compact option (**Open compact side panel**), with Follow on by default. ⤢ in the panel opens the large window.

## Data health checks (Overview)

These are the things that silently make the Summary tab wrong:

| Check | Why it matters |
|---|---|
| A tab's total row (SUBTOTAL) ≠ the sum of its PAN rows | A filter left on a tab, or a SUBTOTAL range that stops early, under-reports that associate on the Summary. |
| PANs with open invoices on no associate tab | They are missing from the Summary (the "Overall Check" gap). Each one has an **Assign…** button. |
| A PAN on two tabs | It is counted twice. |
| Consolidated's Associate Name ≠ the tab that holds the PAN | Consolidated looks up remarks and R/Y/G by that name. |
| "Vendor Does not Exist" although the PAN is in Payables | The Business Model / Net Payable lookups stop before the last Payables row, which also understates Possible AR AP. |
| A tab has no date column for today | Today's status can't be recorded. |
| Hand-typed PTP statuses | The daily job turns "25th sep" into a PTP date and keeps other text in PTP Remarks. |

On the 27-Sep export the checks found:
- Two tabs whose total rows hide rows (₹11.1 Cr on one tab, ₹23 L on another).
- 57 PANs hit by the Payables lookup range.
- 119 hand-typed PTP statuses ("Settled", "PTP Breached").

## What it writes (and nothing else)

| Where | What |
|---|---|
| Associate tabs | **Remarks**, **Team Lead Remarks**, **Red / Yellow / Green**, **POE Required ?** and **today's** follow-up cell. Only values from the existing drop-down are used, and PTP / Expected Payment are never downgraded to Yes on the same day. Reassign writes the PAN into the new owner's first free formula row (below the last PAN) and moves the inputs with it. The old row keeps its daily history, so past Summary counts stay right; only its PAN and inputs are cleared. |
| `Consolidated` | **Associate Name** (column C), on reassign only. |
| `PTP Tracker` | Upsert by Invoice No. Eight columns are added on the right: `PAN, PTP Amount, Payment Mode, Contact Person, PTP Remarks, Invoice Tag, Updated By, Updated On`. |
| `IO Sign Off Rate Card` | `IO Sign off Link` (filled = signed, the same rule as the card's own summary), `Remarks` and `IO Signed Brand PDF`. Two columns are added after the headers: `IO Signed On` and `IO Updated By`. The summary block on the right is not touched. |
| `WB Activity Log` (new) | One row per action: timestamp, associate, PAN, type, outcome, invoices, amount, next follow-up, remarks, user. |
| `WB Settings` (new) | Team roster (Name, Role, Team Lead, Email, Active) in A:E and settings in G:I. |
| `WB Snapshots` (new) | One row per associate per night: balances, coverage, PTPs, IO and activities. Feeds the trend. |

## Install (admin, ~5 minutes)

1. Open the live sheet, then **Extensions → Apps Script**.
2. Create or replace these files and paste in the contents from `src/`:
   - `Code.gs`. If the project already has another `Code.gs`, name this one `Workbench.gs`.
   - `Workbench` as an **HTML** file.
   - `appsscript.json`: optional. Turn on *Project Settings → Show "appsscript.json"* first. It sets Asia/Kolkata and V8.
3. Select **`WB_setup`** and click **Run**. Approve the permissions (Sheets, Gmail drafts, triggers, your e-mail address). Setup creates `WB Activity Log`, `WB Settings` and `WB Snapshots`, adds the extra headers, and installs the triggers. It is safe to run again.
4. On **WB Settings**:
   - Add team leads (Role `Team Lead`) and management (Role `Management` or `Admin`).
   - Put each person's **e-mail**, and each associate's **Team Lead**.
   - Associate tabs are listed automatically.
   - Until any non-associate role is filled in, everyone sees every view (set-up mode).
5. Reload the sheet. The **🧾 AR Workbench** menu appears. Choose **Open workbench (large window)**.

**Upgrading from v1:** replace `Code.gs` and `Workbench.html` and run `WB_setup` again. The activity log and PTP Tracker columns carry over.

**Scheduled jobs.** `WB_setup` installs just **two triggers**: the menu (`WB_onOpen`) and one hourly job (`WB_hourly`). Google allows 20 triggers per person per script, and many sheets already use some. Setup also removes old or duplicate workbench triggers. If the quota is still full, it tells you which other triggers exist so you can delete the ones you don't need.

The hourly job does, in the sheet's time zone:

| When | What |
|---|---|
| first run from 07:00 | Daily maintenance: rebuild caches; refresh PTP statuses; add newly overdue invoices to PTP Tracker as "PTP Pending"; write "Invoice Not Due" for PANs with nothing overdue (blank cells only). |
| every 2 hours | PTP status refresh: current outstanding, settlement date, days vs PTP, status. |
| 08:00–22:00 | Cache warm-up, so the team and overview views open instantly. |
| first run from 22:00 | Nightly snapshot for the trend. |

"Once a day" is tracked, so a late or missed run is caught up by the next one.

## Settings (WB Settings, columns G:I)

| Setting | Default | Meaning |
|---|---|---|
| WINDOW_SIZE | 1280x780 | Width × height of the workbench window. Use e.g. `1100x680` on small laptops. |
| STALE_DAYS | 3 | Working days without Yes / PTP / Expected Payment before an overdue PAN counts as "not followed up". |
| COVERAGE_TARGET | 80 | The daily coverage goal (%) on Today. |
| WORK_WEEK | Mon-Sat | Or Mon-Fri. Used for the stale check and month-to-date coverage. |
| EMAIL_SIGNATURE | Accounts Receivable | The line under the associate's name in mails. |
| KAM_EMAIL_DOMAIN | – | KAM names look like e-mail user names (`Ishan.Chawla`). Set your mail domain to get mail links and "CC KAMs". |
| RESTRICT_VIEWS | No | `Yes`: associates see only their PANs and team leads only their team. This relies on e-mails being filled in. The sheet itself stays editable by everyone, so it is a convenience, not a security boundary. |
| AUTO_NOT_DUE / ADD_OVERDUE_TO_PTP | Yes | Switches for the daily job. |

## Performance notes

- **Open invoices.** `Imported_Data` has about 66k rows, but only about 3.3k invoices are open. The open set is cached (chunked, shared by everyone) and rebuilt when the sheet's row count changes, every 6 hours, or on ↻.
- **Your own book** is always read live from your tab: only the fixed columns and the last ~2 months of date columns, down to the last PAN.
- **Team and overview views** use per-associate caches, at most 30 minutes old and warmed hourly. The view says "as of hh:mm" and has **↻ Live**. A write made through the workbench drops that associate's cache immediately.
- **Shared caches.** PTP Tracker, the IO card, Consolidated, Payables (both blocks) and the last 90 days of the activity log are parsed once and cached for everyone. The log cache only fetches rows added since the last read. Any workbench write refreshes the cache it touches.
- **Opening a PAN** takes about 6 sheet reads (it was about 90 in the first v2): one lookup on the owner's tab plus that row. Settled invoices load only when their section is opened. Start-up is one call.
- **The one slow load** is the first read of Imported_Data (about 66k rows) after its cache expires. The 07:00 job and the hourly warm-up normally do it before anyone opens the workbench.

## Limits worth knowing

- **Copy.** It uses the browser's copy command inside the Apps Script panel. If a browser blocks it, the workbench says so; select the preview and press Ctrl+C.
- **Follow.** A panel can't be opened by a click in the grid (Google doesn't allow it), so the open side panel watches the selection instead. Opening the panel never jumps to whatever cell happens to be selected; only a new selection does.
- **Identity.** It comes from the Google e-mail. Someone whose e-mail is hidden (for example a personal account) picks their name once and it is remembered.

## Development

```bash
cd ar-workbench
TZ=Asia/Kolkata node --test test/*.test.js                   # 38 tests against a synthetic workbook
TZ=Asia/Kolkata node test/preview.js --synthetic out           # screenshots for associate, team lead, management + every form clicked end to end (Playwright)
ONLY=associate-sidebar TZ=Asia/Kolkata node test/preview.js --synthetic out   # one persona / mode
```

- `test/gas-mock.js` is a small in-memory Apps Script: SpreadsheetApp, Cache, Properties, Lock, Session, Gmail and ScriptApp. It runs the real `Code.gs` in a Node `vm`, and each call is a fresh execution.
- `test/synthetic-fixture.js` mirrors the live layout, including the IO rate card, both Payables blocks, spare formula rows, and deliberate data problems for the health checks.
- Pass a JSON export of a real workbook to `preview.js` to preview against real data. Keep such exports out of the repo (`real*.json` is git-ignored).
