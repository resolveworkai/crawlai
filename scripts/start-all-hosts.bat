@echo off
REM Authored by: Mohit Singh
REM ONE-CLICK "make sure the host runners are up right now" (Property Research + noon/AliExpress/
REM Amazon.in). Safe to run any time and any number of times.
REM
REM This used to open each runner in its own console window unconditionally. With the
REM self-healing watchdog (scripts\host-watchdog.ps1, installed by scripts\install-host-watchdog.ps1)
REM that became dangerous: a second copy of a runner fails the first one's in-flight job (orphan
REM recovery on startup). So this now just runs ONE watchdog pass, which starts only the runners
REM that are actually missing, one after the other (so they never race to launch the shared debug
REM Chrome), and leaves healthy ones alone. Runner output goes to
REM backend\worker\storage\logs\<runner>-host-<time>.log, not to a console window.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host-watchdog.ps1" -Once

echo.
powershell -NoProfile -Command "if (Get-ScheduledTask -TaskName BusinessScoutHostWatchdog -ErrorAction SilentlyContinue) { 'Auto-healing watchdog: installed (restarts runners that die or hang).' } else { 'Auto-healing watchdog: NOT installed. To enable it run: powershell -File scripts\install-host-watchdog.ps1' }"
