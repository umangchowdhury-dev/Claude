"""python -m tdsreco init  <folder>             create the working folder + templates
python -m tdsreco run   <folder>             reconcile everything in it once
python -m tdsreco watch <folder> [minutes]   re-run whenever an input file is added or changed"""
import os
import sys
import time

from .folders import init_folder
from .run import run
from .util import file_sig, list_inputs

WATCHED = ["00_Config", "01_26AS", "02_Books_GL", "03_Masters", "04_Party_Ledgers", "05_Form16A", "06_AR_Open_Items"]


def _inputs_sig(root):
    files = []
    for f in WATCHED:
        files += list_inputs(os.path.join(root, f), {".txt", ".xlsx", ".xls", ".csv", ".pdf", ".zip"})
    return tuple(sorted(file_sig(p) for p in files))


def watch(root, minutes):
    print(f"Watching {root} every {minutes} min. Ctrl+C to stop.")
    last = None
    while True:
        sig = _inputs_sig(root)
        if sig != last:
            try:
                run(root)
            except SystemExit as e:
                print(e)
            except Exception as e:  # noqa: BLE001 - keep watching after a bad file
                print(f"Run failed: {e}")
            last = _inputs_sig(root)  # the run itself updates the party master
        time.sleep(minutes * 60)


def main(argv):
    if len(argv) < 2 or argv[0] not in ("init", "run", "watch"):
        print(__doc__)
        return 2
    if argv[0] == "init":
        root = init_folder(argv[1])
        print(f"Working folder ready: {root}\nDrop 26AS files in 01_26AS and GL dumps in 02_Books_GL, then run:\n"
              f"  python -m tdsreco run \"{argv[1]}\"")
    elif argv[0] == "run":
        run(argv[1])
    else:
        watch(argv[1], float(argv[2]) if len(argv) > 2 else 15)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
