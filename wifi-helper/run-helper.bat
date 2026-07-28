@echo off
title Signal Canvas Wi-Fi Helper
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 wifi_helper.py
) else (
  python wifi_helper.py
)
