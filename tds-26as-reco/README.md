# 26AS vs Books – automated TDS reconciliation

A drop-folder reconciliation that replaces the manual *ZL_26AS_Vs_Books* workbook. You keep dropping files in. Every run redoes the whole reconciliation, inception-to-date, and writes one workbook of **action items**. Each item says who acts and what they do: the entry *we* pass, or what the *deductor* (the "vendor" who deducts TDS on us) must fix.

Two cuts run on every pass:

| Cut | Question | Output |
|---|---|---|
| **1. LDC rate vs rate deducted** | Did the deductor apply our Lower Deduction Certificate rate? Anything deducted above it is cash blocked until the ITR refund. | Excess per deductor/section/FY, the net working-capital cost, certificate utilisation alerts |
| **2. 26AS vs Books** | Does TDS receivable in the books agree with Form 26AS, per party and FY? Everything except genuine timing differences must be resolved. | Category and owner per party, proposed JEs, deductor e-mails, tracker |

---

## 1. The working folder

Create it once, somewhere the team can reach. A Google Drive / OneDrive / SharePoint synced folder works well because everyone can drop files. One laptop runs the engine.

```
python -m tdsreco init "D:\Finance\TDS_26AS_Reco"
```

```
TDS_26AS_Reco/
├─ 00_Config/Settings.xlsx        tolerance, cost of capital, cut-off override, section map, standard rates, area owners
├─ 01_26AS/                       every 26AS you download (TRACES .txt or Excel), any FY, any date. Never delete old ones
├─ 02_Books_GL/                   TDS/TCS receivable GL dumps (SAP FBL3N/FAGLL03). ITD or monthly; overlaps are de-duplicated
├─ 03_Masters/Party_Master.xlsx   TAN → PAN (TAN_Map) and PAN → area / customer codes / e-mail (Parties). Grows by itself
├─ 03_Masters/LDC_Certificates.xlsx   one row per certificate: TAN, section, rate %, validity, amount limit
├─ 04_Party_Ledgers/              ledgers received from parties (PAN or TAN in the file name)
├─ 05_Form16A/                    Form 16A PDFs / TRACES zips; Form16A_Manual_Entry.xlsx for scans
├─ 06_AR_Open_Items/              optional: open invoices with expected TDS (explains "TDS on unpaid invoices")
├─ 90_Output/                     26AS_Reco_upto_<cut-off>_run_<date>.xlsx  ← read this
├─ 91_Tracker/Action_Tracker.xlsx ← the ONE file people edit (Status, Remarks, Assigned To, Next Follow-up)
└─ 99_History/                    run snapshots, for the "movement vs previous run" view
```

Run it:

```
pip install -r requirements.txt
python -m tdsreco run   "D:\Finance\TDS_26AS_Reco"          # once
python -m tdsreco watch "D:\Finance\TDS_26AS_Reco" 15       # re-runs by itself whenever a file is added/changed
```

On Windows, edit the path in `run_reco.bat` and double-click it. To make the folder fully automatic, schedule `watch` or `run` with Windows Task Scheduler.

### What the engine does with each drop

* **26AS**: every file is a snapshot, dated by the date in its file name (e.g. `26AS_FY2025-26_2026-09-15.txt`), else the TRACES creation date, else its latest booking date. The newest snapshot per FY is used. Older ones stay for history. Reads TRACES text (`^`-delimited) and Excel in the `26AS_details` layout.
* **GL**: overlapping dumps are de-duplicated line by line. The FY a line belongs to comes from the `Fiscal` column, else the GL account's FY in Settings, else the document date. The party comes from the `PAN` column, else customer/vendor code via the party master, else a PAN/TAN found in the text. A bank tagged by its TAN is resolved to its PAN, just as 26AS is.
* **Cut-off**: automatic. It is the last quarter end whose deductor TDS-return due date (31 Jul / 31 Oct / 31 Jan / 31 May) plus 15 days has passed on the latest 26AS download. A 13-Sep download therefore reconciles up to 30-Jun, matching your "30June26" file. Books posted after the cut-off are used only to recognise timing differences.
* **Masters learn**: new TANs are appended to `TAN_Map` with a name-matched **Suggested** PAN. Confirm them by setting Status = Confirmed and the next run uses them. New PANs from the books are appended to `Parties`.
* **Tracker**: what people typed is carried forward. New items arrive as *New*. Items the data shows as cleared are marked *Auto-closed*. Items marked *Resolved* that are still open come back as *Reopened*.

---

## 2. The ongoing process (who does what, when)

