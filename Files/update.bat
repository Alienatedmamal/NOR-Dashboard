@echo off
setlocal

echo ===========================================
echo  NOR Dashboard - check for updates
echo ===========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Update failed - see the message above.
    pause
    exit /b 1
)

echo.
pause
endlocal
