@echo off
REM Authored by: Mohit Singh
REM ONE-CLICK launcher for BOTH CDP-required host runners (Property Research + noon/AliExpress),
REM meant to be run at Windows login (see Startup-folder shortcut set up alongside this file).
REM
REM Sequenced, not concurrent, on purpose: both start-property-host.bat and start-noon-host.bat
REM point Chrome at the SAME --remote-debugging-port=9222 / --user-data-dir (the shared-Chrome
REM design documented in both scripts and in CLAUDE.md's "Product Research (ecom) — noon/amazon
REM concurrency" section) — the profile directory is locked by whichever Chrome instance opens it
REM first, so launching both AT THE SAME INSTANT risks two Chrome processes racing for that lock.
REM Starting Property first, giving it time to open Chrome + its debug port, THEN starting noon
REM (which attaches to the already-listening Chrome instead of trying to open its own) avoids that
REM race entirely. Once both are up, their runner loops are fully independent and DO run
REM concurrently against the same Chrome window (each opens its own Page) — see chrome_health.py's
REM shared self-heal/heartbeat, which both scripts' Python processes already use.
REM
REM Each host runner opens in its own new console window and keeps running — closing a window
REM stops that one runner only.

echo Starting Property Research host runner...
start "Property Host Runner" cmd /k call "%~dp0start-property-host.bat"

REM Let Property's Chrome launch + open its debug port before noon's script checks for it.
timeout /t 10 /nobreak >nul

echo Starting noon/AliExpress host runner...
start "Noon Host Runner" cmd /k call "%~dp0start-noon-host.bat"

echo.
echo Both host runners launching in separate windows. This launcher window can be closed.
