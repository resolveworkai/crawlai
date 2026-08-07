@echo off
REM Authored by: Mohit Singh
REM Starts a real Chrome with the DevTools debug port open, so the noon host runner
REM (backend/worker/run_noon_host.py) can attach over CDP and reach noon.com — the only
REM path past noon's edge block (see md/ECOM_CRAWL.md "noon.com requires CDP").
REM
REM Uses a DEDICATED scratch profile (not your default one) so it never disturbs your
REM normal Chrome windows/session. noon search needs no login, so a fresh profile is fine.
REM Leave this Chrome window open while a noon job runs; close it when done.

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

start "" %CHROME% ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%TEMP%\noon-cdp-chrome" ^
  --no-first-run ^
  --no-default-browser-check ^
  "https://www.noon.com/uae-en/"

echo.
echo Chrome started with remote debugging on http://localhost:9222
echo Leave this window's Chrome open, then run the noon host runner:
echo.
echo   cd backend\worker
echo   set DATABASE_URL=postgresql://postgres:1234@localhost:5436/master_db_crawler
echo   set ECOM_CDP_URL=http://localhost:9222
echo   python run_noon_host.py
echo.
