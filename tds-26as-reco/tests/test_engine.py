"""End-to-end tests on a synthetic folder.  Run:  python -m unittest discover -s tests"""
import os
import shutil
import sys
import tempfile
import unittest

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from make_synthetic import build  # noqa: E402
from tdsreco import tracker  # noqa: E402
from tdsreco.evidence import parse_16a_text  # noqa: E402
from tdsreco.run import run  # noqa: E402
from tdsreco.util import latest_settled_quarter_end  # noqa: E402

import datetime as dt  # noqa: E402


class EngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.root = build(os.path.join(cls.tmp, "reco"))
        cls.out, cls.rc, cls.ctx = run(cls.root)
        cls.k = cls.rc.keys.set_index("party_key")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def cat(self, key):
        return self.k.loc[key, "category"]

    # ---------------------------------------------------------------- inputs
    def test_latest_26as_snapshot_wins(self):
        s = self.ctx["snaps"]
        used = s[s["used"] & (s["fy"] == 2025)]
        self.assertEqual(list(used["source_file"]), ["26AS_FY2025-26_2026-09-15.txt"])
        self.assertIn("MUMO77777O", set(self.rc.tas["tan"]))  # only in the newer download

    def test_gl_overlap_deduplicated(self):
        self.assertEqual(self.ctx["gl_dupes"], 4)

    def test_totals(self):
        # alpha, beta FY25 + FY24, gamma, delta, epsilon, sigma, omega, kappa
        self.assertAlmostEqual(self.k["s26"].sum(), 50000 + 100000 + 20000 + 80000 + 60000 + 40000 + 100000 + 50000
                               + 30000, places=2)

    # ---------------------------------------------------------------- cut 2
    def test_matched(self):
        self.assertEqual(self.cat("AAACA1111A"), "Matched")

    def test_bank_keyed_by_tan_matches(self):
        self.assertEqual(self.cat("MUMS66666S"), "Matched")

    def test_excess_supported_by_party_ledger_is_deductor_action(self):
        self.assertEqual(self.cat("AAACB2222B"), "Excess - deductor deducted but not reported")
        self.assertEqual(self.k.loc["AAACB2222B", "who"], "Deductor")

    def test_excess_where_ledger_agrees_with_26as_is_our_reversal(self):
        self.assertEqual(self.cat("AAACG3333G"), "Excess - books higher than party ledger")
        je = self.rc.journal[self.rc.journal["PAN/TAN"] == "AAACG3333G"]
        self.assertAlmostEqual(je["Debit"].sum(), 20000)
        self.assertAlmostEqual(je["Credit"].sum(), 20000)

    def test_not_accounted(self):
        self.assertEqual(self.cat("AAFFD4444D"), "Not accounted in books")
        je = self.rc.journal[self.rc.journal["PAN/TAN"] == "AAFFD4444D"]
        self.assertAlmostEqual(je["Debit"].sum(), 60000)

    def test_fy_mismatch_reclass(self):
        self.assertEqual(self.cat("AAACE5555E"), "Matched ITD - FY mismatch")
        je = self.rc.journal[self.rc.journal["PAN/TAN"] == "AAACE5555E"]
        self.assertEqual(set(je["FY"]), {"FY 2024-25", "FY 2025-26"})
        self.assertAlmostEqual(je["Debit"].sum(), 40000)

    def test_timing_booked_after_cutoff(self):
        self.assertEqual(self.cat("AAACO7777O"), "Timing - booked after cut-off")

    def test_refund_is_tax_adjustment(self):
        self.assertEqual(self.k.loc["Refund - Fy 24-25", "family"], "TAXADJ")

    def test_contra_nets_off(self):
        self.assertEqual(self.cat("Contra"), "Unallocated - nets off")

    def test_unmatched_26as_line_raises_deductor_action(self):
        a = self.ctx["actions_out"]
        self.assertTrue(((a["PAN/TAN"] == "AAACK8888K") & a["Category"].str.startswith("26AS status U")).any())

    # ---------------------------------------------------------------- cut 1
    def test_ldc_excess_and_limit(self):
        s = self.ctx["ldc_summary"]
        self.assertAlmostEqual(s["excess"].sum(), 17500, places=2)
        lines = self.ctx["ldc_lines"]
        self.assertIn("LDC limit exhausted - standard rate", set(lines["flag"]))
        self.assertTrue((self.ctx["ldc_summary"]["wc_cost_net"] > 0).all())

    def test_ldc_action_created(self):
        a = self.ctx["actions_out"]
        self.assertTrue((a["Action ID"] == "LDC-MUMA11111A").any())

    # ---------------------------------------------------------------- tracker
    def test_tracker_carries_forward_and_auto_closes(self):
        tp = tracker.tracker_path(self.root)
        tr = pd.read_excel(tp, sheet_name="Tracker", dtype=object)
        beta_id = self.k.loc["AAACB2222B", "action_id"]
        delta_id = self.k.loc["AAFFD4444D", "action_id"]
        tr.loc[tr["Action ID"] == beta_id, ["Status", "Remarks"]] = ["Mail sent to party", "chased on 1-Oct"]
        tr.to_excel(tp, sheet_name="Tracker", index=False)
        # DELTA gets booked
        pd.DataFrame([{"Company Code": 1100, "G/L Account": 269697, "G/L Account: Long Text": "TDS Receivable",
                       "Fiscal": 2025, "Amount": 60000, "Document Number": 99, "Posting Date": "2026-03-31",
                       "Document Type": "SA", "Document Date": "2026-03-31", "Text": "TDS delta", "PAN": "AAFFD4444D"}]) \
            .to_excel(os.path.join(self.root, "02_Books_GL", "GL_fix_delta.xlsx"), index=False)
        _, rc2, ctx2 = run(self.root)
        tr2 = pd.read_excel(tp, sheet_name="Tracker", dtype=object).set_index("Action ID")
        self.assertEqual(tr2.loc[beta_id, "Status"], "Mail sent to party")
        self.assertEqual(tr2.loc[beta_id, "Remarks"], "chased on 1-Oct")
        self.assertTrue(str(tr2.loc[delta_id, "System Status"]).startswith("Auto-closed"))
        self.assertEqual(rc2.keys.set_index("party_key").loc["AAFFD4444D", "category"], "Matched")
        self.assertIsNotNone(ctx2["prev_keys"])


