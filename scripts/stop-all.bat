@echo off
REM Authored by: Mohit Singh
REM ONE-CLICK force-stop-everything script. Companion to restart-all.bat.
REM
REM Does, in order:
REM   1. Force-stops the Docker stack (backend, frontend, postgres) - kill, not a graceful
REM      shutdown wait. Does NOT remove volumes, so no data is lost (safe to restart-all.bat
REM      right after this).
REM   2. Kills the property and noon host-runner processes (matched by their exact command line
REM      only, never a blanket kill of every python.exe).
REM   3. Kills the shared debug Chrome instance (matched by its exact
REM      --remote-debugging-port=9222 command line only, never a blanket kill of every
REM      chrome.exe) so port 9222 is free for the next run.
REM
REM Run this from anywhere.

setlocal enabledelayedexpansion

cd /d "%~dp0.."

echo.
echo STEP 1: Force-stopping Docker containers
docker compose kill 2>nul

echo.
echo STEP 2: Stopping host-runner processes (exact match only)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'run_property_host.py|run_noon_host.py' } | ForEach-Object { Write-Host ('  stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo STEP 3: Freeing the Chrome debug port (9222)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'remote-debugging-port=9222' } | ForEach-Object { Write-Host ('  stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo Done. Docker stack stopped, host runners stopped, debug Chrome closed and port 9222 freed.
echo Run restart-all.bat when you want everything back up.

endlocal
