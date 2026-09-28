"""Settings live in 00_Config/Settings.xlsx so the finance team can change
them without touching code. This module holds the defaults and loads the file."""
import datetime as dt
import os

import pandas as pd

from .util import clean, to_date

# key: (default, description)
DEFAULTS = {
    "company_name": ("", "Your company name (used in e-mail drafts)."),
    "company_pan": ("", "Your PAN - the deductee PAN every deductor must quote."),
    "fy_from": (2023, "First FY (start year) in scope. 2023 = FY 2023-24."),
    "reco_cutoff_date": ("", "Books and 26AS are compared up to this date. Blank = automatic: the last "
                              "quarter-end whose TDS-return due date + lag has passed on the latest 26AS download."),
    "return_lag_days": (15, "Days after the TDS-return due date before a credit is expected in 26AS."),
    "tolerance": (10000, "Variance (Rs) per party, inception-to-date, treated as cleared."),
    "ldc_rate_slack": (0.0002, "Rate headroom for rounding before a deduction counts as above the LDC rate "
                               "(0.0002 = 0.02 percentage points)."),
    "cost_of_capital": (0.10, "Annual cost of funds used to value money blocked by excess TDS. SET THIS."),
    "refund_lag_months": (18, "Months after FY end until excess TDS normally comes back as an ITR refund."),
    "refund_interest_rate": (0.06, "Interest the department pays on refunds (sec 244A: 0.5% a month). "
                                   "It offsets the working-capital cost. Set 0 to ignore."),
    "priority_high": (1000000, "Action amount (Rs) at or above which priority = High."),
    "priority_medium": (100000, "Action amount (Rs) at or above which priority = Medium."),
    "old_fy_years": (2, "FYs older than this many years get a priority bump and a write-off fallback."),
    "ldc_exhaustion_warn": (0.8, "Warn when this share of an LDC certificate's amount limit is used."),
    "adjustment_keywords": ("refund, income tax, set off, setoff, adjusted against, demand, self assessment, "
                            "deposits made to govt, paid to authorities",
                            "Books lines without a PAN whose tag contains any of these words are treated as tax "
                            "adjustments (refund received / set-off against demand), not deductor differences."),
    "name_match_threshold": (0.88, "Similarity (0-1) needed to auto-suggest a PAN for an unmapped TAN."),
}

# 26AS section code -> section used for rates/LDC. New-Act codes (1006, 1024 ...)
# are seeded from the manual reco file's own "Old sec" mapping.
DEFAULT_SECTION_MAP = [
    ("193", "193"), ("194A", "194A"), ("194C", "194C"), ("194H", "194H"), ("194I(a)", "194I(a)"),
    ("194I(b)", "194I(b)"), ("194IC", "194IC"), ("194J", "194J"), ("194JA", "194JA"), ("194JB", "194JB"),
    ("194O", "194O"), ("194Q", "194Q"), ("194R", "194R"), ("206CR", "206CR"), ("206CM", "206CM"),
    ("194-I", "194-I"), ("1006", "194H"), ("1008", "194-I"), ("1009", "194-I"), ("1021", "194A"),
    ("1022", "194A"), ("1023", "194C"), ("1024", "194C"), ("1026", "194J"), ("1027", "194J"),
    ("1031", "194Q"), ("1033", "194R"),
]

# Standard rate for a company deductee with a valid PAN. Verify against the
# law for your periods - the file is editable. Blank rate = not checked.
DEFAULT_STANDARD_RATES = [
    ("193", 0.10, "", ""), ("194A", 0.10, "", ""), ("194C", 0.02, "", ""),
    ("194H", 0.05, "", "2024-09-30"), ("194H", 0.02, "2024-10-01", ""),
    ("194I(a)", 0.02, "", ""), ("194I(b)", 0.10, "", ""), ("194IC", 0.10, "", ""),
    ("194JA", 0.02, "", ""), ("194JB", 0.10, "", ""),
    ("194O", 0.01, "", "2024-09-30"), ("194O", 0.001, "2024-10-01", ""),
    ("194Q", 0.001, "", ""), ("194R", 0.10, "", ""), ("206CR", 0.001, "", "2025-03-31"),
]