class UnitTest(unittest.TestCase):
    def test_cutoff(self):
        self.assertEqual(latest_settled_quarter_end(dt.date(2026, 9, 13), 15), dt.date(2026, 6, 30))
        self.assertEqual(latest_settled_quarter_end(dt.date(2026, 8, 10), 15), dt.date(2026, 3, 31))

    def test_form16a_text(self):
        txt = ("FORM NO. 16A Certificate No. ABCDEFG Last updated on 12-Aug-2025\n"
               "TAN of the Deductor MUMA11111A PAN of the Deductee AAACZ0000Z\n"
               "Assessment Year 2026-27 Period From 01-Apr-2025 To 31-Mar-2026\n"
               "Quarter Receipt Numbers of original quarterly statements Amount paid/credited Amount of tax deducted "
               "Amount of tax deposited\nQ1 QWERTYUI 4,000,000.00 10,000.00 10,000.00\n"
               "Q2 ASDFGHJK 2,000,000.00 22,500.00 22,500.00\n")
        rows = parse_16a_text(txt, "x.pdf", "AAACZ0000Z")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["tan"], "MUMA11111A")
        self.assertEqual(rows[0]["fy"], 2025)
        self.assertAlmostEqual(rows[1]["tax_deposited"], 22500)
        self.assertTrue(rows[0]["deductee_pan_ok"])


if __name__ == "__main__":
    unittest.main()
