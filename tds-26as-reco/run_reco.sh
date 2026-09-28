#!/usr/bin/env bash
# Reconcile once. Usage: ./run_reco.sh "/path/to/TDS_26AS_Reco"   (or set RECO_FOLDER)
set -euo pipefail
cd "$(dirname "$0")"
python3 -m tdsreco run "${1:-${RECO_FOLDER:?set RECO_FOLDER or pass the folder}}"
