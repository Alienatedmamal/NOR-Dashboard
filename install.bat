@echo off
setlocal

echo ===========================================
echo  NOR Dashboard - first-time setup
echo ===========================================
echo.

set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%PYEXE%" goto :found_python

where python >nul 2>nul
if %errorlevel%==0 (
    python -c "1" >nul 2>nul
    if %errorlevel%==0 (
        set "PYEXE=python"
        goto :found_python
    )
)

echo Python wasn't found on this PC.
where winget >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo "winget" isn't available, so this can't install Python automatically.
    echo Please install Python 3 yourself from https://www.python.org/downloads/
    echo   - During setup, check "Add python.exe to PATH"
    echo Then run install.bat again.
    pause
    exit /b 1
)

echo Installing Python 3.12 via winget - this can take a minute or two...
winget install --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements -e
if %errorlevel% neq 0 (
    echo.
    echo Automatic install failed. Please install Python 3 manually from https://www.python.org/downloads/
    echo   - During setup, check "Add python.exe to PATH"
    pause
    exit /b 1
)

set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"

:found_python
echo Using Python: %PYEXE%
echo %PYEXE%> "%~dp0.pyexe"
echo.

echo Installing required packages (Flask, websocket-client, requests)...
"%PYEXE%" -m pip install --quiet -r "%~dp0requirements.txt"
if %errorlevel% neq 0 (
    echo.
    echo Something went wrong installing packages - check the message above.
    pause
    exit /b 1
)

if not exist "%~dp0config.json" (
    copy "%~dp0config.example.json" "%~dp0config.json" >nul
    echo.
    echo Created config.json - open it and fill in your RCON host/port/password,
    echo Steam API key, and RustMaps API key before running run.bat.
) else (
    echo.
    echo config.json already exists - leaving it as-is.
)

echo.
echo ===========================================
echo  Setup complete! Double-click run.bat to start the dashboard.
echo ===========================================
pause
endlocal
