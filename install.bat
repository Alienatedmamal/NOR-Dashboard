@echo off
setlocal

echo ===========================================
echo  NOR Dashboard - first-time setup
echo ===========================================
echo.

rem The ZIP ships with everything except this script, README.md, and
rem VERSION tucked inside a "Files" folder, just so it's obvious at a
rem glance which file to run first. Unpack it into place here, once -
rem after this, the layout is flat and every other script's existing
rem %~dp0-relative paths work completely unchanged. Safe to re-run:
rem if "Files" is already gone, a previous run already did this.
if not exist "%~dp0Files" goto :files_unpacked
echo Unpacking files...
rem "%~dp0." not "%~dp0" - %~dp0 always ends in a backslash, and a path
rem argument ending in \" gets misparsed by cmd (it swallows the closing
rem quote), which silently merges /E /MOVE into the destination path and
rem makes robocopy fail outright. The trailing "." is a harmless no-op
rem that just keeps the closing quote where it belongs.
robocopy "%~dp0Files" "%~dp0." /E /MOVE >nul
if %errorlevel% geq 8 goto :unpack_failed
rem robocopy /MOVE usually removes the now-empty source folder itself too,
rem but isn't always guaranteed to (e.g. a sync client like OneDrive briefly
rem locking something inside it) - clean up anything left behind so it
rem doesn't linger as confusing clutter alongside the real files.
if exist "%~dp0Files" rmdir /s /q "%~dp0Files"
goto :files_unpacked

:unpack_failed
echo.
echo Something went wrong moving files out of the Files folder.
pause
exit /b 1

:files_unpacked

set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%PYEXE%" goto :found_python

rem Windows ships a fake python.exe "App Execution Alias" at
rem %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe on PCs with no real
rem Python installed - "where python" finds it and exits 0 just like a real
rem install would, so that alone can't tell them apart. Skip any match that
rem comes from that WindowsApps folder and only trust a real install.
for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | findstr /i "WindowsApps" >nul
    if errorlevel 1 if not defined PYEXE_CANDIDATE set "PYEXE_CANDIDATE=%%P"
)
if defined PYEXE_CANDIDATE (
    set "PYEXE=%PYEXE_CANDIDATE%"
    goto :found_python
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

echo Installing required packages (Flask, flask-sock, websocket-client, requests, paramiko)...
"%PYEXE%" -m pip install --quiet -r "%~dp0app\requirements.txt"
if %errorlevel% neq 0 (
    echo.
    echo Something went wrong installing packages - check the message above.
    pause
    exit /b 1
)

if not exist "%~dp0app\config.json" (
    copy "%~dp0app\config.example.json" "%~dp0app\config.json" >nul
    echo.
    echo Created app\config.json - open it and fill in your RCON host/port/password,
    echo Steam API key, and RustMaps API key before running run.bat.
) else (
    echo.
    echo app\config.json already exists - leaving it as-is.
)

rem permissions_catalog.json grows over time as you upload AMAP plugins (see
rem the AMAP tab) - it's local data, same idea as config.json, so it's only
rem ever seeded here, never overwritten by a later update.
if not exist "%~dp0app\permissions_catalog.json" (
    copy "%~dp0app\permissions_catalog.example.json" "%~dp0app\permissions_catalog.json" >nul
)

if exist "%~dp0icon.ico" (
    powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%~dp0Launch NOR Dashboard.lnk'); $s.TargetPath = '%~dp0run.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0icon.ico'; $s.Save()"
    powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = $ws.SpecialFolders('Desktop'); $s = $ws.CreateShortcut(\"$desktop\Launch NOR Dashboard.lnk\"); $s.TargetPath = '%~dp0run.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0icon.ico'; $s.Save()"
    echo.
    echo Created a "Launch NOR Dashboard" shortcut on your Desktop and pinned
    echo a copy in this folder too, both with their own icon.
)

echo.
echo ===========================================
echo  Setup complete! Double-click run.bat to start the dashboard.
echo ===========================================
pause
endlocal
