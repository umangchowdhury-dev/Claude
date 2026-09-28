"""Books loader: TDS/TCS receivable GL line items (SAP FBL3N / FAGLL03 style
exports, or any Excel/CSV with the same columns) from 02_Books_GL/.

Drop full inception-to-date dumps or monthly increments; overlapping lines
are de-duplicated. The FY a line belongs to (for claiming TDS) is taken from
a 'Fiscal' column when present, else the FY on the GL account in
Settings > GL_Accounts, else the document date.
"""
import os
import re

import numpy as np
import pandas as pd

from .util import (PAN_ANY, TAN_ANY, clean, find_header_row, frame_from_raw, fy_series, is_party_id, is_tan,
                   pick_col, read_any, to_date, to_num)

ALIASES = {
    "company_code": ["Company Code"],
    "gl_code": ["G/L Account", "GL Account", "GL Code", "Account"],
    "gl_text": ["G/L Account: Long Text", "G/L Acct Long Text", "GL Description", "Account Name"],
    "fy_col": ["Fiscal", "FY", "Fiscal Year"],
    "amount": ["Amount", "Company Code Currency Value", "Amount in Local Currency", "Amount in LC",
               "Amount in Company Code Currency", "Value"],
    "doc_no": ["Document Number", "DocumentNo", "Doc No", "Voucher No"],
    "posting_date": ["Posting Date", "Pstng Date", "Voucher Date"],
    "entry_date": ["Entry Date"],
    "doc_type": ["Document Type", "Doc Type", "Type"],
    "doc_date": ["Document Date", "Doc Date"],
    "text": ["Text", "Item Text", "Narration", "Line Item Text"],
    "pan_col": ["PAN", "Party PAN", "Deductor PAN"],
    "area_col": ["Area"],
    "name": ["Name", "Party Name"],
    "customer": ["Customer"],
    "customer_name": ["Customer Account: Name 1", "Customer Name"],
    "supplier": ["Supplier", "Vendor"],
    "supplier_name": ["Vendor Account: Name 1", "Supplier Name", "Vendor Name"],
    "header_text": ["Document Header Text", "Header Text"],
    "user": ["User Name", "User"],
    "reference": ["Reference"],
}


def parse_gl_file(path):
    frames = []
    for sheet, raw in read_any(path).items():
        h = find_header_row(raw, [ALIASES["gl_code"], ALIASES["amount"], ALIASES["posting_date"]])
        if h is None:
            continue
        df = frame_from_raw(raw, h)
        out = pd.DataFrame(index=df.index)
        for k, al in ALIASES.items():
            c = pick_col(df.columns, al)
            out[k] = df[c] if c is not None else None
        out = out[out["amount"].notna() & (out["gl_code"].notna() | out["gl_text"].notna())]
        out["amount"] = to_num(out["amount"])
        for c in ("posting_date", "doc_date", "entry_date"):
            out[c] = to_date(out[c])
        out["sheet"] = sheet
        frames.append(out)
    if not frames:
        return pd.DataFrame(columns=list(ALIASES) + ["sheet"])
    return pd.concat(frames, ignore_index=True)


def _dedupe(frames):
    keyed = []
    for df in frames:
        df = df.copy()
        dk = (df["gl_code"].map(clean) + "|" + df["doc_no"].map(clean) + "|" + df["amount"].round(2).astype(str)
              + "|" + df["posting_date"].astype(str) + "|" + df["text"].map(clean) + "|" + df["company_code"].map(clean))
        df["_dk"] = dk
        df["_n"] = df.groupby("_dk").cumcount()
        keyed.append(df)
    allr = pd.concat(keyed, ignore_index=True)
    before = len(allr)
    allr = allr.drop_duplicates(["_dk", "_n"], keep="first").drop(columns=["_dk", "_n"])
    return allr, before - len(allr)


def load_gl(paths, cache, cfg, party):
    frames = []
    for p in paths:
        df = cache.get(p, lambda p=p: parse_gl_file(p))
        if df is None or not len(df):
            continue
        df = df.copy()
        df["source_file"] = os.path.basename(p)
        frames.append(df)
    if not frames:
        return pd.DataFrame(), 0
    gl, dupes = _dedupe(frames)

    # ---- FY the TDS belongs to
    fy_col = pd.to_numeric(gl["fy_col"], errors="coerce")
    gl["opening"] = gl["fy_col"].map(lambda x: "opening" in clean(x).lower())
    glmap = cfg.gl_accounts
    fy_gl = pd.Series(np.nan, index=gl.index)
    if len(glmap) and "FY" in glmap:
        m = {clean(r["GL Code"]): pd.to_numeric(r["FY"], errors="coerce") for _, r in glmap.iterrows()}
        fy_gl = gl["gl_code"].map(lambda c: m.get(clean(c), np.nan)).astype(float)
    fy_date = pd.Series(fy_series(gl["doc_date"].fillna(gl["posting_date"])), index=gl.index)
    gl["fy"] = fy_col.fillna(fy_gl).fillna(fy_date)
    gl.loc[gl["opening"], "fy"] = np.nan
    gl["fy_source"] = np.where(fy_col.notna(), "Fiscal column", np.where(fy_gl.notna(), "GL account", "Doc date"))

    # ---- party key
    gl["party_key"], gl["key_source"] = zip(*gl.apply(lambda r: _party_key(r, party), axis=1))
    # books sometimes carry the deductor's TAN (banks): resolve it like 26AS does
    gl["party_key"] = gl["party_key"].map(lambda k: party.key_for_tan(k) if is_tan(k) else k)
    gl["allocated"] = gl["party_key"].map(is_party_id)

    # ---- area
    area = gl["area_col"].map(clean).replace({"0": "", "#N/A": "", "nan": ""})
    pm_area = gl["party_key"].map(party.area_of)
    gl["area"] = area.where(area != "", pm_area)
    gl["name"] = gl["name"].map(clean)
    gl["name"] = gl["name"].where(gl["name"] != "", gl["customer_name"].map(clean))
    gl["name"] = gl["name"].where(gl["name"] != "", gl["supplier_name"].map(clean))
    return gl, dupes


def _party_key(r, party):
    v = clean(r["pan_col"]).upper()
    if is_party_id(v):
        return v, "PAN column"
    for code_col in ("customer", "supplier"):
        k = party.key_for_code(r[code_col])
        if k:
            return k, f"{code_col} code"
    if v:
        k = party.key_for_code(v)
        if k:
            return k, "PAN column (code)"
    for t in ("text", "header_text", "reference"):
        s = clean(r[t]).upper()
        m = PAN_ANY.search(s) or TAN_ANY.search(s)
        if m:
            return m.group(1), f"{t} regex"
    if v:
        return clean(r["pan_col"]).title(), "PAN column (not a PAN)"
    return "UNALLOCATED", "none"


def gl_accounts_seen(gl):
    """Unique GL accounts in the data with FY / Area guessed from the long text."""
    if gl is None or not len(gl):
        return pd.DataFrame()
    t = gl.groupby(["gl_code"], dropna=False).agg(Description=("gl_text", "first"), Lines=("amount", "size"),
                                                   Balance=("amount", "sum")).reset_index()
    t = t.rename(columns={"gl_code": "GL Code"})

    def fy_from_text(s):
        m = re.search(r"FY\s*(20\d{2})", clean(s), re.I)
        return int(m.group(1)) if m else None
    t["FY (guessed)"] = t["Description"].map(fy_from_text)
    return t
