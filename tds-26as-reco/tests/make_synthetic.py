"""Builds a small synthetic working folder that exercises every rule.
All names, PANs and TANs are made up."""
import os

import pandas as pd

from tdsreco.folders import init_folder

CO_PAN = "AAACZ0000Z"

PARTIES = [  # key, name, pan, tan, area, email
    ("ALPHA", "ALPHA FOODS PRIVATE LIMITED", "AAACA1111A", "MUMA11111A", "Only Monet", "ap@alpha.example"),
    ("BETA", "BETA RETAIL LIMITED", "AAACB2222B", "BLRB22222B", "Only Monet", ""),
    ("GAMMA", "GAMMA LIMITED", "AAACG3333G", "DELG33333G", "Only BFD", ""),
    ("DELTA", "DELTA TRADERS LLP", "AAFFD4444D", "CHED44444D", "Only Monet", ""),
    ("EPS", "EPSILON PRIVATE LIMITED", "AAACE5555E", "MUME55555E", "Only Monet", ""),
    ("OMEGA", "OMEGA BRANDS PRIVATE LIMITED", "AAACO7777O", "MUMO77777O", "Only Monet", ""),
    ("KAPPA", "KAPPA FOODS PRIVATE LIMITED", "AAACK8888K", "PNEK88888K", "Only Monet", ""),
]
SIGMA_TAN = "MUMS66666S"  # a bank with no PAN in the master: books and 26AS both use the TAN


def traces_text(fy, created, deductors):
    ay = f"{fy + 1}-{str(fy + 2)[-2:]}"
    out = [f"File Creation Date^{created}",
           f"Permanent Account Number (PAN)^{CO_PAN}^Current Status of PAN^Active^Financial Year^{fy}-{str(fy + 1)[-2:]}"
           f"^Assessment Year^{ay}",
           "Name of Assessee^SYNTHETIC CO LIMITED", "",
           "PART-I - Details of Tax Deducted at Source",
           "Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)"
           "^Total TDS Deposited(Rs.)"]
    for i, (name, tan, lines) in enumerate(deductors, 1):
        out.append(f"{i}^{name}^{tan}^^^^^{sum(l[4] for l in lines):.2f}^{sum(l[5] for l in lines):.2f}"
                   f"^{sum(l[5] for l in lines):.2f}")
        out.append("^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / "
                   "Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)")
        for j, (sec, td, st, bd, amt, tds) in enumerate(lines, 1):
            out.append(f"^{j}^{sec}^{td}^{st}^{bd}^-^{amt:.2f}^{tds:.2f}^{tds:.2f}")
    out += ["", "PART-II - Details of Tax Deducted at Source for 15G / 15H", "No Transactions Present"]
    return "\n".join(out) + "\n"


