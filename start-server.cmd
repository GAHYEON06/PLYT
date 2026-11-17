@echo off
setlocal
cd /d "%~dp0"
set PORT=8080
set PLYT_HOST=127.0.0.1
if not exist "%~dp0build\plyt-server.exe" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-server.ps1"
  if errorlevel 1 exit /b 1
)
echo PLYT web: http://127.0.0.1:8080
echo Keep this window open while using PLYT.
"%~dp0build\plyt-server.exe" "%~dp0."
pause

