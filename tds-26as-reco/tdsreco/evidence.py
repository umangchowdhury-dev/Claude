"""Evidence from counter-parties: their ledger of our account (the 'vendor
ledger' they send) and the TDS certificates (Form 16A) they issue.

Both are optional. When present they decide who has to act on a mismatch:
  party ledger = 26AS  != our books  -> our books are wrong (we pass the entry)
  party ledger = books != 26AS       -> deductor has not reported/deposited it right
  Form 16A     != 26AS               -> deductor revised or mis-filed its return
"""
import difflib
import io
import os
import re
import zipfile

import numpy as np
import pandas as pd

from .masters import norm_name
from .util import (PAN_ANY, TAN_ANY, clean, find_header_row, frame_from_raw, fy_series, fy_quarter, pick_col,
                   read_any, to_date, to_num)

TDS_RX = re.compile(r"\bT\.?\s?D\.?\s?S\b|TAX\s+DEDUCTED|\b19[234][A-Z0-9()\-]*\b|\bTCS\b|206C|WITHHOLDING", re.I)

L_DATE = ["Date", "Voucher Date", "Posting Date", "Doc Date", "Document Date", "Txn Date", "Transaction Date"]
L_NARR = ["Particulars", "Narration", "Description", "Text", "Remarks", "Details", "Voucher Type", "Vch Type"]
L_DR = ["Debit", "Dr", "Debit Amount", "Debit (Rs)", "Dr Amount", "Withdrawal"]
L_CR = ["Credit", "Cr", "Credit Amount", "Credit (Rs)", "Cr Amount"]
L_AMT = ["Amount", "Amount (Rs)", "Value"]
L_TDS = ["TDS", "TDS Amount", "TDS Deducted", "Tax Deducted"]
L_BAL = ["Balance", "Closing Balance", "Running Balance"]


# ------------------------------------------------------------ party identity
def identify_party(path, raw_top_text, party, gl_names, company_pan):
    name = os.path.basename(path).upper()
    for rx in (PAN_ANY, TAN_ANY):
        for m in rx.finditer(name):
            if m.group(1) != company_pan:
                return party.key_for_tan(m.group(1)), "file name"
    for rx in (PAN_ANY, TAN_ANY):
        for m in rx.finditer(raw_top_text.upper()):
            if m.group(1) != company_pan:
                return party.key_for_tan(m.group(1)), "inside file"
    stem = norm_name(re.sub(r"(LEDGER|STATEMENT|ACCOUNT|RECO|FY|20\d\d|\d+)", " ", os.path.splitext(name)[0]))
    if stem and gl_names:
        m = difflib.get_close_matches(stem, list(gl_names.keys()), n=1, cutoff=0.75)
        if m:
            return gl_names[m[0]], "name match"
        for n, k in gl_names.items():  # short file names: 'HUL.xlsx' style prefixes
            if len(stem) >= 4 and n.startswith(stem):
                return k, "name prefix"
    return "", "unidentified"