AREA_KEYWORDS = [  # GL long text -> Area, used when GL_Accounts has no Area
    ("monet", "Only Monet"), ("bfd", "Only BFD"), ("arb2b", "AR B2B"), ("ar b2b", "AR B2B"),
    ("fd", "Treasury"), ("bond", "Treasury"), ("ncd", "Treasury"), ("treasury", "Treasury"),
]


class Config:
    def __init__(self, root):
        self.root = root
        self.path = os.path.join(root, "00_Config", "Settings.xlsx")
        self.values = {k: v[0] for k, v in DEFAULTS.items()}
        self.gl_accounts = pd.DataFrame(columns=["GL Code", "Description", "FY", "Area", "Kind", "Use for JE"])
        self.section_map = pd.DataFrame(DEFAULT_SECTION_MAP, columns=["26AS Section", "Section"])
        self.std_rates = pd.DataFrame(DEFAULT_STANDARD_RATES,
                                      columns=["Section", "Standard Rate", "Effective From", "Effective To"])
        self.owners = pd.DataFrame(columns=["Area", "Owner", "Email"])
        if os.path.exists(self.path):
            self._load()

    def _load(self):
        xl = pd.read_excel(self.path, sheet_name=None, dtype=object)
        if "Settings" in xl:
            for _, r in xl["Settings"].iterrows():
                k = clean(r.get("Key"))
                if k in self.values and clean(r.get("Value")) != "":
                    self.values[k] = r.get("Value")
        if "GL_Accounts" in xl:
            self.gl_accounts = xl["GL_Accounts"]
        if "Section_Map" in xl and len(xl["Section_Map"]):
            self.section_map = xl["Section_Map"]
        if "Standard_Rates" in xl and len(xl["Standard_Rates"]):
            self.std_rates = xl["Standard_Rates"]
        if "Owners" in xl:
            self.owners = xl["Owners"]

    def __getitem__(self, k):
        v = self.values[k]
        d = DEFAULTS[k][0]
        if isinstance(d, (int, float)) and not isinstance(d, bool):
            try:
                return type(d)(float(v))
            except (TypeError, ValueError):
                return d
        return v

    def cutoff_override(self):
        v = self.values.get("reco_cutoff_date")
        if clean(v) == "":
            return None
        d = to_date(pd.Series([v])).iloc[0]
        return None if pd.isna(d) else d.date()

    # ---------------------------------------------------------------- lookups
    def old_section(self, code):
        if not hasattr(self, "_secmap"):
            self._secmap = dict(zip(self.section_map["26AS Section"].map(clean), self.section_map["Section"].map(clean)))
        c = clean(code)
        return self._secmap.get(c, c)

    def std_rate(self, section, on_date):
        t = self.std_rates
        rows = t[t["Section"].map(clean) == clean(section)]
        d = pd.Timestamp(on_date) if on_date is not None and not pd.isna(on_date) else None
        for _, r in rows.iterrows():
            f = to_date(pd.Series([r["Effective From"]])).iloc[0] if clean(r["Effective From"]) else None
            e = to_date(pd.Series([r["Effective To"]])).iloc[0] if clean(r["Effective To"]) else None
            if d is not None and ((f is not None and d < f) or (e is not None and d > e)):
                continue
            try:
                return float(r["Standard Rate"])
            except (TypeError, ValueError):
                return None
        return None

    def adjustment_words(self):
        return [w.strip().lower() for w in str(self.values["adjustment_keywords"]).split(",") if w.strip()]

    def owner_for(self, area):
        if not hasattr(self, "_owner_cache"):
            self._owner_cache = {}
        if area not in self._owner_cache:
            self._owner_cache[area] = self._owner_for(area)
        return self._owner_cache[area]

    def _owner_for(self, area):
        t = self.owners
        if len(t):
            hit = t[t["Area"].map(clean) == clean(area)]
            if len(hit):
                return clean(hit.iloc[0]["Owner"]) or f"{area} team"
        return f"{area} team" if clean(area) else "GL team"


def today():
    return dt.date.today()
