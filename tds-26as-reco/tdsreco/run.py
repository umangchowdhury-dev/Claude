"""One reconciliation run over a working folder."""
import datetime as dt
import os
import pickle

import numpy as np
import pandas as pd

from . import evidence, ldc as ldcmod, tracker
from .config import Config
from .folders import init_folder, style_tracker
from .load_26as import load_26as
from .load_gl import gl_accounts_seen, load_gl
from .masters import PartyMaster
from .reco import WHO_NONE, WHO_OK, Reco
from .report import write_report
from .util import (clean, file_sig, find_header_row, frame_from_raw, latest_settled_quarter_end, list_inputs,
                   pick_col, read_any, to_date, to_num)


class Cache:
    """Parsed input files, keyed by path+size+mtime, so re-runs are quick."""

    def __init__(self, root):
        self.dir = os.path.join(root, "99_History", ".cache")
        os.makedirs(self.dir, exist_ok=True)

    def get(self, path, fn):
        p = os.path.join(self.dir, file_sig(path) + ".pkl")
        if os.path.exists(p):
            try:
                with open(p, "rb") as fh:
                    return pickle.load(fh)
            except Exception:  # noqa: BLE001 - corrupt cache, rebuild
                pass
        v = fn()
        with open(p, "wb") as fh:
            pickle.dump(v, fh)
        return v


