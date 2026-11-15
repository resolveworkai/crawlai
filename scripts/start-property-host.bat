@echo off
REM Authored by: Mohit Singh
REM ONE-CLICK host-side property-crawl processor. Run this on the HOST after `docker compose up`.
REM
REM Why this is separate from the backend container: both dubizzle.com and propertyfinder.ae block
REM plain headless Chromium (confirmed 2026-08-22 — dubizzle returns an empty-body 200,
REM propertyfinder returns a bare 403). The only thing that gets through is the operator's real
REM Chrome, which lives on this machine, not in the Linux container.
REM
REM This does two things and then keeps running:
REM   1. Launches Chrome with the DevTools debug port (dedicated scratch profile — won't touch
REM      your normal Chrome windows). Shared with the noon/AliExpress host runner's profile if
REM      you're also running start-noon-host.bat — both attach to whatever Chrome is already
REM      listening on 9222, so run only ONE of the two .bat launchers at a time (or point this one
REM      at a different --remote-debugging-port and PROPERTY_CDP_URL if you need both live at once).
REM   2. Runs run_property_host.py in WATCH mode: polls the queue and processes any dubizzle/
REM      propertyfinder job the moment it's submitted from the /property-crawl UI, forever. Leave
REM      this window open.

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

REM Re-runnable: scripts/host-watchdog.ps1 calls this whenever a runner has died, and the debug
REM Chrome is usually still up. Launching it again would only open a stray extra tab, so skip
REM the launch when the debug port already answers.
curl -s -m 2 http://127.0.0.1:9222/json/version >nul 2>&1
if errorlevel 1 (
  echo Starting debug Chrome on http://127.0.0.1:9222 ...
  start "" %CHROME% ^
    --remote-debugging-port=9222 ^
    --user-data-dir="%TEMP%\noon-cdp-chrome" ^
    --no-first-run ^
    --no-default-browser-check ^
    "https://dubai.dubizzle.com/en/property-for-sale/residential/apartment/"
  timeout /t 4 /nobreak >nul
) else (
  echo Debug Chrome already running on http://127.0.0.1:9222 - not launching another.
)

cd /d "%~dp0..\backend\worker"

if "%DATABASE_URL%"=="" set DATABASE_URL=postgresql://postgres:1234@localhost:5436/master_db_crawler
set PROPERTY_CDP_URL=http://127.0.0.1:9222
set PROPERTY_HOST_WATCH=1
set PROPERTY_HOST_POLL_SECONDS=15
set PYTHONIOENCODING=utf-8

echo.
echo Watching for dubizzle/propertyfinder jobs (poll every %PROPERTY_HOST_POLL_SECONDS%s).
echo Submit a job from the /property-crawl UI and it will process automatically.
echo Press Ctrl+C to stop.
echo.

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" run_property_host.py
) else (
  python run_property_host.py
)
