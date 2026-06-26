@echo off
setlocal

set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%~dp0.pyexe" (
    for /f "usebackq delims=" %%P in ("%~dp0.pyexe") do set "PYEXE=%%P"
)
if not exist "%PYEXE%" set "PYEXE=python"

if not exist "%~dp0config.json" (
    echo config.json not found - run install.bat first.
    pause
    exit /b 1
)

echo Installing/updating dependencies (quick check, only does real work the first time)...
"%PYEXE%" -m pip install --quiet -r "%~dp0requirements.txt"

echo.
echo Starting NOR Dashboard - leave this window open while you use it.
echo Once you see "Running on http://127.0.0.1:5050", your browser will open automatically.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5050"
"%PYEXE%" "%~dp0app.py"

endlocal
