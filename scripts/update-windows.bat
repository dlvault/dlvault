@echo off
title dlvault Update
echo.
echo   Starte dlvault Update...
echo.

:: Find the .ps1 in the repo (works from Desktop or anywhere)
set "SCRIPT=%USERPROFILE%\dlvault\repo\scripts\update-windows.ps1"
if exist "%SCRIPT%" goto :run

:: Fallback: same directory as this .bat
set "SCRIPT=%~dp0update-windows.ps1"
if exist "%SCRIPT%" goto :run

echo   [X] update-windows.ps1 nicht gefunden!
echo   Bitte zuerst setup-windows.bat ausfuehren.
echo.
pause
exit /b 1

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if errorlevel 1 (
    echo.
    echo   [!] Update wurde mit Fehler beendet.
    echo.
    pause
)
