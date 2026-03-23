@echo off
start "" "%~dp0js8call-map.exe"
timeout /t 3 /nobreak >nul
start "" "http://localhost:8181"
