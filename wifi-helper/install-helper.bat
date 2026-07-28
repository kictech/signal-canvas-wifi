@echo off
setlocal
title Signal Canvas Wi-Fi Helper Installer

set "INSTALL_DIR=%LOCALAPPDATA%\SignalCanvasWifiHelper"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

xcopy "%~dp0wifi_helper.py" "%INSTALL_DIR%\" /Y /Q >nul
xcopy "%~dp0run-helper.bat" "%INSTALL_DIR%\" /Y /Q >nul
xcopy "%~dp0launch-helper.vbs" "%INSTALL_DIR%\" /Y /Q >nul

reg add "HKCU\Software\Classes\signalcanvas" /ve /d "URL:Signal Canvas Wi-Fi Helper" /f >nul
reg add "HKCU\Software\Classes\signalcanvas" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\signalcanvas\DefaultIcon" /ve /d "%SystemRoot%\System32\wlanapi.dll,0" /f >nul
reg add "HKCU\Software\Classes\signalcanvas\shell\open\command" /ve /d "wscript.exe \"%INSTALL_DIR%\launch-helper.vbs\" \"%%1\"" /f >nul

start "" wscript.exe "%INSTALL_DIR%\launch-helper.vbs"
echo.
echo Signal Canvas Wi-Fi helper installation is complete.
echo You can now return to the website and click Wi-Fi Scan.
echo.
pause
