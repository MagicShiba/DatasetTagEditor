@echo off
setlocal
cd /d "%~dp0"

rem ==================================================
rem  Dataset Tag Editor - packaging script (Windows only)
rem
rem  Steps:
rem   1) Clean old build output (dist\dte)
rem   2) neu build -> generate resources.neu + dte-win_x64.exe
rem      - Non-Windows binaries were moved to bin\backup-non-win,
rem        so only the Windows build is produced
rem      - resources.neu is NOT embedded into the exe
rem        (default behavior, no --embed-resources flag)
rem      - autocomplete.txt / locales / config.json / settings.json
rem        are NOT packed into resources.neu; they are copied next to
rem        the exe via copyItems so the user can edit them directly
rem   3) Verify output and zip dist\dte into a release archive
rem ==================================================

where neu >nul 2>nul
if errorlevel 1 (
    echo [ERROR] neu not found. Install with: npm i -g @neutralinojs/neu
    pause
    exit /b 1
)

echo [1/4] Cleaning old build output...
if exist dist\dte rd /s /q dist\dte
if exist dist\dte-win_x64.zip del /q dist\dte-win_x64.zip

echo [2/4] Running neu build ...
call neu build
if errorlevel 1 (
    echo [ERROR] neu build failed.
    pause
    exit /b 1
)

echo [3/4] Verifying build output...
if not exist dist\dte\dte-win_x64.exe (
    echo [ERROR] dte-win_x64.exe not found, build may have failed.
    pause
    exit /b 1
)
rem Check whether extra non-Windows artifacts leaked into the output
if exist dist\dte\dte-linux* (
    echo [WARN] Linux artifacts found in dist\dte, build may include extra platforms.
    echo        Make sure bin\ only keeps neutralino-win_x64.exe.
)
if exist dist\dte\dte-mac* (
    echo [WARN] macOS artifacts found in dist\dte, build may include extra platforms.
    echo        Make sure bin\ only keeps neutralino-win_x64.exe.
)

echo [4/4] Zipping dist\dte into dist\dte-win_x64.zip ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path 'dist\dte\*' -DestinationPath 'dist\dte-win_x64.zip' -Force"
if errorlevel 1 (
    echo [ERROR] Zip failed.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo  Build finished. Artifacts:
echo    Folder: dist\dte\
echo    Zip:    dist\dte-win_x64.zip
echo ==========================================
echo  Note: dist\dte\ can be copied to any Windows machine.
pause
exit /b 0