"""Cut 2 - Form 26AS vs books (TDS receivable), per party and FY.

Everything except genuine timing differences ends in an action with an
owner: us (a books entry or a PAN tag), the deductor (file/revise its TDS
return, fix a challan, issue Form 16A) or the tax team.
"""
import datetime as dt
import re

import numpy as np
import pandas as pd

from .util import clean, fy_label, fy_of, fy_quarter, is_party_id, return_due_date, stable_id

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct",
                                      "nov", "dec"], 1)}
PERIOD_RX = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*['\-’ ]?\s*(20\d{2}|\d{2})\b",
                       re.I)

WHO_US = "Us - books entry"
WHO_TAG = "Us - tag PAN"
WHO_DED = "Deductor"
WHO_TAX = "Tax team"
WHO_NONE = "No action (timing)"
WHO_OK = "No action"


def period_hint(text, fallback):
    """'TDS Entry - Marketing-July'26' -> 31-Jul-2026. Falls back to the doc date."""
    m = PERIOD_RX.search(clean(text))
    if not m:
        return fallback
    mon = MONTHS[m.group(1).lower()[:3]]
    yr = int(m.group(2))
    yr = yr + 2000 if yr < 100 else yr
    try:
        return pd.Timestamp(dt.date(yr, mon, 1)) + pd.offsets.MonthEnd(0)
    except ValueError:
        return fallback


def _mode_by(df, key, col):
    """Most frequent non-blank value of col per key (vectorised)."""
    v = df[[key, col]].copy()
    v[col] = v[col].map(clean)
    v = v[v[col] != ""]
    if not len(v):
        return pd.Series(dtype=object)
    c = v.groupby([key, col]).size().reset_index(name="n").sort_values("n")
    return c.drop_duplicates(key, keep="last").set_index(key)[col]


