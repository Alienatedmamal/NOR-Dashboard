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

if not exist "%~dp0app\config.json" (
    echo app\config.json not found - run install.bat first.
    pause
    exit /b 1
)

echo Installing/updating dependencies (quick check, only does real work the first time)...
"%PYEXE%" -m pip install --quiet -r "%~dp0app\requirements.txt"

rem pythonw.exe is python.exe's windowless sibling - same install, same
rem packages, just no console window. It lives next to python.exe in every
rem standard CPython layout; fall back to python.exe itself if it's somehow
rem missing rather than fail to launch at all.
for %%F in ("%PYEXE%") do set "PYWEXE=%%~dpFpythonw.exe"
if not exist "%PYWEXE%" set "PYWEXE=%PYEXE%"

echo.
echo Starting NOR Dashboard in the background...
echo Your browser will open automatically in a couple seconds.
echo This window will close on its own - closing the dashboard's browser
echo window is what shuts the dashboard down now, not this window.
echo.

set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
    rem "--app=" opens it in its own window - no address bar, tabs, or
    rem bookmarks bar - instead of a normal browser tab. "--start-maximized"
    rem opens that window already maximized rather than at its default size.
    start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process -FilePath '%BROWSER%' -ArgumentList '--app=http://127.0.0.1:5050','--start-maximized'"
) else (
    rem Neither Edge nor Chrome found at the usual install path - fall
    rem back to whatever the default browser is, as a normal tab.
    start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5050"
)
rem Launched via PowerShell's Start-Process, not cmd's own "start" builtin -
rem "start" doesn't reliably hand its redirected output handles through to
rem the process it launches (confirmed by testing: the child ran fine, but
rem its output never reached the redirected file). Start-Process redirects
rem reliably, but can't point stdout and stderr at the same file (it opens
rem two independent handles and they collide) - Werkzeug's actual log
rem output (startup banner, every request, tracebacks) is on stderr, so
rem that's dashboard.log; stdout only ever has two lines of boilerplate, so
rem it goes to a second, rarely-needed file instead. Both get overwritten
rem (not appended) each run - only the latest startup attempt matters.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%PYWEXE%' -ArgumentList '\"%~dp0app\app.py\"' -RedirectStandardOutput '%~dp0dashboard-startup.log' -RedirectStandardError '%~dp0dashboard.log' -WindowStyle Hidden"

rem Safety net for the one failure mode none of the above can show: the
rem server never coming up at all (port in use, a startup crash, etc). 25
rem seconds (not 10) because a real cold start measured ~10s on this machine
rem (OneDrive sync overhead on this folder) - 10 would risk a false-positive
rem popup on a perfectly fine, just-slow-to-start launch. If it still isn't
rem answering after that, show exactly one popup pointing at dashboard.log -
rem otherwise stay completely silent.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$ok = $false; for ($i = 0; $i -lt 50; $i++) { Start-Sleep -Milliseconds 500; try { Invoke-WebRequest -Uri 'http://127.0.0.1:5050/' -UseBasicParsing -TimeoutSec 1 | Out-Null; $ok = $true; break } catch {} }; if (-not $ok) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('NOR Dashboard did not start within 25 seconds. Check dashboard.log in the dashboard folder for details.', 'NOR Dashboard') }"

endlocal
