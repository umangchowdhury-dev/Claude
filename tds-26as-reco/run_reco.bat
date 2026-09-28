@echo off
REM Double-click to reconcile. Set RECO_FOLDER to your working folder (e.g. a Google Drive / OneDrive synced folder).
set RECO_FOLDER=%USERPROFILE%\Google Drive\TDS_26AS_Reco
cd /d "%~dp0"
python -m tdsreco run "%RECO_FOLDER%"
pause
