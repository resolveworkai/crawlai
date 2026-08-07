@echo off
REM Authored by: Mohit Singh
REM ONE-CLICK host-side noon processor. Run this on the HOST after `docker compose up`.
REM
REM Why this is separate from the backend container: noon.com blocks every automated/headless
REM browser at its edge — the ONLY thing that gets through is the operator's real Chrome, which
REM lives on this machine, not in the Linux container (and Chrome refuses CDP from a non-localhost
REM caller, so the container can't reach it either). So noon jobs are processed here.
REM
REM This does two things and then keeps running:
REM   1. Launches Chrome with the DevTools debug port (dedicated scratch profile — won't touch
REM      your normal Chrome windows).
REM   2. Runs run_noon_host.py in WATCH mode: it polls the queue and processes any noon job the
REM      moment it's submitted from the /ecom-crawl UI, forever. Leave this window open.
REM
REM Amazon jobs still run automatically in the container as before — this is noon-only.

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

echo Starting debug Chrome on http://127.0.0.1:9222 ...
start "" %CHROME% ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%TEMP%\noon-cdp-chrome" ^
  --no-first-run ^
  --no-default-browser-check ^
  "https://www.noon.com/uae-en/"

REM Give Chrome a moment to open the debug port before the watcher first connects.
timeout /t 4 /nobreak >nul

cd /d "%~dp0..\backend\worker"

REM Point at the containerized Postgres (host-published port 5436) and the debug Chrome. Override
REM DATABASE_URL here if your docker/.env uses non-default DB creds.
if "%DATABASE_URL%"=="" set DATABASE_URL=postgresql://postgres:1234@localhost:5436/master_db_crawler
set ECOM_CDP_URL=http://127.0.0.1:9222
set ECOM_HOST_WATCH=1
set ECOM_HOST_POLL_SECONDS=15
set PYTHONIOENCODING=utf-8

echo.
echo Watching for noon jobs (poll every %ECOM_HOST_POLL_SECONDS%s). Leave this window open.
echo Submit a noon job from the /ecom-crawl UI and it will process automatically.
echo Press Ctrl+C to stop.
echo.

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" run_noon_host.py
) else (
  python run_noon_host.py
)
