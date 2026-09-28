"""Form 26AS loader.

Accepts, from 01_26AS/ (any number of files, any FYs, dropped over time):
  * TRACES text download (.txt, '^' delimited), one FY per file
  * Excel/CSV in the transaction-detail layout (FY, Section, Name, TAN,
    Transaction Date, Status of Booking, Date of Booking, Remarks,
    Amount Paid / Credited, Tax Deducted, TDS Deposited). This is the layout
    of the '26AS_details' tab in the manual reco.

Every (file, FY) is a snapshot dated by the date in the file name, else the
file-creation date inside a TRACES text file, else the latest booking date,
else the file's modified time. For each FY the newest snapshot wins; older
ones are kept so the run can show what changed since the previous download.
"""
import datetime as dt
import os
import re

import pandas as pd

from .util import (TAN_RE, clean, date_from_filename, find_header_row, frame_from_raw, fy_series,
                   pick_col, read_any, to_date, to_num)

COLS = ["source_file", "snapshot_date", "fy", "part", "section_code", "deductor_name", "tan", "txn_date",
        "booking_status", "booking_date", "remarks", "amount_paid", "tax_deducted", "tds_deposited"]

ALIASES = {
    "fy": ["FY", "Financial Year"],
    "section_code": ["Section"],
    "deductor_name": ["Name of Deductor", "Name of Collector", "Name", "Deductor Name"],
    "tan": ["TAN of Deductor", "TAN of Collector", "TAN"],
    "txn_date": ["Transaction Date"],
    "booking_status": ["Status of Booking"],
    "booking_date": ["Date of Booking"],
    "remarks": ["Remarks"],
    "amount_paid": ["Amount Paid / Credited(Rs.)", "Amount Paid / Credited", "Amount Paid/Debited",
                    "Amount Paid", "Taxable amount"],
    "tax_deducted": ["Tax Deducted(Rs.)", "Tax Deducted", "Tax Collected"],
    "tds_deposited": ["TDS Deposited(Rs.)", "TDS Deposited", "TCS Deposited", "Tax Deposited"],
}


def _part_kind(line):
    u = line.upper()
    if not u.startswith("PART"):
        return None
    if "COLLECTED AT SOURCE" in u:
        return "TCS"
    if "DEDUCTED AT SOURCE" in u and not any(k in u for k in ("15G", "15H", "194IA", "194IB", "194M", "194S",
                                                                 "PROVISO", "BUYER", "TENANT")):
        return "TDS"
    return "SKIP"