| When | Who | Step |
|---|---|---|
| **Books close, around WD-5 monthly** | GL team | Drop the month's TDS receivable GL dump into `02_Books_GL` → run → pass the **Journal Entries** tab items tagged *Us – books entry* / *Us – tag PAN*. Mark them *Entry passed* in the tracker. |
| **Around 15 Aug / 15 Nov / 15 Feb / 15 Jun** (15 days after each TDS-return due date) | Tax team | Download 26AS for every open FY from TRACES → drop into `01_26AS` → run. The cut-off moves forward a quarter on its own. |
| **Same week** | Area owners (Monet, BFD, Sellers, Treasury…) | Send the **Deductor Requests** e-mails for their parties. Set the tracker status to *Mail sent to party*. Ask for the party ledger and Form 16A. |
| **Whenever received** | Area owners | Drop party ledgers into `04_Party_Ledgers` and Form 16A into `05_Form16A`. The next run uses them to decide *who* is wrong (see §3) and closes or re-routes items. |
| **Monthly** | Tax team | Work the **LDC Cut** / **LDC Certificates** tabs. Chase deductors not applying the LDC. Apply for enhancement at 80% utilisation and renewal 60 days before expiry. |
| **Monthly review** | Controller | Dashboard §2 (where the variance sits), §5 (open actions by owner), §7 (movement vs last run). Review High-priority items older than 60 days. |
| **Before the ITR (Sep/Oct)** | Tax team | Final run for the FY. Claim what 26AS supports. For excess-in-books that deductors won't fix, decide on **recover vs write-off** (Dr TDS written off / Cr TDS Receivable). |
| **FY start (April)** | Tax team | File LDC applications early. Load the new certificates into `LDC_Certificates.xlsx` as soon as they are issued. |

---

## 3. What the engine concludes, and the entry

Variance = Books − 26AS, per party (PAN, or TAN until mapped), inception-to-date, tolerance ±₹10,000 (Settings).

| Finding | Who acts | Our books entry | What the deductor must do |
|---|---|---|---|
| **Not accounted in books**: 26AS credit, nothing in books | Us | Dr TDS Receivable (FY) / Cr Customer. Interest: Cr Interest receivable. TCS: Cr Vendor | Only if we have **no business** with them: revise their return to remove our PAN. We do **not** claim it |
| **Short in books**: 26AS > books | Us | Dr TDS Receivable (FY) / Cr Customer for the gap (look for short-payments sitting unapplied) | – |
| Short, but the party's own ledger agrees with our books | Deductor | none until confirmed | Check the PAN tagging in its return |
| **Excess – deductor deducted but not reported**: books > 26AS; party ledger / 16A supports our books | Deductor | none | File/revise the TDS return quoting our PAN and the right section/quarter; issue Form 16A |
| **Excess – books higher than party ledger**: the ledger agrees with 26AS | Us | Dr Customer / Cr TDS Receivable (reverse) and recover the short payment | – |
| **Excess – books at standard rate, deductor applied LDC**: books ≈ 2%, deductor ≈ LDC rate | Us | Dr Customer / Cr TDS Receivable for the differential; recover | – |
| **Excess – not in 26AS at all / awaiting deductor**: no evidence yet | Deductor | none yet. If they confirm no TDS was deducted: reverse and recover. For old FYs: recover or write off | Send ledger + 16A; file/revise the return |
| **26AS status U / O**: challan unmatched / overbooked | Deductor | none | Correction statement / pay the shortfall. U/O credits are not claimable until fixed |
| **Matched ITD – FY mismatch**: total agrees, FYs differ | Us | Dr TDS Receivable FY(26AS) / Cr TDS Receivable FY(books). The ITR claim is FY-wise | – |
| **Unallocated books entries**: Contra, Other receivables, codes | Us | Re-tag to the deductor PAN (reclass within the same GL). The sheet suggests PANs by exact amount | – |
| **Tax adjustment**: refund received / set-off / deposits | – | none. Tie to the ITR/refund workings | – |
| **Timing**: booked after cut-off / return not yet due / TDS on unpaid invoices / 26AS after cut-off | – | none. Re-check next run | – |
| **LDC not applied** (Cut 1) | Deductor | Book what was actually deducted (it is a valid credit) | Apply the certificate rate on all future payments |
| **LDC limit ≥ 80% / expiring ≤ 60 days** | Tax team | – | – (apply for enhancement/renewal) |

**Working-capital cost of an LDC miss** = excess × cost of capital × days from deduction to expected refund (FY end + `refund_lag_months`), less refund interest u/s 244A (0.5% a month from 1 April of the AY). Cost of capital, lag and refund rate are in Settings; set the cost of capital to your treasury rate.

