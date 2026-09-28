"""Party master (03_Masters/Party_Master.xlsx).

26AS identifies a deductor by TAN; the books identify the party by PAN or
customer/vendor code. The master joins them:
  TAN_Map : TAN -> PAN (Status Confirmed / Suggested). Only Confirmed rows
            are used in the reco; Suggested rows are the engine's name-match
            guesses waiting for a human to confirm.
  Parties : PAN -> name, Area, customer codes, vendor codes, e-mail, owner.
The run appends new TANs/PANs it sees so the master keeps growing by itself.
"""
import difflib
import os
import re

import pandas as pd

from .util import clean, is_pan, is_tan

TAN_COLS = ["TAN", "PAN", "Deductor Name", "Status", "Source"]
PARTY_COLS = ["PAN", "Party Name", "Area", "Customer Codes", "Vendor Codes", "Email", "Owner"]

STOP = re.compile(r"\b(PRIVATE|PVT|LIMITED|LTD|LLP|INDIA|THE|CO|COMPANY|AND|OF|INC|CORPORATION|CORP)\b")


def norm_name(s):
    s = re.sub(r"[^A-Z0-9 ]", " ", clean(s).upper())
    s = STOP.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


class PartyMaster:
    def __init__(self, root):
        self.path = os.path.join(root, "03_Masters", "Party_Master.xlsx")
        self.tan_map = pd.DataFrame(columns=TAN_COLS)
        self.parties = pd.DataFrame(columns=PARTY_COLS)
        if os.path.exists(self.path):
            xl = pd.read_excel(self.path, sheet_name=None, dtype=object)
            if "TAN_Map" in xl:
                self.tan_map = xl["TAN_Map"].reindex(columns=TAN_COLS)
            if "Parties" in xl:
                self.parties = xl["Parties"].reindex(columns=PARTY_COLS)
        self._index()

    def _index(self):
        tm = self.tan_map.copy()
        tm["TAN"] = tm["TAN"].map(lambda x: clean(x).upper())
        conf = tm[tm["Status"].map(lambda s: clean(s).lower() in ("", "confirmed")) & tm["PAN"].map(is_pan)]
        self._tan2pan = dict(zip(conf["TAN"], conf["PAN"].map(lambda x: clean(x).upper())))
        self._known_tans = set(tm["TAN"])
        self._code2key, self._area, self._name, self._email = {}, {}, {}, {}
        for _, r in self.parties.iterrows():
            k = clean(r["PAN"]).upper()
            if not k:
                continue
            self._area[k] = clean(r["Area"])
            self._name[k] = clean(r["Party Name"])
            self._email[k] = clean(r["Email"])
            for col in ("Customer Codes", "Vendor Codes"):
                for code in re.split(r"[,;\s]+", clean(r[col])):
                    if code:
                        self._code2key[code.upper()] = k

    # lookups -------------------------------------------------------------
    def key_for_tan(self, tan):
        t = clean(tan).upper()
        return self._tan2pan.get(t, t)

    def key_for_code(self, code):
        c = clean(code).upper()
        return self._code2key.get(c) if c else None

    def area_of(self, key):
        return self._area.get(clean(key).upper(), "")

    def name_of(self, key):
        return self._name.get(clean(key).upper(), "")

    def email_of(self, key):
        return self._email.get(clean(key).upper(), "")

    # learning -------------------------------------------------------------
    def suggest_unmapped(self, tas, gl, threshold):
        """For TANs with no confirmed PAN, suggest one by matching the 26AS
        deductor name against party names seen in the books."""
        if tas is None or not len(tas):
            return pd.DataFrame(columns=["TAN", "Deductor Name", "Suggested PAN", "Matched Name", "Score", "TDS"])
        un = tas[~tas["tan"].isin(self._tan2pan.keys())]
        un = un.groupby("tan").agg(name=("deductor_name", "first"), tds=("tds_deposited", "sum")).reset_index()
        cands = {}
        if gl is not None and len(gl):
            g = gl[gl["party_key"].map(is_pan)]
            for k, n in g.groupby("party_key")["name"].agg(lambda s: s.mode().iat[0] if len(s.mode()) else "").items():
                if n:
                    cands.setdefault(norm_name(n), k)
        for k, n in self._name.items():
            if n and is_pan(k):
                cands.setdefault(norm_name(n), k)
        names = list(cands.keys())
        out = []
        for _, r in un.iterrows():
            nn = norm_name(r["name"])
            best, score = None, 0.0
            if nn in cands:
                best, score = nn, 1.0
            elif nn:
                m = difflib.get_close_matches(nn, names, n=1, cutoff=threshold)
                if m:
                    best, score = m[0], difflib.SequenceMatcher(None, nn, m[0]).ratio()
            out.append({"TAN": r["tan"], "Deductor Name": r["name"],
                        "Suggested PAN": cands.get(best, "") if best else "",
                        "Matched Name": best or "", "Score": round(score, 2), "TDS": r["tds"]})
        return pd.DataFrame(out).sort_values("TDS", ascending=False)

    def write_back(self, tas, gl, suggestions):
        """Append new TANs (with suggestions) and new PANs so the master grows."""
        tm = self.tan_map.copy()
        known = set(tm["TAN"].map(lambda x: clean(x).upper()))
        add = []
        if suggestions is not None and len(suggestions):
            for _, r in suggestions.iterrows():
                if r["TAN"] in known:
                    continue
                add.append({"TAN": r["TAN"], "PAN": r["Suggested PAN"], "Deductor Name": r["Deductor Name"],
                            "Status": "Suggested" if r["Suggested PAN"] else "Unmapped",
                            "Source": f"name match {r['Score']}" if r["Suggested PAN"] else "new in 26AS"})
        if add:
            tm = pd.concat([tm, pd.DataFrame(add)], ignore_index=True)
        pt = self.parties.copy()
        have = set(pt["PAN"].map(lambda x: clean(x).upper()))
        newp = []
        if gl is not None and len(gl):
            g = gl[gl["party_key"].map(lambda k: is_pan(k) or is_tan(k)) & ~gl["party_key"].isin(have)]
            for k, grp in g.groupby("party_key"):
                nm = grp["name"].replace("", pd.NA).dropna()
                ar = grp["area"].replace("", pd.NA).dropna()
                cust = sorted({clean(c) for c in grp["customer"].dropna() if clean(c)})[:5]
                vend = sorted({clean(c) for c in grp["supplier"].dropna() if clean(c)})[:5]
                newp.append({"PAN": k, "Party Name": nm.mode().iat[0] if len(nm) else "",
                             "Area": ar.mode().iat[0] if len(ar) else "",
                             "Customer Codes": ", ".join(cust), "Vendor Codes": ", ".join(vend)})
        if newp:
            pt = pd.concat([pt, pd.DataFrame(newp)], ignore_index=True)
        if not add and not newp:
            return 0, 0
        try:
            with pd.ExcelWriter(self.path, engine="openpyxl") as w:
                tm.to_excel(w, sheet_name="TAN_Map", index=False)
                pt.to_excel(w, sheet_name="Parties", index=False)
        except PermissionError:
            print(f"  ! Could not update {self.path} (open in Excel?). Close it and re-run to save new parties.")
            return 0, 0
        return len(add), len(newp)
