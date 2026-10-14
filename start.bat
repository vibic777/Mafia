@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in PATH.
  echo Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

echo Starting Mafia MVP...
echo When the server is ready, open http://localhost:4444 in your browser.
echo Keep this window open while playing. Press Ctrl+C or run stop.bat to stop the server.
echo.
set "MAFIA_MANAGED_SERVER=1"
node "%~dp0server.js"

echo.
if errorlevel 1 (
  echo The server could not start. Read the message above.
) else (
  echo The server has stopped.
)
pause