def build(root):
    init_folder(root)
    # settings: fixed cut-off so the test is deterministic
    s = os.path.join(root, "00_Config", "Settings.xlsx")
    xl = pd.read_excel(s, sheet_name=None)
    st = xl["Settings"]
    st.loc[st["Key"] == "reco_cutoff_date", "Value"] = "2026-03-31"
    st.loc[st["Key"] == "fy_from", "Value"] = 2024
    st.loc[st["Key"] == "company_pan", "Value"] = CO_PAN
    st.loc[st["Key"] == "company_name", "Value"] = "Synthetic Co Ltd"
    st.loc[st["Key"] == "tolerance", "Value"] = 1000
    with pd.ExcelWriter(s) as w:
        for k, v in xl.items():
            v.to_excel(w, sheet_name=k, index=False)

    # party master
    tm = pd.DataFrame([(t, p, n, "Confirmed", "test") for _, n, p, t, _, _ in PARTIES],
                      columns=["TAN", "PAN", "Deductor Name", "Status", "Source"])
    pt = pd.DataFrame([(p, n, a, f"C{p[:4]}", "", e, "") for _, n, p, _, a, e in PARTIES],
                      columns=["PAN", "Party Name", "Area", "Customer Codes", "Vendor Codes", "Email", "Owner"])
    with pd.ExcelWriter(os.path.join(root, "03_Masters", "Party_Master.xlsx")) as w:
        tm.to_excel(w, sheet_name="TAN_Map", index=False)
        pt.to_excel(w, sheet_name="Parties", index=False)

    # LDC master: ALPHA 194C @0.25%, FY 2025-26, limit 50 lakh
    pd.DataFrame([["LDC0001", "MUMA11111A", "ALPHA", "194C", 0.25, "2025-04-01", "2026-03-31", 5000000, ""]],
                 columns=["Certificate No", "Deductor TAN", "Deductor Name", "Section", "LDC Rate (%)", "Valid From",
                          "Valid To", "Amount Limit (Rs)", "Remarks"]) \
        .to_excel(os.path.join(root, "03_Masters", "LDC_Certificates.xlsx"), sheet_name="LDC", index=False)

    # ---- 26AS FY 2025-26 as TRACES text, old + new download
    alpha = [("194C", f"{d}-2025", "F", "15-Jan-2026", 1000000, 2500) for d in ("30-Apr", "31-May", "30-Jun", "31-Jul")]
    alpha += [("194C", "31-Aug-2025", "F", "15-Jan-2026", 1000000, 20000),   # above LDC rate -> excess 17,500
              ("194C", "30-Sep-2025", "F", "15-Jan-2026", 1000000, 20000)]   # limit exhausted -> fine
    ded = [
        ("ALPHA FOODS PRIVATE LIMITED", "MUMA11111A", alpha),
        ("BETA RETAIL LIMITED", "BLRB22222B", [("194C", "31-Oct-2025", "F", "15-Feb-2026", 5000000, 100000)]),
        ("GAMMA LIMITED", "DELG33333G", [("194C", "30-Nov-2025", "F", "15-Feb-2026", 4000000, 80000)]),
        ("DELTA TRADERS LLP", "CHED44444D", [("194JB", "31-Dec-2025", "F", "15-Feb-2026", 600000, 60000)]),
        ("EPSILON PRIVATE LIMITED", "MUME55555E", [("194C", "31-Jan-2026", "F", "15-Mar-2026", 2000000, 40000)]),
        ("SIGMA BANK LIMITED", SIGMA_TAN, [("194A", "31-Mar-2026", "F", "20-May-2026", 1000000, 100000)]),
        ("OMEGA BRANDS PRIVATE LIMITED", "MUMO77777O", [("194C", "31-Mar-2026", "F", "20-May-2026", 2500000, 50000)]),
        ("KAPPA FOODS PRIVATE LIMITED", "PNEK88888K", [("194C", "28-Feb-2026", "U", "20-May-2026", 1500000, 30000)]),
    ]
    old = [d for d in ded if d[0] != "OMEGA BRANDS PRIVATE LIMITED"]
    with open(os.path.join(root, "01_26AS", "26AS_FY2025-26_2026-06-20.txt"), "w") as fh:
        fh.write(traces_text(2025, "20-06-2026", old))
    with open(os.path.join(root, "01_26AS", "26AS_FY2025-26_2026-09-15.txt"), "w") as fh:
        fh.write(traces_text(2025, "15-09-2026", ded))
    # ---- FY 2024-25 as an Excel detail file (the manual-file layout)
    pd.DataFrame([[2024, "194C", "BETA RETAIL LIMITED", "BLRB22222B", "31-Mar-2025", "F", "15-May-2025", "-",
                   1000000, 20000, 20000]],
                 columns=["FY", "Section", "Name", "TAN", "Transaction Date", "Status of Booking", "Date of Booking",
                          "Remarks", "Amount Paid / Credited(Rs.)", "Tax Deducted(Rs.)", "TDS Deposited(Rs.)"]) \
        .to_excel(os.path.join(root, "01_26AS", "26AS_details_2026-09-15.xlsx"), index=False)

    # ---- books
    def gl(fy, amt, pdate, pan, text, doc):
        return {"Company Code": 1100, "G/L Account": 269697 if fy == 2025 else 259501,
                "G/L Account: Long Text": "TDS Receivable FY 2025-26" if fy == 2025 else "Tax Receivable-Tds- Ay",
                "Fiscal": fy, "Amount": amt, "Document Number": doc, "Posting Date": pdate, "Document Type": "SA",
                "Document Date": pdate, "Text": text, "PAN": pan, "Customer": f"C{pan[:4]}" if len(pan) == 10 else "",
                "Name": ""}
    itd = [
        gl(2025, 10000 + 20000 + 20000, "2026-01-31", "AAACA1111A", "TDS alpha", 1),  # ALPHA books = 50,000
        gl(2025, 150000, "2026-01-31", "AAACB2222B", "TDS beta", 2),                  # BETA excess 50,000
        gl(2024, 20000, "2025-03-31", "AAACB2222B", "TDS beta FY24", 3),
        gl(2025, 100000, "2026-01-31", "AAACG3333G", "TDS gamma", 4),                 # GAMMA excess 20,000
        gl(2024, 40000, "2026-02-28", "AAACE5555E", "TDS eps", 5),                    # EPS wrong FY
        gl(2025, 100000, "2026-03-31", SIGMA_TAN, "FD interest TDS", 6),              # SIGMA by TAN
        gl(2025, 20000, "2026-03-31", "AAACO7777O", "TDS omega", 7),                  # OMEGA short 30,000
        gl(2025, 30000, "2026-03-31", "AAACK8888K", "TDS kappa", 8),                  # KAPPA = 26AS but status U
        gl(2025, 10000, "2026-03-31", "Contra", "contra", 9),
        gl(2025, -10000, "2026-03-31", "Contra", "contra", 10),
        gl(2025, -500000, "2026-03-31", "Refund - FY 24-25", "Refund received", 11),
    ]
    later = [gl(2025, 30000, "2026-04-20", "AAACO7777O", "TDS entry Mar'26 omega", 12)]  # clears OMEGA
    pd.DataFrame(itd).to_excel(os.path.join(root, "02_Books_GL", "GL_ITD_2026-03-31.xlsx"), index=False)
    pd.DataFrame(itd[-4:] + later).to_excel(os.path.join(root, "02_Books_GL", "GL_2026-03_to_2026-04.xlsx"),
                                            index=False)  # overlaps ITD by 4 lines

    # ---- party ledgers (their books, our account)
    pd.DataFrame({"Date": ["31-10-2025", "31-10-2025"], "Particulars": ["Purchase bill 101", "TDS u/s 194C"],
                  "Debit": [0, 150000], "Credit": [7500000, 0]}) \
        .to_excel(os.path.join(root, "04_Party_Ledgers", "AAACB2222B_Beta_ledger.xlsx"), index=False)
    raw = pd.DataFrame([["Ledger of Synthetic Co Ltd in the books of GAMMA LIMITED", None, None, None],
                        [None, None, None, None], ["Date", "Narration", "Dr", "Cr"],
                        ["30-11-2025", "Invoice 55", None, 4000000], ["30-11-2025", "TDS deducted", 80000, None]])
    raw.to_excel(os.path.join(root, "04_Party_Ledgers", "Gamma Limited statement.xlsx"), index=False, header=False)

    # ---- Form 16A (manual entry file)
    pd.DataFrame([["BLRB22222B", "BETA RETAIL LIMITED", "2025-26", "Q3", "CERTB", 7500000, 150000, 150000]],
                 columns=["TAN", "Deductor Name", "FY", "Quarter", "Certificate No", "Amount Paid", "Tax Deducted",
                          "Tax Deposited"]) \
        .to_excel(os.path.join(root, "05_Form16A", "Form16A_Manual_Entry.xlsx"), sheet_name="Form16A", index=False)
    return root


if __name__ == "__main__":
    import sys
    build(sys.argv[1] if len(sys.argv) > 1 else "synthetic_folder")
