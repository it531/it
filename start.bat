@echo off
title Deep Hospital
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 22 (
  echo Your Node.js is too old. Install version 22 or newer from https://nodejs.org
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)
echo.
echo Starting Deep Hospital... first run creates demo data (about 15 seconds).
echo When you see "running on http://localhost:3000", your browser will open.
echo Sign in: admin / 123     Close this window to stop.
echo.
start "" cmd /c "timeout /t 20 >nul && start http://localhost:3000"
node --disable-warning=ExperimentalWarning server/index.js
pause
