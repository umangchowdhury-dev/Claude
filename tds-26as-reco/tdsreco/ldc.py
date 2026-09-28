"""Cut 1 - Lower Deduction Certificate (LDC) rate vs the rate the deductor
actually applied.

Money deducted above the LDC rate is blocked until the income-tax refund
arrives. That is a working-capital loss even though the credit is not lost.
Inputs: the 26AS transaction lines and 03_Masters/LDC_Certificates.xlsx.
Without a master the cut still runs a 'discovery' pass: it finds the
sub-standard rates deductors are using (the fingerprint of your LDCs) and
suggests master rows for you to verify against the real certificates.
"""
import datetime as dt
import os

import numpy as np
import pandas as pd

from .util import clean, fy_quarter, to_date, to_num

LDC_COLS = ["Certificate No", "Deductor TAN", "Deductor Name", "Section", "LDC Rate (%)", "Valid From",
            "Valid To", "Amount Limit (Rs)", "Remarks"]


def load_ldc_master(root):
    p = os.path.join(root, "03_Masters", "LDC_Certificates.xlsx")
    if not os.path.exists(p):
        return pd.DataFrame(columns=LDC_COLS)
    df = pd.read_excel(p, sheet_name=0, dtype=object).reindex(columns=LDC_COLS)
    df = df[df["Section"].map(clean) != ""].copy()
    df["tan"] = df["Deductor TAN"].map(lambda x: clean(x).upper() or "ALL")
    df["section"] = df["Section"].map(clean)
    df["rate"] = to_num(df["LDC Rate (%)"]) / 100.0
    df["from"] = to_date(df["Valid From"])
    df["to"] = to_date(df["Valid To"])
    lim = to_num(df["Amount Limit (Rs)"])
    df["limit"] = lim.where(lim > 0, np.inf)
    df["cert"] = df["Certificate No"].map(clean)
    df.loc[df["cert"] == "", "cert"] = [f"ROW{i + 2}" for i in df.index[df["cert"] == ""]]
    return df.reset_index(drop=True)


def std_rates_vector(cfg, sections, dates):
    out = pd.Series(np.nan, index=sections.index)
    t = cfg.std_rates
    for _, r in t.iterrows():
        rate = pd.to_numeric(r["Standard Rate"], errors="coerce")
        if pd.isna(rate):
            continue
        m = sections == clean(r["Section"])
        f = to_date(pd.Series([r["Effective From"]])).iloc[0] if clean(r["Effective From"]) else None
        e = to_date(pd.Series([r["Effective To"]])).iloc[0] if clean(r["Effective To"]) else None
        if f is not None and not pd.isna(f):
            m &= dates >= f
        if e is not None and not pd.isna(e):
            m &= dates <= e
        out[m & out.isna()] = float(rate)
    return out


def _refund_date(fy, months):
    base = pd.Timestamp(dt.date(int(fy) + 1, 3, 31))
    return base + pd.DateOffset(months=int(months))


