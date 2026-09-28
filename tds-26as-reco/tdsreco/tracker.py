"""Carry-forward of human follow-up between runs, and run history.

91_Tracker/Action_Tracker.xlsx is the one file people edit: Status, Remarks,
Assigned To, Next Follow-up. Every run refreshes the computed columns,
keeps what people typed, adds new items and auto-closes items the new data
shows as cleared. 99_History keeps a snapshot per run for the
'movement vs previous run' view.
"""
import datetime as dt
import glob
import json
import os

import numpy as np
import pandas as pd

from .util import clean

USER_COLS = ["Status", "Remarks", "Assigned To", "Next Follow-up", "Updated By"]
SYS_COLS = ["Action ID", "PAN/TAN", "Party", "Area", "Owner", "Who Acts", "Category", "Action", "Priority",
            "Amount (this run)", "Amount (first seen)", "First Seen", "Last Seen", "System Status"]
STATUS_CHOICES = ["New", "Mail sent to party", "Entry to be taken", "Entry passed", "Partial payment received",
                  "Disputed", "Write-off proposed", "Resolved"]


def tracker_path(root):
    return os.path.join(root, "91_Tracker", "Action_Tracker.xlsx")


def load_tracker(root):
    p = tracker_path(root)
    if os.path.exists(p):
        try:
            return pd.read_excel(p, sheet_name="Tracker", dtype=object)
        except ValueError:
            pass
    return pd.DataFrame(columns=SYS_COLS + USER_COLS)


def merge_tracker(old, actions, run_date):
    """actions: DataFrame with the SYS_COLS computed for this run (no dates)."""
    run = pd.Timestamp(run_date)
    old = old.copy()
    old["Action ID"] = old["Action ID"].map(clean)
    cur = actions.set_index("Action ID")
    rows = []
    seen = set()
    for _, o in old.iterrows():
        aid = o["Action ID"]
        if aid in cur.index:
            c = cur.loc[aid]
            new = o.to_dict()
            for col in ["PAN/TAN", "Party", "Area", "Owner", "Who Acts", "Category", "Action", "Priority",
                        "Amount (this run)"]:
                new[col] = c[col]
            new["Last Seen"] = run
            done = clean(o.get("Status")).lower() == "resolved"
            new["System Status"] = "Reopened - still open in reco" if done else "Open"
            seen.add(aid)
        else:
            new = o.to_dict()
            if clean(o.get("System Status")).startswith(("Open", "Reopened")):
                new["System Status"] = f"Auto-closed {run:%d-%b-%Y} (cleared in data)"
                new["Amount (this run)"] = 0.0
        rows.append(new)
    for aid, c in cur.iterrows():
        if aid in seen:
            continue
        d = c.to_dict()
        d.update({"Action ID": aid, "Amount (first seen)": c["Amount (this run)"], "First Seen": run,
                  "Last Seen": run, "System Status": "Open", "Status": "New"})
        rows.append(d)
    out = pd.DataFrame(rows).reindex(columns=SYS_COLS + USER_COLS)
    open_first = out["System Status"].map(lambda s: 0 if clean(s).startswith(("Open", "Reopened")) else 1)
    pr = out["Priority"].map({"High": 0, "Medium": 1, "Low": 2}).fillna(3)
    amt = pd.to_numeric(out["Amount (this run)"], errors="coerce").abs().fillna(0)
    out = out.assign(_o=open_first, _p=pr, _a=-amt).sort_values(["_o", "_p", "_a"]).drop(columns=["_o", "_p", "_a"])
    return out.reset_index(drop=True)


def save_history(root, keys, meta):
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    d = os.path.join(root, "99_History", f"run_{stamp}")
    os.makedirs(d, exist_ok=True)
    cols = ["party_key", "name", "area", "books", "s26", "variance", "status", "category", "who"]
    keys[cols].to_csv(os.path.join(d, "reco_keys.csv"), index=False)
    with open(os.path.join(d, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2, default=str)
    return d


def previous_run(root):
    runs = sorted(glob.glob(os.path.join(root, "99_History", "run_*", "reco_keys.csv")))
    if not runs:
        return None, None
    p = runs[-1]
    meta = {}
    mp = os.path.join(os.path.dirname(p), "meta.json")
    if os.path.exists(mp):
        with open(mp) as fh:
            meta = json.load(fh)
    return pd.read_csv(p, dtype={"party_key": str}), meta


def movement(keys, prev, tol):
    """Status-by-area block like the manual 'Status' tab: now vs previous run."""
    def block(df):
        if df is None or not len(df):
            return pd.DataFrame()
        g = df.groupby(["area", "status"]).agg(amount=("variance", "sum"), count=("variance", "size"))
        return g
    now = block(keys)
    if prev is None:
        return now.reset_index(), pd.DataFrame()
    was = block(prev)
    m = now.join(was, how="outer", lsuffix="_now", rsuffix="_prev").fillna(0)
    m["amount_change"] = m["amount_now"] - m["amount_prev"]
    m["count_change"] = m["count_now"] - m["count_prev"]
    per_key = keys[["party_key", "name", "area", "variance", "status"]].merge(
        prev[["party_key", "variance", "status"]].rename(columns={"variance": "prev_variance", "status": "prev_status"}),
        on="party_key", how="outer")
    per_key[["variance", "prev_variance"]] = per_key[["variance", "prev_variance"]].fillna(0.0)
    per_key["change"] = per_key["variance"] - per_key["prev_variance"]
    per_key = per_key[(per_key["change"].abs() > 1) | (per_key["status"] != per_key["prev_status"])]
    return m.reset_index(), per_key.sort_values("change", key=lambda s: -s.abs())