class Reco:
    def __init__(self, cfg, gl, tas, snaps, cutoff, party, ledger_lines=None, f16a=None, ar_open=None, ldc_t=None):
        self.cfg, self.gl, self.tas, self.snaps = cfg, gl, tas, snaps
        self.cutoff = pd.Timestamp(cutoff)
        self.party = party
        self.ledger_lines = ledger_lines if ledger_lines is not None else pd.DataFrame()
        self.f16a = f16a if f16a is not None else pd.DataFrame()
        self.ar_open = ar_open if ar_open is not None else pd.DataFrame()
        self.ldc_t = ldc_t
        self.tol = cfg["tolerance"]
        self.fy_from = int(cfg["fy_from"])
        self.fy_to = int(fy_of(self.cutoff))
        self.fys = list(range(self.fy_from, self.fy_to + 1))

    # ------------------------------------------------------------------ split
    def _windows(self):
        gl, c = self.gl, self.cutoff
        in_fy = gl["fy"].between(self.fy_from, self.fy_to) & ~gl["opening"]
        pre = gl["posting_date"].isna() | (gl["posting_date"] <= c)
        self.books = gl[in_fy & pre].copy()
        sub = gl[~pre].copy()
        sub["period"] = [period_hint(t, d if not pd.isna(d) else p) for t, d, p in
                         zip(sub["text"].fillna("") + " " + sub["header_text"].fillna(""), sub["doc_date"],
                             sub["posting_date"])]
        sub["relates_pre_cutoff"] = sub["period"] <= c
        self.books_sub = sub
        self.books_out = gl[~in_fy & pre].copy()
        t = self.tas
        t_in = t["fy"].between(self.fy_from, self.fy_to) & (t["txn_date"].isna() | (t["txn_date"] <= c))
        self.t26 = t[t_in].copy()
        self.t26_sub = t[~t_in & (t["txn_date"] > c)].copy()

    # ------------------------------------------------------------------ build
    def run(self):
        self._windows()
        b = self.books.groupby(["party_key", "fy"])["amount"].sum()
        a = self.t26.groupby(["party_key", "fy"])["tds_deposited"].sum()
        uo = self.t26[self.t26["booking_status"].isin(["U", "O"])].groupby(["party_key", "fy"])["tds_deposited"].sum()
        fyv = pd.concat([b.rename("books"), a.rename("s26"), uo.rename("s26_uo")], axis=1).fillna(0.0).reset_index()
        fyv["fy"] = fyv["fy"].astype(int)
        fyv["variance"] = fyv["books"] - fyv["s26"]
        self.fyv = fyv

        k = fyv.groupby("party_key")[["books", "s26", "s26_uo"]].sum()
        k["variance"] = k["books"] - k["s26"]
        k["sub_books_pre"] = self.books_sub[self.books_sub["relates_pre_cutoff"]].groupby("party_key")["amount"].sum()
        k["sub_books_other"] = self.books_sub[~self.books_sub["relates_pre_cutoff"]].groupby("party_key")["amount"].sum()
        k["sub_26as"] = self.t26_sub.groupby("party_key")["tds_deposited"].sum()
        k = k.fillna(0.0)
        k["delta_after_sub"] = k["variance"] + k["sub_books_pre"] - k["sub_26as"]

        # evidence
        # evidence is compared only over the FYs it covers
        k["ledger_tds"], k["ledger_books"], k["ledger_26as"] = self._covered(
            self.ledger_lines, "tds", "fy") if len(self.ledger_lines) else (np.nan, np.nan, np.nan)
        k["form16a_tds"], k["f16a_books"], k["f16a_26as"] = self._covered(
            self.f16a, "tax_deposited", "fy") if len(self.f16a) and "tax_deposited" in self.f16a \
            else (np.nan, np.nan, np.nan)
        if len(self.ar_open):
            k["open_inv_tds"] = self.ar_open.groupby("party_key")["expected_tds"].sum()
        else:
            k["open_inv_tds"] = np.nan
        k["pending_books"] = self._books_not_yet_due()
        if self.ldc_t is not None and len(self.ldc_t):
            lt = self.ldc_t[self.ldc_t["fy"].between(self.fy_from, self.fy_to) &
                            (self.ldc_t["txn_date"].isna() | (self.ldc_t["txn_date"] <= self.cutoff))]
            k["ldc_excess"] = lt.groupby("party_key")["excess_over_ldc"].sum()
        else:
            k["ldc_excess"] = 0.0

        k = k.reset_index().rename(columns={"index": "party_key"})
        k[["pending_books", "ldc_excess"]] = k[["pending_books", "ldc_excess"]].fillna(0.0)
        self._attach_identity(k)
        self._attach_rates(k)
        rows = [self._classify(r) for r in k.to_dict("records")]
        k = pd.concat([k, pd.DataFrame(rows, index=k.index)], axis=1)
        k["priority"] = [self._priority(r) for r in k.to_dict("records")]
        k["action_id"] = [stable_id(r["party_key"], r["family"]) for r in k.to_dict("records")]
        self.keys = k.sort_values("variance", key=lambda s: -s.abs()).reset_index(drop=True)
        self.journal = self._journals()
        self.extra_actions = self._uo_actions()
        return self

    def _covered(self, ev, amt_col, fy_col):
        """(evidence total, books over the same FYs, 26AS over the same FYs) per party."""
        e = ev[ev[fy_col].between(self.fy_from, self.fy_to) & (ev["party_key"].fillna("") != "")]
        e = e.groupby(["party_key", fy_col])[amt_col].sum().reset_index().rename(columns={fy_col: "fy"})
        e["fy"] = e["fy"].astype(int)
        m = e.merge(self.fyv[["party_key", "fy", "books", "s26"]], on=["party_key", "fy"], how="left").fillna(0.0)
        g = m.groupby("party_key")[[amt_col, "books", "s26"]].sum()
        return g[amt_col], g["books"], g["s26"]

    def _books_not_yet_due(self):
        """Books amount per party in quarters whose 26AS cannot be complete yet."""
        if not len(self.books):
            return pd.Series(dtype=float)
        snap = {}
        if self.snaps is not None and len(self.snaps):
            u = self.snaps[self.snaps["used"]]
            snap = {int(f): pd.Timestamp(d) for f, d in zip(u["fy"], u["snapshot_date"])}
        lag = dt.timedelta(days=int(self.cfg["return_lag_days"]))
        b = self.books
        d = b["doc_date"].fillna(b["posting_date"])
        q = d.map(lambda x: fy_quarter(x) if not pd.isna(x) else 0)
        due = [pd.Timestamp(return_due_date(f, qq)) + lag if qq and not pd.isna(f) else pd.NaT
               for f, qq in zip(b["fy"], q)]
        s = pd.Series(due, index=b.index)
        sd = b["fy"].map(lambda f: snap.get(int(f), pd.Timestamp(dt.date.today())) if not pd.isna(f) else pd.NaT)
        pend = s > sd
        return b[pend].groupby("party_key")["amount"].sum()

    def _attach_identity(self, k):
        pm = self.party
        gname = _mode_by(self.gl, "party_key", "name")
        garea = _mode_by(self.gl, "party_key", "area")
        tname = self.tas.groupby("party_key")["deductor_name"].first()
        tans = self.tas.groupby("party_key")["tan"].agg(lambda s: ", ".join(sorted(set(s))))
        sections = self.t26.assign(sec=self.t26["section_code"].map(self.cfg.old_section)).groupby("party_key")["sec"] \
            .agg(lambda s: ", ".join(sorted(set(s))))
        cust = _mode_by(self.gl, "party_key", "customer")
        k["name"] = [pm.name_of(x) or gname.get(x, "") or tname.get(x, "") for x in k["party_key"]]
        k["name_26as"] = k["party_key"].map(tname).fillna("")
        k["tans"] = k["party_key"].map(tans).fillna("")
        k["sections"] = k["party_key"].map(sections).fillna("")
        k["customer_code"] = k["party_key"].map(cust).fillna("")

        def area(x):
            a = pm.area_of(x) or garea.get(x, "")
            if a:
                return a
            s = sections.get(x, "")
            if s and all(p.strip() in ("193", "194A") for p in s.split(",")):
                return "Treasury"
            if s.startswith("206C"):
                return "AP Trade"
            return "Unassigned"
        k["area"] = k["party_key"].map(area)
        k["owner"] = k["area"].map(self.cfg.owner_for)
        k["allocated"] = k["party_key"].map(is_party_id)
        k["email"] = k["party_key"].map(pm.email_of)

    def _attach_rates(self, k):
        t = self.t26.copy()
        t["sec"] = t["section_code"].map(self.cfg.old_section)
        pos = t[t["amount_paid"] > 0]
        g = pos.groupby("party_key").agg(paid=("amount_paid", "sum"), dep=("tds_deposited", "sum"),
                                         sec=("sec", lambda s: s.mode().iat[0]))
        g["rate_26as"] = g["dep"] / g["paid"]
        rate_by_sec = {s_: self.cfg.std_rate(s_, self.cutoff) for s_ in g["sec"].unique()}
        g["std_rate"] = g["sec"].map(rate_by_sec)
        k["rate_26as"] = k["party_key"].map(g["rate_26as"])
        k["std_rate"] = k["party_key"].map(g["std_rate"])

    # ------------------------------------------------------------ classify
    def _fy_split(self, key):
        if not hasattr(self, "_fysplit"):
            self._fysplit = {}
            for k_, f_, v_ in zip(self.fyv["party_key"], self.fyv["fy"], self.fyv["variance"]):
                self._fysplit.setdefault(k_, {})[int(f_)] = v_
        return self._fysplit.get(key, {})

    def _classify(self, r):
        tol, V, B, A = self.tol, r["variance"], r["books"], r["s26"]
        key = r["party_key"]
        fyvar = self._fy_split(key)
        fy_off = {f: v for f, v in fyvar.items() if abs(v) > tol}
        lg, f16, oi = r["ledger_tds"], r["form16a_tds"], r["open_inv_tds"]
        lB, lA = r["ledger_books"], r["ledger_26as"]    # books / 26AS over the ledger's FYs
        fB = r["f16a_books"]
        near = lambda x, y: (not pd.isna(x)) and (not pd.isna(y)) and abs(x - y) <= tol  # noqa: E731
        fy_txt = ", ".join(f"{fy_label(f)}: {v:,.0f}" for f, v in sorted(fy_off.items()))
        out = dict(status="", category="", family="", who="", action="", evidence="", je=False)

        def res(status, category, family, who, action, evidence="", je=False):
            out.update(status=status, category=category, family=family, who=who, action=action,
                       evidence=evidence, je=je)
            return out

        status = ("Excess in books" if V > tol else "Short in books" if V < -tol else f"Cleared (+/- {tol:,.0f})")
        ev = []
        if not pd.isna(lg):
            ev.append(f"Party ledger TDS {lg:,.0f}")
        if not pd.isna(f16):
            ev.append(f"Form 16A {f16:,.0f}")
        if r["s26_uo"]:
            ev.append(f"26AS U/O {r['s26_uo']:,.0f}")
        evs = "; ".join(ev)

        if not r["allocated"]:
            if any(w in key.lower() for w in self.cfg.adjustment_words()):
                return res(status, "Tax adjustment (refund/set-off)", "TAXADJ", WHO_OK,
                           "Receivable cleared against an income-tax refund or demand for that year. Outside the "
                           "deductor reco - tie it to the ITR/refund workings.")
            if abs(B) <= tol and abs(V) <= tol:
                return res(status, "Unallocated - nets off", "UNALLOC", WHO_OK, "Contra/unallocated lines net to nil.")
            return res(status, "Unallocated books entries", "UNALLOC", WHO_TAG,
                       f"Books carry {B:,.0f} under '{key}' with no deductor PAN. Tag each line to the deductor PAN "
                       "(reclass within the same GL) - see 'Unallocated Books' for amount matches to 26AS parties.",
                       evs, je=False)

        if abs(V) <= tol:
            if fy_off:
                return res(status, "Matched ITD - FY mismatch", "FYRECLASS", WHO_US,
                           f"Total agrees but FYs differ ({fy_txt}). Reclass between FY-wise TDS receivable GLs so "
                           "each FY matches 26AS (the ITR claim is FY-wise).", evs, je=True)
            return res(status, "Matched", "OK", WHO_OK, "")

        # ---- timing: cleared by entries booked after the cut-off
        if V < -tol and abs(V + r["sub_books_pre"]) <= tol:
            return res(status, "Timing - booked after cut-off", "TIMING", WHO_NONE,
                       f"Books caught up after {self.cutoff:%d-%b-%Y} ({r['sub_books_pre']:,.0f}). No entry needed.")
        if V < -tol and r["sub_books_pre"] + r["sub_books_other"] > 0 and \
                abs(V + r["sub_books_pre"] + r["sub_books_other"]) <= tol:
            return res(status, "Timing - probably booked after cut-off", "TIMING", WHO_NONE,
                       f"Entries posted after cut-off ({r['sub_books_pre'] + r['sub_books_other']:,.0f}) clear the gap; "
                       "confirm they relate to periods up to the cut-off.")
        if V > tol and abs(V - r["sub_26as"]) <= tol:
            return res(status, "Timing - 26AS credit after cut-off", "TIMING", WHO_NONE,
                       "Deductor reported it in a later period; 26AS already shows it after the cut-off.")
        if V > tol and r["pending_books"] >= V - tol:
            return res(status, "Timing - deductor return not yet due", "TIMING", WHO_NONE,
                       "Books entries fall in quarters whose TDS return is not yet due/processed. Re-check after "
                       "the next 26AS download.")
        if V < -tol and not pd.isna(oi) and oi >= -V - tol:
            return res(status, "Timing - TDS on unpaid invoices", "TIMING", WHO_NONE,
                       f"Deductor deducted on credit; invoices still open (expected TDS {oi:,.0f}). Book on receipt.")

        # ---- short in books (26AS > books)
        if V < -tol:
            if abs(B) <= tol:
                sec = r["sections"]
                if sec and all(s.strip() in ("193", "194A") for s in sec.split(",")):
                    act = "Book TDS on interest: Dr TDS Receivable (FY) / Cr Interest receivable / income (gross-up)."
                elif sec.startswith("206C"):
                    act = "Book TCS paid to the vendor: Dr TCS Receivable (FY) / Cr Vendor account."
                else:
                    act = ("Book the credit: Dr TDS Receivable (FY) / Cr Customer account. First confirm we have "
                           "revenue with this party - if not, the deductor quoted our PAN wrongly: ask them to "
                           "revise the return and do NOT claim it.")
                return res(status, "Not accounted in books", "NOTINBOOKS", WHO_US, act, evs, je=True)
            if near(lg, lB) and not near(lg, lA):
                return res(status, "Short - 26AS higher than party's own ledger", "SHORT", WHO_DED,
                           "Party ledger agrees with our books; 26AS shows more. Ask the deductor to check PAN "
                           "tagging in its return. Do not book until confirmed.", evs)
            le = r.get("ldc_excess", 0.0) or 0.0
            if le > tol and abs(-V - le) <= max(tol, 0.2 * le):
                return res(status, "Short - deductor above LDC rate, books at LDC rate", "SHORT", WHO_US,
                           f"Deductor deducted {le:,.0f} more than the LDC rate. Book the differential TDS "
                           "(Dr TDS Receivable / Cr Customer) - it is a valid credit - and take up the LDC rate "
                           "with the deductor (see LDC cut).", evs, je=True)
            fy_note = f" FY split: {fy_txt}." if fy_txt else ""
            return res(status, "Short in books - TDS not booked", "SHORT", WHO_US,
                       "Book the missing TDS: Dr TDS Receivable (FY) / Cr Customer. Look for short-payments "
                       f"sitting unapplied in the customer account.{fy_note}", evs, je=True)

        # ---- excess in books (books > 26AS)
        if abs(A) <= tol:
            if near(lg, 0) or (not pd.isna(lg) and lg < lB - tol and near(lg, lA)):
                return res(status, "Excess - party ledger shows no TDS", "EXCESS", WHO_US,
                           "Reverse the TDS receivable (Dr Customer / Cr TDS Receivable) and recover the short "
                           "payment from the party.", evs, je=True)
            return res(status, "Excess - not in 26AS at all", "EXCESS", WHO_DED,
                       "Deductor has not reported this under our PAN. Ask for Form 16A, their ledger and TAN; "
                       "they must file/revise the TDS return quoting our PAN. If they confirm no TDS was "
                       "deducted, reverse and recover.", evs)
        if near(lg, lA) and not near(lg, lB):
            return res(status, "Excess - books higher than party ledger", "EXCESS", WHO_US,
                       "Party ledger agrees with 26AS. Reverse the excess (Dr Customer / Cr TDS Receivable) and "
                       "recover from the party.", evs, je=True)
        r26, sr = r["rate_26as"], r["std_rate"]
        if not pd.isna(r26) and sr and r26 > 0 and r26 < sr * 0.6 and A > 0:
            ratio, expect = B / A, sr / r26
            if abs(ratio - expect) / expect <= 0.2:
                return res(status, "Excess - books at standard rate, deductor applied LDC", "EXCESS", WHO_US,
                           f"Deductor deducted at ~{r26:.2%} but books carry ~{sr:.2%}. Reverse the differential "
                           "(Dr Customer / Cr TDS Receivable) and recover it from the party.", evs, je=True)
        if r["s26_uo"] >= V - tol and r["s26_uo"] > 0:
            return res(status, "Excess - 26AS lines unmatched/overbooked", "EXCESS", WHO_DED,
                       "Deductor's challan is not matched (U) / overbooked (O). Ask them to correct the challan "
                       "details in a correction statement.", evs)
        if near(lg, lB) or near(f16, fB):
            return res(status, "Excess - deductor deducted but not reported", "EXCESS", WHO_DED,
                       "Party ledger / Form 16A support our books. Deductor must file/revise its TDS return "
                       "quoting our PAN and the right section/quarter.", evs)
        old = [f for f in fy_off if f <= self.fy_to - int(self.cfg["old_fy_years"]) and fy_off[f] > 0]
        tail = (" For old FYs (" + ", ".join(fy_label(f) for f in old) + ") consider recovery from the party or "
                "write-off (Dr TDS written off / Cr TDS Receivable) if the deductor will not revise.") if old else ""
        return res(status, "Excess in books - awaiting deductor", "EXCESS", WHO_DED,
                   "Get the party ledger / Form 16A. Deductor to file/revise its return; if they did not deduct, "
                   f"reverse and recover.{tail}", evs)

    def _priority(self, r):
        if r["who"] in (WHO_OK, WHO_NONE):
            return ""
        amt = self._action_amount(r)
        p = "High" if amt >= self.cfg["priority_high"] else "Medium" if amt >= self.cfg["priority_medium"] else "Low"
        fyv = self._fy_split(r["party_key"])
        if p != "High" and any(f <= self.fy_to - int(self.cfg["old_fy_years"]) and abs(v) > self.tol
                               for f, v in fyv.items()):
            p = {"Low": "Medium", "Medium": "High"}[p]
        return p

    def _action_amount(self, r):
        if r["family"] == "UNALLOC":
            return abs(r["books"])
        if r["family"] == "FYRECLASS":
            return sum(v for v in self._fy_split(r["party_key"]).values() if v > 0)
        return abs(r["variance"])

    # ------------------------------------------------------------ journals
    def _gl_for(self, fy, area):
        """Most-used TDS receivable GL for this FY (and area), from the books."""
        if not hasattr(self, "_glpick"):
            b = self.gl[self.gl["allocated"] & self.gl["fy"].notna()].copy()
            b["gl_code"], b["gl_text"] = b["gl_code"].map(clean), b["gl_text"].map(clean)
            c = b.groupby(["fy", "area", "gl_code", "gl_text"], dropna=False).size().reset_index(name="n")
            c = c.sort_values("n")
            self._glpick = {(int(f), a): (g, t) for f, a, g, t in zip(c["fy"], c["area"], c["gl_code"], c["gl_text"])}
            cf = b.groupby(["fy", "gl_code", "gl_text"]).size().reset_index(name="n").sort_values("n")
            self._glpick_fy = {int(f): (g, t) for f, g, t in zip(cf["fy"], cf["gl_code"], cf["gl_text"])}
        return self._glpick.get((int(fy), area)) or self._glpick_fy.get(int(fy), ("", ""))

    def _journals(self):
        rows = []
        for r in self.keys[self.keys["je"]].to_dict("records"):
            fyv = self._fy_split(r["party_key"])
            adj = {f: -v for f, v in fyv.items() if abs(v) >= 1}
            if r["family"] == "EXCESS" and "LDC" in r["category"]:
                adj = {f: -v for f, v in fyv.items() if v > 1}
            if not adj:
                continue
            je_id = f"JE-{r['action_id']}"
            party_line = -sum(adj.values())
            cp = (f"Customer {r['customer_code']} - {r['name']}" if r["customer_code"] else f"Party {r['name']}")
            if "interest" in r["action"].lower():
                cp = f"Interest receivable/income - {r['name']}"
            elif "TCS" in r["action"]:
                cp = f"Vendor - {r['name']}"
            for f, v in sorted(adj.items()):
                gl_code, gl_text = self._gl_for(f, r["area"])
                rows.append({"JE ID": je_id, "Action ID": r["action_id"], "PAN/TAN": r["party_key"],
                             "Party": r["name"], "Area": r["area"], "FY": fy_label(f),
                             "Account": f"{gl_code} {gl_text}".strip() or "TDS Receivable",
                             "Debit": v if v > 0 else 0.0, "Credit": -v if v < 0 else 0.0,
                             "Line text": f"26AS reco {self.cutoff:%b-%y}: {r['category']}", "Category": r["category"]})
            if abs(party_line) >= 1:
                rows.append({"JE ID": je_id, "Action ID": r["action_id"], "PAN/TAN": r["party_key"],
                             "Party": r["name"], "Area": r["area"], "FY": "", "Account": cp,
                             "Debit": party_line if party_line > 0 else 0.0,
                             "Credit": -party_line if party_line < 0 else 0.0,
                             "Line text": f"26AS reco {self.cutoff:%b-%y}: {r['category']}", "Category": r["category"]})
        return pd.DataFrame(rows)

    def _uo_actions(self):
        """26AS lines in status U/O: never creditable until the deductor fixes them."""
        uo = self.t26[self.t26["booking_status"].isin(["U", "O"])]
        if not len(uo):
            return pd.DataFrame()
        g = uo.groupby(["party_key", "tan", "deductor_name", "booking_status"]).agg(
            lines=("tds_deposited", "size"), tds=("tds_deposited", "sum"),
            fys=("fy", lambda s: ", ".join(fy_label(f) for f in sorted(set(s))))).reset_index()
        g = g[g["tds"].abs() >= 1]
        g["action"] = np.where(g["booking_status"] == "U",
                               "Unmatched: deductor's challan does not match its return. Deductor to correct challan "
                               "details (correction statement) so the credit becomes Final.",
                               "Overbooked: deductor claimed more against the challan than it paid. Deductor to pay "
                               "the balance or correct the statement.")
        return g

    # ------------------------------------------------------------ views
    def unallocated(self):
        u = self.books[~self.books["allocated"]].copy()
        if not len(u):
            return pd.DataFrame(), pd.DataFrame()
        summ = (u.groupby(["party_key", "fy", "gl_code"], dropna=False)
                .agg(lines=("amount", "size"), amount=("amount", "sum")).reset_index())
        # amount matches against 26AS-side gaps (not accounted / short)
        gaps = self.keys[self.keys["family"].isin(["NOTINBOOKS", "SHORT"])][["party_key", "name"]]
        cand = self.t26[self.t26["party_key"].isin(gaps["party_key"])]
        amap = {}
        for key, fy, amt in zip(cand["party_key"], cand["fy"], cand["tds_deposited"].round(2)):
            amap.setdefault(amt, set()).add((key, fy))
        fymap = self.fyv[self.fyv["party_key"].isin(gaps["party_key"])]
        for key, fy, v in zip(fymap["party_key"], fymap["fy"], (-fymap["variance"]).round(2)):
            amap.setdefault(v, set()).add((key, fy))
        sugg = []
        for amt in u["amount"].round(2):
            m = amap.get(amt) if abs(amt) >= 1000 else None
            sugg.append(", ".join(f"{k} ({fy_label(f)})" for k, f in sorted(m))[:200] if m else "")
        u["suggested_pan_by_amount"] = sugg
        cols = ["party_key", "fy", "gl_code", "gl_text", "doc_no", "posting_date", "doc_type", "amount", "text",
                "name", "customer", "supplier", "user", "suggested_pan_by_amount", "source_file"]
        return summ, u[cols].sort_values("amount", key=lambda s: -s.abs())

    def not_in_books(self):
        k = self.keys[self.keys["family"] == "NOTINBOOKS"]["party_key"]
        t = self.t26[self.t26["party_key"].isin(k)]
        return (t.groupby(["fy", "deductor_name", "party_key", "tan"])
                .agg(amount_paid=("amount_paid", "sum"), tds=("tds_deposited", "sum"), lines=("tds_deposited", "size"))
                .reset_index().sort_values("tds", ascending=False))
