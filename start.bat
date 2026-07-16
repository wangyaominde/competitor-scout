@echo off
setlocal
cd /d "%~dp0"

echo [1/2] Killing leftover electron.exe ...
taskkill /F /IM electron.exe >nul 2>&1

echo [2/2] Starting Competitor Intel ...
echo If it exits immediately, check .data\startup.log
echo.

call npm start
set ERR=%ERRORLEVEL%

echo.
echo Exit code: %ERR%
if exist ".data\startup.log" (
  echo ---- startup.log tail ----
  powershell -NoProfile -Command "Get-Content -LiteralPath '.data\startup.log' -Tail 20 -ErrorAction SilentlyContinue"
)
echo.
pause
endlocal
