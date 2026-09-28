"""Small helpers shared by every module: PAN/TAN checks, Indian FY maths,
header detection and tolerant number/date parsing."""
import datetime as dt
import hashlib
import os
import re

import numpy as np
import pandas as pd

PAN_RE = re.compile(r"^[A-Z]{5}\d{4}[A-Z]$")
TAN_RE = re.compile(r"^[A-Z]{4}\d{5}[A-Z]$")
PAN_ANY = re.compile(r"\b([A-Z]{5}\d{4}[A-Z])\b")
TAN_ANY = re.compile(r"\b([A-Z]{4}\d{5}[A-Z])\b")


def clean(s):
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    return str(s).strip()


def is_pan(s):
    return bool(PAN_RE.match(clean(s).upper()))


def is_tan(s):
    return bool(TAN_RE.match(clean(s).upper()))


def is_party_id(s):
    return is_pan(s) or is_tan(s)


# ---------------------------------------------------------------- FY maths
def fy_of(d):
    """Indian FY start year: 15-Jun-2025 -> 2025 (FY 2025-26)."""
    if d is None or pd.isna(d):
        return np.nan
    return d.year if d.month >= 4 else d.year - 1


def fy_series(s):
    s = pd.to_datetime(s, errors="coerce")
    return np.where(s.dt.month >= 4, s.dt.year, s.dt.year - 1).astype("float")


def fy_label(fy):
    try:
        fy = int(fy)
    except (TypeError, ValueError):
        return str(fy)
    return f"FY {fy}-{str(fy + 1)[-2:]}"


def fy_quarter(d):
    """1..4 within the Indian FY (Apr-Jun = Q1)."""
    return ((d.month - 4) % 12) // 3 + 1


def quarter_end(fy, q):
    fy, q = int(fy), int(q)
    return {1: dt.date(fy, 6, 30), 2: dt.date(fy, 9, 30),
            3: dt.date(fy, 12, 31), 4: dt.date(fy + 1, 3, 31)}[q]


def return_due_date(fy, q):
    """Due date of the deductor's quarterly TDS statement (24Q/26Q)."""
    fy, q = int(fy), int(q)
    return {1: dt.date(fy, 7, 31), 2: dt.date(fy, 10, 31),
            3: dt.date(fy + 1, 1, 31), 4: dt.date(fy + 1, 5, 31)}[q]


def latest_settled_quarter_end(as_of, lag_days):
    """Last quarter end whose TDS-return due date + lag is on/before as_of.
    That is the natural reco cut-off: everything up to it should be in 26AS."""
    as_of = pd.Timestamp(as_of).date()
    fy = fy_of(as_of)
    best = None
    for f in range(fy - 3, fy + 1):
        for q in (1, 2, 3, 4):
            if return_due_date(f, q) + dt.timedelta(days=lag_days) <= as_of:
                qe = quarter_end(f, q)
                if best is None or qe > best:
                    best = qe
    return best


# ------------------------------------------------------------ parsing
def norm_header(s):
    return re.sub(r"[^a-z0-9]", "", clean(s).lower())


def pick_col(columns, aliases):
    """Return the real column name matching the first alias (normalised)."""
    lookup = {norm_header(c): c for c in columns}
    for a in aliases:
        n = norm_header(a)
        if n in lookup:
            return lookup[n]
    for a in aliases:  # prefix match as a fallback ("Amount Paid / Credited(Rs.)")
        n = norm_header(a)
        for k, c in lookup.items():
            if n and k.startswith(n):
                return c
    return None


def find_header_row(raw, must_any, max_rows=40):
    """Index of the first row that contains at least len(must_any) groups.
    must_any is a list of alias-lists; each group must match some cell."""
    best, best_hits = None, 0
    for i in range(min(max_rows, len(raw))):
        cells = [norm_header(v) for v in raw.iloc[i].tolist()]
        hits = 0
        for group in must_any:
            if any(any(norm_header(a) == c or (len(norm_header(a)) > 3 and c.startswith(norm_header(a)))
                       for c in cells) for a in group):
                hits += 1
        if hits > best_hits:
            best, best_hits = i, hits
        if hits == len(must_any):
            return i
    return best if best_hits >= max(2, len(must_any) - 1) else None


def frame_from_raw(raw, header_row):
    df = raw.iloc[header_row + 1:].copy()
    cols, seen = [], {}
    for c in raw.iloc[header_row].tolist():
        c = clean(c) or "_blank"
        if c in seen:
            seen[c] += 1
            c = f"{c}.{seen[c]}"
        else:
            seen[c] = 0
        cols.append(c)
    df.columns = cols
    df = df.loc[:, [c for c in df.columns if not c.startswith("_blank")]]
    return df.dropna(how="all").reset_index(drop=True)


def to_num(s):
    if isinstance(s, pd.Series):
        if pd.api.types.is_numeric_dtype(s):
            return s.astype(float).fillna(0.0)
        return s.map(_num_one).astype(float)
    return _num_one(s)


def _num_one(v):
    if v is None:
        return 0.0
    if isinstance(v, (int, float, np.integer, np.floating)):
        return 0.0 if pd.isna(v) else float(v)
    t = str(v).strip().replace(",", "").replace("₹", "").replace("Rs.", "")
    if not t or t in ("-", "--"):
        return 0.0
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    sign = 1.0
    if t.upper().endswith("CR"):
        t, sign = t[:-2], -1.0
    elif t.upper().endswith("DR"):
        t = t[:-2]
    try:
        x = float(t) * sign
    except ValueError:
        return 0.0
    return -x if neg else x


def to_date(s):
    if isinstance(s, pd.Series):
        if pd.api.types.is_datetime64_any_dtype(s):
            return s
        num = pd.to_numeric(s, errors="coerce")
        out = pd.to_datetime(s.where(num.isna()), errors="coerce", dayfirst=True, format="mixed")
        serial = pd.to_datetime(num.where((num > 20000) & (num < 80000)), unit="D", origin="1899-12-30",
                                errors="coerce")
        return out.fillna(serial)
    return pd.to_datetime(s, errors="coerce", dayfirst=True)


def read_any(path):
    """Return {sheet_name: raw DataFrame (no header)} for xlsx/xls/csv/txt."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv",):
        return {"csv": pd.read_csv(path, header=None, dtype=object, keep_default_na=False, na_values=[""])}
    if ext in (".xlsx", ".xlsm", ".xls"):
        return pd.read_excel(path, sheet_name=None, header=None, dtype=object)
    raise ValueError(f"Unsupported file type: {path}")


def file_sig(path):
    st = os.stat(path)
    return hashlib.md5(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()


def date_from_filename(name):
    """Pick a date out of a file name: 2026-09-15, 20260915, 15-09-2026, 15Sep26..."""
    pats = [(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})", "ymd"),
            (r"(\d{2})[-_.](\d{2})[-_.](20\d{2})", "dmy")]
    for p, kind in pats:
        m = re.search(p, name)
        if m:
            try:
                a, b, c = (int(g) for g in m.groups())
                return dt.date(a, b, c) if kind == "ymd" else dt.date(c, b, a)
            except ValueError:
                pass
    return None


def stable_id(*parts):
    return hashlib.sha1("|".join(clean(p) for p in parts).encode()).hexdigest()[:10].upper()


def list_inputs(folder, exts):
    if not os.path.isdir(folder):
        return []
    out = []
    for root, _, files in os.walk(folder):
        for f in sorted(files):
            if f.startswith(("~$", ".", "_")):
                continue  # temp/lock files and our own templates
            if os.path.splitext(f)[1].lower() in exts:
                out.append(os.path.join(root, f))
    return out