# ------------------------------------------------------------ party ledgers
def parse_party_ledger(path, party, gl_names, company_pan):
    lines, info = [], {"file": os.path.basename(path), "party_key": "", "matched_by": "", "status": "",
                       "rows": 0, "tds_lines": 0, "from": None, "to": None, "closing_balance": np.nan}
    try:
        sheets = read_any(path)
    except Exception as e:  # noqa: BLE001 - report and move on
        info["status"] = f"unreadable: {e}"
        return pd.DataFrame(), info
    top = " ".join(clean(v) for raw in sheets.values() for v in raw.head(15).values.ravel())
    info["party_key"], info["matched_by"] = identify_party(path, top, party, gl_names, company_pan)
    for sheet, raw in sheets.items():
        h = find_header_row(raw, [L_DATE, L_DR + L_AMT + L_TDS, L_NARR])
        if h is None:
            continue
        df = frame_from_raw(raw, h)
        c_date, c_narr = pick_col(df.columns, L_DATE), pick_col(df.columns, L_NARR)
        c_dr, c_cr, c_amt = pick_col(df.columns, L_DR), pick_col(df.columns, L_CR), pick_col(df.columns, L_AMT)
        c_tds, c_bal = pick_col(df.columns, L_TDS), pick_col(df.columns, L_BAL)
        d = pd.DataFrame({"date": to_date(df[c_date]) if c_date else pd.NaT,
                          "narration": df[c_narr].map(clean) if c_narr else ""})
        d = d[d["date"].notna()]
        df = df.loc[d.index]
        info["rows"] += len(d)
        if c_tds and c_tds not in (c_dr, c_cr, c_amt):
            d["tds"] = to_num(df[c_tds])
            d = d[d["tds"] != 0]
        else:
            amt = (to_num(df[c_dr]) - (to_num(df[c_cr]) if c_cr else 0)) if c_dr else to_num(df[c_amt])
            d["tds"] = amt
            d = d[d["narration"].map(lambda s: bool(TDS_RX.search(s))) & (d["tds"] != 0)]
        if c_bal:
            b = to_num(df[c_bal])
            b = b[b != 0]
            if len(b):
                info["closing_balance"] = b.iloc[-1]
        d["sheet"] = sheet
        lines.append(d)
    if not lines:
        info["status"] = "no ledger table found - use the template columns"
        return pd.DataFrame(), info
    d = pd.concat(lines, ignore_index=True)
    info["from"], info["to"] = (d["date"].min(), d["date"].max()) if len(d) else (None, None)
    if len(d) and d["tds"].sum() < 0:  # ledger exported from the other side: flip
        d["tds"] = -d["tds"]
    d["fy"] = fy_series(d["date"])
    d["file"] = info["file"]
    d["party_key"] = info["party_key"]
    info["tds_lines"] = len(d)
    info["status"] = "ok" if info["party_key"] else "party not identified - put the PAN/TAN in the file name"
    return d, info


def load_party_ledgers(paths, party, gl, company_pan):
    gl_names = {}
    if gl is not None and len(gl):
        for k, n in gl.groupby("party_key")["name"].first().items():
            if n:
                gl_names.setdefault(norm_name(n), k)
    for k, n in party._name.items():
        if n:
            gl_names.setdefault(norm_name(n), k)
    lines, infos = [], []
    for p in paths:
        d, info = parse_party_ledger(p, party, gl_names, company_pan)
        info["received_on"] = pd.Timestamp(os.path.getmtime(p), unit="s").normalize()
        infos.append(info)
        if len(d):
            lines.append(d)
    return (pd.concat(lines, ignore_index=True) if lines else pd.DataFrame(columns=["party_key", "fy", "tds"]),
            pd.DataFrame(infos))


# ------------------------------------------------------------ Form 16A
Q_ROW = re.compile(r"\b(Q[1-4])\b\s+(\S+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})")
AY_RX = re.compile(r"Assessment\s+Year\s*[:\-]?\s*(20\d{2})\s*-\s*\d{2,4}", re.I)
CERT_RX = re.compile(r"Certificate\s+No\.?\s*[:\-]?\s*([A-Z0-9]{5,})", re.I)


def _pdf_text(data):
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    r = PdfReader(io.BytesIO(data))
    if r.is_encrypted:
        try:
            r.decrypt("")
        except Exception:  # noqa: BLE001
            return ""
    return "\n".join((pg.extract_text() or "") for pg in r.pages)


def parse_16a_text(text, fname, company_pan):
    tans = [t for t in TAN_ANY.findall(text)]
    ay = AY_RX.search(text)
    cert = CERT_RX.search(text)
    pans = set(PAN_ANY.findall(text))
    base = {"file": fname, "tan": tans[0] if tans else "", "fy": int(ay.group(1)) - 1 if ay else np.nan,
            "certificate_no": cert.group(1) if cert else "",
            "deductee_pan_ok": (company_pan in pans) if company_pan else None}
    rows = []
    for m in Q_ROW.finditer(text):
        rows.append({**base, "quarter": int(m.group(1)[1]), "receipt_no": m.group(2),
                     "amount_paid": to_num(m.group(3)), "tax_deducted": to_num(m.group(4)),
                     "tax_deposited": to_num(m.group(5)), "parse_status": "ok"})
    if not rows:
        rows.append({**base, "quarter": np.nan, "receipt_no": "", "amount_paid": 0.0, "tax_deducted": 0.0,
                     "tax_deposited": 0.0, "parse_status": "could not read quarter table - enter in "
                                                            "Form16A_Manual_Entry.xlsx"})
    return rows


