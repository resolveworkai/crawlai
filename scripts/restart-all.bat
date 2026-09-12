@echo off
REM Authored by: Mohit Singh
REM ONE-CLICK restart-everything script.
REM
REM Does, in order:
REM   1. Makes sure Docker Desktop is running (starts it if paused/stopped, waits).
REM   2. Makes sure the postgres container is up, then rebuilds backend+frontend images
REM      in parallel.
REM   3. Applies any pending DB migrations (safe to run when there is nothing new).
REM   4. Recreates the backend+frontend containers from the fresh images.
REM   5. Stops the existing property and noon host-runner processes (matched by their exact
REM      command line only, never a blanket kill of every python.exe), then relaunches both
REM      in new terminal windows via the existing start-property-host.bat and
REM      start-noon-host.bat launchers.
REM
REM Run this from anywhere. Leave the two host-runner windows it opens running.

setlocal enabledelayedexpansion

cd /d "%~dp0.."

echo.
echo STEP 1: Checking Docker Desktop
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Starting it...
  docker desktop start >nul 2>&1
)

:wait_docker
docker info >nul 2>&1
if errorlevel 1 (
  echo Waiting for Docker Desktop to finish starting...
  timeout /t 3 /nobreak >nul
  goto wait_docker
)
echo Docker Desktop is up.

echo.
echo STEP 2: Building backend and frontend images in parallel
docker compose up -d postgres
docker compose build --parallel backend frontend
if errorlevel 1 (
  echo Docker build failed. Aborting.
  exit /b 1
)

echo.
echo STEP 3: Applying pending DB migrations
pushd backend\api
if "%DATABASE_URL%"=="" set DATABASE_URL=postgresql://postgres:1234@localhost:5436/master_db_crawler
call npx node-pg-migrate up -m ..\..\db\migrations -j sql
popd

echo.
echo STEP 4: Recreating backend and frontend containers
docker compose up -d backend frontend
if errorlevel 1 (
  echo Failed to start containers. Aborting.
  exit /b 1
)

echo.
echo STEP 5: Restarting host-side processors
echo Stopping existing host-runner processes (exact match only)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'run_property_host.py|run_noon_host.py' } | ForEach-Object { Write-Host ('  stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Launching property host runner in a new window...
start "Property Host Runner" cmd /k "%~dp0start-property-host.bat"

timeout /t 2 /nobreak >nul

echo Launching noon host runner in a new window...
start "Noon Host Runner" cmd /k "%~dp0start-noon-host.bat"

echo.
echo Done.
echo Backend:  http://localhost:4010
echo Frontend: http://localhost:3000
echo Two new terminal windows opened for the property and noon host runners.
echo Leave them open. Closing this window is fine.

endlocal