Proposed JEs use the TDS receivable GL most used for that FY and area in your own books (e.g. 269697 for FY 2025-26). Every JE aligns each FY to 26AS; the balancing line goes to the party.

---

## 4. The output workbook

| Tab | Use |
|---|---|
| **Dashboard** | Books vs 26AS by FY; matched / timing / tax adjustments / actionable; status by area (the manual *Status* tab); open actions by owner; LDC cost; movement vs previous run |
| **Action Items** | Start here. One row per task with owner, priority (amount- and age-based), evidence and tracker status |
| **Reco PAN x FY** | The manual layout (Books / 26AS / Variance per FY and ITD), plus subsequent entries, party-ledger and 16A totals, category, action, previous-run variance |
| **Journal Entries** | Entries for us to pass |
| **Deductor Requests** | One ready-to-send e-mail per party |
| **LDC Cut / LDC Lines / LDC Certificates** | Cut 1 against your certificate master |
| **LDC Discovery / LDC Master Suggestions / Rate Profile** | Before the master is filled: deductors who applied an LDC-like rate on some payments and the standard rate on others (strong signal), and certificate rows to verify |
| **Not in Books / Unallocated Books / Timing** | Working lists |
| **Party Ledgers / Ledger TDS Lines / Form 16A / 16A vs 26AS** | Evidence read, and what was picked from it |
| **Unmapped TANs / 26AS Snapshots / GL Accounts / Out of Scope Books / Movement** | Data quality and audit trail |

---

## 5. Tested against the manual file (ZL_26AS_Vs_Books_30June26_ITD_3)

The manual file was split into the drop-folder inputs (26AS details, GL ITD to June, GL Jul–Aug) with a party master seeded from its `26AS_Summary` TAN→PAN mapping:

* Books ITD **₹631,348,244.26**. This agrees with the sum of the manual *As per Books ITD* column (₹631,348,244.71); per-PAN books agree on all but 2 of 2,280 PANs.
* Excess / Short / Cleared status agrees on **2,203 of 2,280 PANs (96.6%)**. 57 of the 61 "manual Cleared / engine Short" cases are ones the GL team marked *Cleared subsequently*. The engine classes most of them as *Timing – booked after cut-off*; the rest need the invoice-level file the manual used, so drop open invoices in `06_AR_Open_Items`.
* 26AS differs on 74 PANs because the manual `26AS_Summary` maps some TANs differently and adjusts some amounts. The engine also brings in 374 26AS-only parties (₹50.7M) the manual list left out, 122 of them *Not accounted in books*.
* **₹364.6M of the −₹355.6M headline variance is income-tax refunds** booked as credits in TDS receivable without a PAN. It is now shown as *Tax adjustment*, not as a deductor gap.
* A full run takes about 45 seconds with cached inputs (about 3 minutes the first time the 16 MB workbook's tabs are read).

## 6. Limits and assumptions

* **TRACES text parser**: built to the published `^`-delimited layout and tested on synthetic files, not a real download. Drop one real `.txt` and check the *26AS Snapshots* tab before relying on it. Excel in the `26AS_details` layout is tested on your data.
* **Standard rates** (Settings > Standard_Rates) are for a company deductee and are used only for the rate checks. Verify them for your periods. New-Act 26AS section codes (1006, 1024 …) map through Settings > Section_Map, seeded from your file's *Old sec* column. 1008/1009 and 1026/1027 map to the generic 194-I / 194J and are not rate-checked until you split them.
* **LDC**: no certificate master was in the manual file, so on your data Cut 1 runs in discovery mode. The indicative figures are only as good as the assumption that a deductor who used a low rate on some payments holds a certificate. Fill `LDC_Certificates.xlsx` for firm numbers.
* **Party ledgers**: formats vary. The reader finds the header (date / narration / debit / credit), picks TDS lines by keywords (TDS, 194x, tax deducted), and is compared only over the FYs the ledger covers. Check *Ledger TDS Lines*; use `_Template_Party_Ledger.xlsx` for odd formats.
* **Form 16A**: text PDFs and TRACES zips (`pip install pypdf`). Key scans into `Form16A_Manual_Entry.xlsx`.
* The ±₹10,000 tolerance, 15-day lag, priorities and keywords are all in Settings.

## 7. Tests

```
python -m unittest discover -s tests
```

`tests/make_synthetic.py` builds a folder that exercises every rule. It covers: an old and a new 26AS download, a TAN-keyed bank, an LDC with an amount limit, a ledger that proves the deductor wrong, a ledger that proves the books wrong, an FY mismatch, a timing item, a refund, a U-status line, overlapping GL dumps, and tracker carry-forward with auto-close.