def parse_traces_text(path):
    """Parse the TRACES 26AS text download. Returns a DataFrame in COLS."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = [ln.rstrip("\r\n") for ln in fh]
    fy, created = None, None
    part, deductor, tan = None, "", ""
    rows = []
    for ln in lines:
        f = [x.strip() for x in ln.split("^")]
        u = ln.upper()
        if fy is None and "FINANCIAL YEAR" in u:
            for i, x in enumerate(f):
                if x.upper().startswith("FINANCIAL YEAR") and i + 1 < len(f):
                    m = re.match(r"(20\d{2})", f[i + 1])
                    if m:
                        fy = int(m.group(1))
        if fy is None and "ASSESSMENT YEAR" in u:
            for i, x in enumerate(f):
                if x.upper().startswith("ASSESSMENT YEAR") and i + 1 < len(f):
                    m = re.match(r"(20\d{2})", f[i + 1])
                    if m:
                        fy = int(m.group(1)) - 1
        if created is None and ("FILE CREATION DATE" in u or "DATA UPDATED TILL" in u):
            d = to_date(pd.Series([f[1] if len(f) > 1 else ""])).iloc[0]
            if not pd.isna(d):
                created = d.date()
        k = _part_kind(ln.strip())
        if k:
            part = k
            continue
        if part not in ("TDS", "TCS"):
            continue
        # deductor summary line: SrNo ^ Name ^ TAN ^ ... totals
        if len(f) >= 3 and f[0].isdigit() and TAN_RE.match(f[2].upper()):
            deductor, tan = f[1], f[2].upper()
            continue
        # transaction line: '' ^ SrNo ^ Section ^ TxnDate ^ Status ^ BookingDate ^ Remarks ^ Amt ^ Ded ^ Dep
        if len(f) >= 10 and f[0] == "" and f[1].isdigit() and tan:
            rows.append({
                "part": part, "section_code": f[2], "deductor_name": deductor, "tan": tan,
                "txn_date": f[3], "booking_status": f[4], "booking_date": f[5], "remarks": f[6],
                "amount_paid": f[7], "tax_deducted": f[8], "tds_deposited": f[9],
            })
    df = pd.DataFrame(rows, columns=[c for c in COLS if c not in ("source_file", "snapshot_date", "fy")])
    df["txn_date"] = to_date(df["txn_date"])
    df["booking_date"] = to_date(df["booking_date"])
    for c in ("amount_paid", "tax_deducted", "tds_deposited"):
        df[c] = to_num(df[c])
    df["fy"] = fy if fy is not None else fy_series(df["txn_date"])
    snap = date_from_filename(os.path.basename(path)) or created
    df["snapshot_date"] = snap
    return df


def parse_detail_table(path):
    frames = []
    for sheet, raw in read_any(path).items():
        h = find_header_row(raw, [ALIASES["tan"], ALIASES["txn_date"], ALIASES["tds_deposited"]])
        if h is None:
            continue
        df = frame_from_raw(raw, h)
        out = pd.DataFrame(index=df.index)
        for k, al in ALIASES.items():
            c = pick_col(df.columns, al)
            out[k] = df[c] if c is not None else None
        out = out[out["tan"].map(lambda x: bool(TAN_RE.match(clean(x).upper())))]
        out["tan"] = out["tan"].map(lambda x: clean(x).upper())
        out["txn_date"] = to_date(out["txn_date"])
        out["booking_date"] = to_date(out["booking_date"])
        for c in ("amount_paid", "tax_deducted", "tds_deposited"):
            out[c] = to_num(out[c])
        fy = pd.to_numeric(out["fy"].map(lambda x: re.match(r"(20\d{2})", clean(x)).group(1)
                                         if re.match(r"(20\d{2})", clean(x)) else None), errors="coerce")
        out["fy"] = fy.fillna(pd.Series(fy_series(out["txn_date"]), index=out.index))
        out["part"] = out["section_code"].map(lambda s: "TCS" if clean(s).upper().startswith("206C") else "TDS")
        out["snapshot_date"] = date_from_filename(os.path.basename(path))
        frames.append(out)
    if not frames:
        return pd.DataFrame(columns=COLS)
    return pd.concat(frames, ignore_index=True)


def load_26as(paths, cache):
    """Load every 26AS file. Returns (latest_rows, snapshot_table, all_rows)."""
    frames = []
    for p in paths:
        df = cache.get(p, lambda p=p: parse_traces_text(p) if p.lower().endswith(".txt") else parse_detail_table(p))
        if df is None or not len(df):
            continue
        df = df.copy()
        df["source_file"] = os.path.basename(p)
        mtime = dt.date.fromtimestamp(os.path.getmtime(p))
        if df["snapshot_date"].isna().all():
            bd = df["booking_date"].max()
            df["snapshot_date"] = bd.date() if not pd.isna(bd) else mtime
        df["mtime"] = os.path.getmtime(p)
        frames.append(df)
    if not frames:
        empty = pd.DataFrame(columns=COLS)
        return empty, pd.DataFrame(), empty
    allr = pd.concat(frames, ignore_index=True)
    allr["fy"] = allr["fy"].astype(int)
    allr["section_code"] = allr["section_code"].map(clean)
    snaps = (allr.groupby(["fy", "source_file", "snapshot_date", "mtime"], as_index=False)
             .agg(rows=("tds_deposited", "size"), tds_deposited=("tds_deposited", "sum"),
                  last_booking=("booking_date", "max")))
    snaps = snaps.sort_values(["fy", "snapshot_date", "mtime"])
    snaps["used"] = False
    snaps.loc[snaps.groupby("fy").tail(1).index, "used"] = True
    use = snaps[snaps["used"]][["fy", "source_file"]]
    latest = allr.merge(use, on=["fy", "source_file"])
    # previous snapshot per FY (for "new since last download")
    prev = snaps[~snaps["used"]].groupby("fy").tail(1)[["fy", "source_file"]]
    previous = allr.merge(prev, on=["fy", "source_file"])
    snaps = snaps.drop(columns=["mtime"])
    return latest.drop(columns=["mtime"]), snaps, previous.drop(columns=["mtime"])
