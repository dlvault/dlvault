@echo off
title dlvault Setup
echo.
echo   Starte dlvault Setup...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"
if errorlevel 1 (
    echo.
    echo   [!] Setup wurde mit Fehler beendet.
    echo.
)
pause
