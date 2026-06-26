@echo off
setlocal

set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%~dp0.pyexe" (
    for /f "usebackq delims=" %%P in ("%~dp0.pyexe") do set "PYEXE=%%P"
)
if not exist "%PYEXE%" (
    rem Don't blindly fall back to a bare "python" - that can resolve to
    rem Windows' fake "App Execution Alias" stub instead of a real install
    rem and fail confusingly later. Search PATH ourselves, skipping that stub.
    set "PYEXE="
    for /f "delims=" %%P in ('where python 2^>nul') do (
        echo %%P | findstr /i "WindowsApps" >nul
        if errorlevel 1 if not defined PYEXE set "PYEXE=%%P"
    )
)
if not defined PYEXE (
    echo Python wasn't found on this PC - run install.bat first.
    pause
    exit /b 1
)

if not exist "%~dp0config.json" (
    echo config.json not found - run install.bat first.
    pause
    exit /b 1
)

echo Installing/updating dependencies (quick check, only does real work the first time)...
"%PYEXE%" -m pip install --quiet -r "%~dp0requirements.txt"

echo.
echo Starting NOR Dashboard - leave this window open while you use it.
echo Once you see "Running on http://127.0.0.1:5050", the dashboard will open in its own window.
echo.

set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
    rem "--app=" opens it in its own window - no address bar, tabs, or
    rem bookmarks bar - instead of a normal browser tab.
    start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process -FilePath '%BROWSER%' -ArgumentList '--app=http://127.0.0.1:5050'"
) else (
    rem Neither Edge nor Chrome found at the usual install path - fall
    rem back to whatever the default browser is, as a normal tab.
    start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5050"
)
"%PYEXE%" "%~dp0app.py"

endlocal