def _log(msg):
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def load_ar_open(paths, party):
    frames = []
    for p in paths:
        for _, raw in read_any(p).items():
            h = find_header_row(raw, [["PAN", "Customer Code", "Customer"], ["Expected TDS", "TDS"]])
            if h is None:
                continue
            df = frame_from_raw(raw, h)
            pan = pick_col(df.columns, ["PAN"])
            cc = pick_col(df.columns, ["Customer Code", "Customer"])
            key = df[pan].map(lambda x: clean(x).upper()) if pan else pd.Series("", index=df.index)
            if cc:
                key = key.where(key != "", df[cc].map(party.key_for_code).fillna(""))
            frames.append(pd.DataFrame({"party_key": key,
                                        "expected_tds": to_num(df[pick_col(df.columns, ["Expected TDS", "TDS"])])}))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def run(root):
    root = os.path.abspath(root)
    init_folder(root)  # make sure every folder/template exists
    cfg = Config(root)
    party = PartyMaster(root)
    cache = Cache(root)
    d = lambda f: os.path.join(root, f)  # noqa: E731

    _log("Reading 26AS ...")
    tas_files = list_inputs(d("01_26AS"), {".txt", ".xlsx", ".xls", ".csv"})
    tas, snaps, tas_prev = load_26as(tas_files, cache)
    if not len(tas):
        raise SystemExit("No 26AS data found in 01_26AS. Drop at least one Form 26AS file and re-run.")
    tas["party_key"] = tas["tan"].map(party.key_for_tan)
    _log(f"  {len(tas):,} 26AS lines in use from {snaps['used'].sum()} snapshot(s)")

    _log("Reading books (GL) ...")
    gl_files = list_inputs(d("02_Books_GL"), {".xlsx", ".xls", ".csv"})
    gl, dupes = load_gl(gl_files, cache, cfg, party)
    if not len(gl):
        raise SystemExit("No GL data found in 02_Books_GL.")
    _log(f"  {len(gl):,} GL lines ({dupes:,} duplicates dropped)")

    latest_snap = pd.to_datetime(snaps.loc[snaps["used"], "snapshot_date"]).max()
    auto = latest_settled_quarter_end(latest_snap, int(cfg["return_lag_days"]))
    if cfg.cutoff_override():
        cutoff, src = cfg.cutoff_override(), "set in Settings"
    else:
        cutoff = auto
        src = f"auto: last quarter whose TDS return is due + {int(cfg['return_lag_days'])} days before the 26AS " \
              f"download of {latest_snap:%d-%b-%Y}"
        gl_max = gl["posting_date"].max()
        if not pd.isna(gl_max) and gl_max.date() < cutoff:
            cutoff, src = gl_max.date(), "auto: capped at the last GL posting date"
    _log(f"  cut-off {cutoff:%d-%b-%Y} ({src})")

    _log("Cut 1: LDC ...")
    ldc_master = ldcmod.load_ldc_master(root)
    ldc_t, ldc_lines, ldc_summary, ldc_util = ldcmod.run_ldc(tas, cfg, ldc_master, party.key_for_tan)
    prof, ind, sug = ldcmod.discovery(ldc_t, ldc_master)

    _log("Evidence: party ledgers, Form 16A, AR open items ...")
    ledger_lines, ledger_info = evidence.load_party_ledgers(
        list_inputs(d("04_Party_Ledgers"), {".xlsx", ".xls", ".csv"}), party, gl, clean(cfg["company_pan"]).upper())
    f16a = evidence.load_form16a(list_inputs(d("05_Form16A"), {".pdf", ".zip", ".xlsx", ".xls", ".csv"}),
                                 clean(cfg["company_pan"]).upper(), party.key_for_tan)
    f16a_cmp = evidence.f16a_vs_26as(f16a, tas)
    ar_open = load_ar_open(list_inputs(d("06_AR_Open_Items"), {".xlsx", ".xls", ".csv"}), party)

    _log("Cut 2: 26AS vs books ...")
    rc = Reco(cfg, gl, tas, snaps, cutoff, party, ledger_lines, f16a, ar_open, ldc_t).run()

    prev_keys, prev_meta = tracker.previous_run(root)
    mv, mv_keys = tracker.movement(rc.keys, prev_keys, cfg["tolerance"])
    suggestions = party.suggest_unmapped(tas, gl, cfg["name_match_threshold"])

    old_tr = tracker.load_tracker(root)
    ctx = dict(cfg=cfg, reco=rc, snaps=snaps, gl_files=[os.path.basename(p) for p in gl_files], gl_dupes=dupes,
               ledger_info=ledger_info, ledger_lines=ledger_lines, f16a=f16a, f16a_cmp=f16a_cmp,
               ldc_master=ldc_master, ldc_lines=ldc_lines, ldc_summary=ldc_summary, ldc_util=ldc_util,
               ldc_profile=prof, ldc_indicative=ind, ldc_suggest=sug, tan_suggestions=suggestions,
               gl_accounts=gl_accounts_seen(gl), cutoff_source=src, prev_keys=prev_keys, prev_meta=prev_meta or {},
               movement=mv, movement_keys=mv_keys, tracker=old_tr)

    os.makedirs(d("90_Output"), exist_ok=True)
    out = os.path.join(d("90_Output"), f"26AS_Reco_upto_{cutoff:%Y-%m-%d}_run_{dt.datetime.now():%Y%m%d_%H%M}.xlsx")
    _log("Writing report ...")
    actions = write_report(out, ctx)

    # tracker: carry forward what people typed
    sysa = actions.rename(columns={"Who Acts": "Who Acts", "PAN/TAN": "PAN/TAN"})
    sysa = pd.DataFrame({"Action ID": actions["Action ID"], "PAN/TAN": actions["PAN/TAN"], "Party": actions["Party"],
                         "Area": actions["Area"], "Owner": actions["Owner"], "Who Acts": actions["Who Acts"],
                         "Category": actions["Category"], "Action": actions["Action"],
                         "Priority": actions["Priority"], "Amount (this run)": actions["Amount"]})
    new_tr = tracker.merge_tracker(old_tr, sysa, dt.date.today())
    tp = tracker.tracker_path(root)
    try:
        new_tr.to_excel(tp, sheet_name="Tracker", index=False)
        style_tracker(tp)
    except PermissionError:
        alt = tp.replace(".xlsx", f"_{dt.datetime.now():%Y%m%d_%H%M}.xlsx")
        new_tr.to_excel(alt, sheet_name="Tracker", index=False)
        _log(f"  ! Tracker was open - wrote {alt}. Close Excel and rename it back.")
    meta = {"run_at": dt.datetime.now().isoformat(timespec="minutes"), "cutoff": str(cutoff), "output": out}
    tracker.save_history(root, rc.keys, meta)
    added = party.write_back(tas, gl, suggestions)

    k = rc.keys
    act = k[~k["who"].isin([WHO_OK, WHO_NONE])]
    _log("Done.")
    print(f"\n  Books ITD  {k['books'].sum():>18,.2f}\n  26AS ITD   {k['s26'].sum():>18,.2f}\n"
          f"  Variance   {k['variance'].sum():>18,.2f}\n  Parties {len(k):,} | actionable {len(act):,} | "
          f"action items {len(actions):,}\n  Party master: +{added[0]} TANs, +{added[1]} parties\n  Report: {out}\n")
    return out, rc, ctx
