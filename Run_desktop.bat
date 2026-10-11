@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [DESCENDANTS] Node.js 22 or newer is required.
  echo Install Node.js, then run Run_desktop.bat again.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [DESCENDANTS] npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [DESCENDANTS] Preparing desktop runtime...
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto :failed
)

echo [DESCENDANTS] Building current game data...
call npm run desktop
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo [DESCENDANTS] Startup failed. The window above contains the error details.
pause
exit /b 1
