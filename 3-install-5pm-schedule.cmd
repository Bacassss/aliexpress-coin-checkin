@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-schedule.ps1" -Time "17:00"
echo.
echo If access was denied, right-click this file and choose Run as administrator.
echo Press any key to close.
pause >nul