def run_ldc(tas, cfg, ldc, key_for_tan):
    t = tas.copy()
    t["section"] = t["section_code"].map(cfg.old_section)
    t["rate"] = np.where(t["amount_paid"] != 0, t["tds_deposited"] / t["amount_paid"].replace(0, np.nan), np.nan)
    t["std_rate"] = std_rates_vector(cfg, t["section"], t["txn_date"])
    t["party_key"] = t["tan"].map(key_for_tan)
    t = t.sort_values(["txn_date", "booking_date"]).reset_index(drop=True)

    # ---- attach certificate + consumption against its amount limit
    t["cert"], t["ldc_rate"], t["covered_amt"] = "", np.nan, 0.0
    util = []
    if len(ldc):
        for _, c in ldc.iterrows():
            m = (t["section"] == c["section"]) & (t["txn_date"] >= c["from"]) & (t["txn_date"] <= c["to"])
            m &= (t["tan"] == c["tan"]) if c["tan"] != "ALL" else True
            m &= t["cert"] == ""  # first matching certificate wins
            idx = t.index[m]
            if not len(idx):
                util.append({**_cert_info(c), "Amount Consumed (Rs)": 0.0, "Lines": 0})
                continue
            amt = t.loc[idx, "amount_paid"]
            cum_after = amt.cumsum()
            cum_before = cum_after - amt
            covered = np.clip(np.minimum(cum_after, c["limit"]) - np.minimum(cum_before, c["limit"]), 0, None)
            covered = np.where(amt < 0, amt, covered)  # reversals give back what they took
            t.loc[idx, "cert"] = c["cert"]
            t.loc[idx, "ldc_rate"] = c["rate"]
            t.loc[idx, "covered_amt"] = covered
            util.append({**_cert_info(c), "Amount Consumed (Rs)": float(np.sum(covered)), "Lines": len(idx)})

    slack = cfg["ldc_rate_slack"]
    has = t["cert"] != ""
    uncovered = t["amount_paid"] - t["covered_amt"]
    std = t["std_rate"]
    exp_uncov = np.where(std.notna(), uncovered * std, np.where(t["amount_paid"] != 0,
                                                                 uncovered * t["rate"].fillna(0), 0))
    t["expected_tds"] = np.where(has, t["covered_amt"] * t["ldc_rate"] + exp_uncov, np.nan)
    diff = t["tds_deposited"] - t["expected_tds"]
    tol = (t["amount_paid"].abs() * slack) + 1.0
    t["excess_over_ldc"] = np.where(has & (diff > tol), diff, 0.0)
    t["short_vs_ldc"] = np.where(has & (diff < -tol), -diff, 0.0)

    # ---- statutory-rate check (lines with no LDC)
    over_std = (~has) & std.notna() & (t["rate"] > std + slack) & (t["amount_paid"] > 0)
    t["excess_over_std"] = np.where(over_std, t["tds_deposited"] - t["amount_paid"] * std, 0.0)
    t["flag"] = ""
    t.loc[has & (t["excess_over_ldc"] > 0), "flag"] = "Deducted above LDC rate"
    t.loc[has & (t["short_vs_ldc"] > 0), "flag"] = "Deducted below LDC rate"
    t.loc[has & (t["covered_amt"] < t["amount_paid"]) & (t["amount_paid"] > 0) & (t["flag"] == ""),
          "flag"] = "LDC limit exhausted - standard rate"
    t.loc[over_std, "flag"] = "Above statutory rate (206AA/206AB or error)"
    t.loc[(t["rate"] >= 0.99) & (t["amount_paid"] > 0), "flag"] = "Rate ~100% - deductor reporting error"

    # ---- working-capital cost of the excess
    coc, rint, lag = cfg["cost_of_capital"], cfg["refund_interest_rate"], cfg["refund_lag_months"]
    rd = t["fy"].map(lambda f: _refund_date(f, lag))
    ay_start = t["fy"].map(lambda f: pd.Timestamp(dt.date(int(f) + 1, 4, 1)))
    blocked = (rd - t["txn_date"]).dt.days.clip(lower=0)
    int_days = (rd - ay_start).dt.days.clip(lower=0)
    t["blocked_days"] = np.where(t["excess_over_ldc"] > 0, blocked, 0)
    t["wc_cost_gross"] = t["excess_over_ldc"] * coc * blocked / 365.0
    t["refund_interest"] = t["excess_over_ldc"] * rint * int_days / 365.0
    t["wc_cost_net"] = t["wc_cost_gross"] - t["refund_interest"]

    lines = t[t["flag"] != ""].copy()
    summary = (t[has].groupby(["party_key", "tan", "deductor_name", "section", "fy", "cert", "ldc_rate"],
                              dropna=False)
               .agg(lines=("tds_deposited", "size"), amount_paid=("amount_paid", "sum"),
                    tds_deposited=("tds_deposited", "sum"), expected_tds=("expected_tds", "sum"),
                    excess=("excess_over_ldc", "sum"), short=("short_vs_ldc", "sum"),
                    wc_cost_net=("wc_cost_net", "sum"), lines_above=("excess_over_ldc", lambda s: int((s > 0).sum())),
                    first_above=("txn_date", "min"), last_txn=("txn_date", "max"))
               .reset_index()) if has.any() else pd.DataFrame()
    utilisation = pd.DataFrame(util)
    if len(utilisation):
        utilisation["% Used"] = np.where(np.isfinite(utilisation["Amount Limit (Rs)"]),
                                         utilisation["Amount Consumed (Rs)"] / utilisation["Amount Limit (Rs)"], np.nan)
        today = pd.Timestamp(dt.date.today())
        utilisation["Days to Expiry"] = (pd.to_datetime(utilisation["Valid To"]) - today).dt.days
        warn = cfg["ldc_exhaustion_warn"]
        utilisation["Alert"] = np.select(
            [utilisation["% Used"] >= 1, utilisation["% Used"] >= warn,
             (utilisation["Days to Expiry"] >= 0) & (utilisation["Days to Expiry"] <= 60),
             utilisation["Lines"] == 0],
            ["Limit exhausted - apply for enhancement", f"Over {int(warn * 100)}% used - apply for enhancement",
             "Expires within 60 days - apply for renewal", "No 26AS lines under this certificate - check TAN/section"],
            default="")
        utilisation["Amount Limit (Rs)"] = utilisation["Amount Limit (Rs)"].replace(np.inf, np.nan)
    return t, lines, summary, utilisation


