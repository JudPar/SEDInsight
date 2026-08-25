@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "NODE_DIR=%PROJECT_DIR%..\geopluz-tools\node-v24.19.0-win-x64"
set "PATH=%NODE_DIR%;%PATH%"

cd /d "%PROJECT_DIR%"

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000 -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "GEOPLUZ local" /min "%ComSpec%" /c ""%NODE_DIR%\npm.cmd" run dev -- -H 127.0.0.1 -p 3000"
  timeout /t 5 /nobreak >nul
)

start "" "http://127.0.0.1:3000"
endlocal