def load_form16a(paths, company_pan, key_for_tan):
    rows = []
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        fname = os.path.basename(p)
        if ext == ".pdf":
            with open(p, "rb") as fh:
                txt = _pdf_text(fh.read())
            if txt is None:
                rows.append({"file": fname, "parse_status": "pip install pypdf to read PDFs"})
                continue
            rows += parse_16a_text(txt, fname, company_pan)
        elif ext == ".zip":
            with zipfile.ZipFile(p) as z:
                for n in z.namelist():
                    if n.lower().endswith(".pdf"):
                        try:
                            txt = _pdf_text(z.read(n))
                        except RuntimeError:
                            txt = ""
                        rows += parse_16a_text(txt or "", f"{fname}/{n}", company_pan)
        elif ext in (".xlsx", ".xls", ".csv"):
            for _, raw in read_any(p).items():
                h = find_header_row(raw, [["TAN"], ["FY", "Financial Year"], ["Tax Deposited", "Tax Deducted"]])
                if h is None:
                    continue
                df = frame_from_raw(raw, h)
                c = lambda al: pick_col(df.columns, al)  # noqa: E731
                for _, r in df.iterrows():
                    tan = clean(r[c(["TAN"])]).upper()
                    if not tan:
                        continue
                    fy = re.match(r"(20\d{2})", clean(r[c(["FY", "Financial Year"])]))
                    q = re.search(r"([1-4])", clean(r[c(["Quarter"])]) if c(["Quarter"]) else "")
                    rows.append({"file": fname, "tan": tan, "fy": int(fy.group(1)) if fy else np.nan,
                                 "quarter": int(q.group(1)) if q else np.nan,
                                 "certificate_no": clean(r[c(["Certificate No"])]) if c(["Certificate No"]) else "",
                                 "amount_paid": to_num(r[c(["Amount Paid"])]) if c(["Amount Paid"]) else 0.0,
                                 "tax_deducted": to_num(r[c(["Tax Deducted"])]) if c(["Tax Deducted"]) else 0.0,
                                 "tax_deposited": to_num(r[c(["Tax Deposited", "Tax Deducted"])]),
                                 "parse_status": "manual entry"})
    df = pd.DataFrame(rows)
    if len(df):
        df["party_key"] = df["tan"].fillna("").map(key_for_tan)
    return df


def f16a_vs_26as(f16a, tas):
    """Quarter-level compare of certificate amounts with 26AS for that TAN."""
    if f16a is None or not len(f16a) or "tax_deposited" not in f16a:
        return pd.DataFrame()
    f = f16a[f16a["quarter"].notna() & f16a["fy"].notna()].copy()
    if not len(f):
        return pd.DataFrame()
    f = f.groupby(["party_key", "tan", "fy", "quarter"], as_index=False).agg(
        form16a_tds=("tax_deposited", "sum"), certificates=("certificate_no", lambda s: ", ".join(sorted(set(s)))))
    t = tas.copy()
    t["quarter"] = t["txn_date"].map(lambda d: fy_quarter(d) if not pd.isna(d) else np.nan)
    t = t.groupby(["tan", "fy", "quarter"], as_index=False).agg(tds_26as=("tds_deposited", "sum"))
    m = f.merge(t, on=["tan", "fy", "quarter"], how="left").fillna({"tds_26as": 0.0})
    m["difference"] = m["form16a_tds"] - m["tds_26as"]
    m["result"] = np.where(m["difference"].abs() <= 1, "Matches 26AS",
                           np.where(m["difference"] > 0, "16A higher - deductor return not processed/revised",
                                    "26AS higher - ask for revised 16A"))
    return m