def _cert_info(c):
    return {"Certificate No": c["cert"], "Deductor TAN": c["tan"], "Section": c["section"],
            "LDC Rate (%)": c["rate"] * 100, "Valid From": c["from"], "Valid To": c["to"],
            "Amount Limit (Rs)": c["limit"]}


def discovery(t, ldc):
    """Find the LDC fingerprint in 26AS and quantify deductors still at the
    standard rate in the same section/quarter. Indicative only."""
    d = t[(t["amount_paid"] > 0) & t["std_rate"].notna() & t["rate"].between(0, 0.5)].copy()
    if not len(d):
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
    d["q"] = d["txn_date"].map(lambda x: f"FY{int(x.year if x.month >= 4 else x.year - 1)}-Q{fy_quarter(x)}"
                               if not pd.isna(x) else "")
    d["r"] = d["rate"].round(4)
    d["low"] = d["r"] < d["std_rate"] * 0.75
    prof = (d.groupby(["section", "q", "r"]).agg(lines=("r", "size"), deductors=("tan", "nunique"),
                                                 amount_paid=("amount_paid", "sum"),
                                                 tds=("tds_deposited", "sum"), std_rate=("std_rate", "first"))
            .reset_index())
    prof["share_of_lines"] = prof["lines"] / prof.groupby(["section", "q"])["lines"].transform("sum")
    probable = prof[(prof["r"] < prof["std_rate"] * 0.75) & (prof["deductors"] >= 3) & (prof["share_of_lines"] >= 0.05)]
    ldc_rate = probable.groupby(["section", "q"])["r"].min().rename("probable_ldc_rate")
    prof = prof.merge(ldc_rate, on=["section", "q"], how="left")

    # strong signal: the SAME deductor used a low rate on some payments and the standard rate on others
    # in the same section and FY -> it very likely holds our certificate but did not apply it throughout.
    own = (d[d["low"]].groupby(["tan", "section", "fy"])["r"].agg(lambda s: s.mode().iat[0])
           .rename("probable_ldc_rate").reset_index())
    at_std = d[(~d["low"]) & (d["cert"] == "")].merge(own, on=["tan", "section", "fy"])
    at_std["indicative_excess"] = at_std["tds_deposited"] - at_std["amount_paid"] * at_std["probable_ldc_rate"]
    at_std = at_std[at_std["indicative_excess"] > 1]
    ind = (at_std.groupby(["party_key", "tan", "deductor_name", "section", "fy"])
           .agg(lines=("r", "size"), amount_paid=("amount_paid", "sum"), tds_deposited=("tds_deposited", "sum"),
                applied_rate=("r", "median"), probable_ldc_rate=("probable_ldc_rate", "min"),
                indicative_excess=("indicative_excess", "sum"))
           .reset_index().sort_values("indicative_excess", ascending=False))
    known = set(zip(ldc["tan"], ldc["section"])) if len(ldc) else set()
    sug = (d[d["low"]].groupby(["tan", "deductor_name", "section", "fy"])
           .agg(observed_rate=("r", lambda s: s.mode().iat[0]), from_date=("txn_date", "min"),
                to_date=("txn_date", "max"), amount_paid=("amount_paid", "sum"), lines=("r", "size"))
           .reset_index())
    sug = sug[[(a, b) not in known for a, b in zip(sug["tan"], sug["section"])]]
    return prof, ind, sug.sort_values("amount_paid", ascending=False)
