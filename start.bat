@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem ============================================================
rem  HomeLedger - Windows local launcher
rem  Double-click: check env -> install deps -> start -> open browser
rem
rem  Requires Node.js >= 22.5 (uses built-in node:sqlite, no native build)
rem  Change port below if 5111 is taken.
rem ============================================================

title HomeLedger
set "PORT=5111"

echo.
echo   ==================== HomeLedger ====================
echo.

where node >nul 2>&1
if errorlevel 1 goto no_node

set "NODE_VER="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER goto no_version

rem strip leading v
rem Version check: let Node itself compare, rather than hardcoding "22/23/24"
rem in the batch file. Node 24, 25, ... must all pass; only < 22 should fail.
node -e "const m=+process.versions.node.split('.')[0];process.exit(m>=22?0:1)" >nul 2>&1
if errorlevel 1 goto ver_old

echo   [1/4] Node.js %NODE_VER%  OK
goto node_ok

:ver_old
echo   [X] Node.js version too old: %NODE_VER%
echo.
echo       HomeLedger uses node:sqlite built into Node 22 (no native
echo       modules to compile), so Node.js 22.5 or newer is required.
echo.
echo       Please install Node 22 LTS or newer from https://nodejs.org/
echo       then double-click this file again.
echo.
pause
exit /b 1

:no_version
echo   [X] Cannot read Node.js version
echo.
echo       Please run  node -v  in a terminal to confirm Node works,
echo       then run this file again.
echo.
pause
exit /b 1

:no_node
echo   [X] Node.js not found
echo.
echo       HomeLedger needs Node.js 22.5 or newer (built-in node:sqlite).
echo       Download the LTS from https://nodejs.org/ , install it,
echo       then double-click this file again.
echo.
pause
exit /b 1

:node_ok

if not exist "node_modules" (
  echo   [2/4] First run - installing dependencies ^(only 3 pure JS packages^)...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [X] npm install failed. Check your network and retry.
    echo.
    pause
    exit /b 1
  )
  echo   [2/4] Dependencies installed  OK
) else (
  echo   [2/4] Dependencies ready  OK
)

if not exist "data" mkdir "data" >nul 2>&1

echo   [3/4] Data directory: %cd%\data
echo   [4/4] Starting server...
echo.
echo   ------------------------------------------------------------
echo     Local:    http://localhost:%PORT%
echo     Network:  http://^<this PC's IP^>:%PORT%
echo.
echo     On first start an admin account is created and printed below.
echo     Default:  admin / admin888   - change it after first login.
echo.
echo     Press Ctrl+C or close this window to stop the server.
echo   ------------------------------------------------------------
echo.

rem Open the browser a moment after the server is up.
rem Use ping (not timeout) for the delay: timeout is a Git-Bash builtin on some
rem machines and would break here.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:%PORT%"

rem --no-warnings silences "SQLite is an experimental feature" noise.
rem Harmless, but it looks like an error to a first-time user.
node --no-warnings server.js

echo.
echo   Server stopped.
pause
