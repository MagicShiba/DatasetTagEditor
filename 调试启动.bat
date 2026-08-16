@echo off
setlocal
cd /d "%~dp0"

rem ==================================================
rem  Dataset Tag Editor - launcher (dev mode)
rem  Uses 'neu run' by default so the console shows
rem  runtime logs for easier debugging.
rem ==================================================

where neu >nul 2>nul
if errorlevel 1 (
    echo [ERROR] neu not found. Install with: npm i -g @neutralinojs/neu
    pause
    exit /b 1
)

neu run
if errorlevel 1 (
    echo [ERROR] App failed to start.
    pause
    exit /b 1
)

exit /b 0