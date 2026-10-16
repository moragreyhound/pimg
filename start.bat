@echo off
rem Start pimg (Node.js port). Usage: start.bat [args...]
rem Example: start.bat --help
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo error: node not found. Install Node.js 18+ from https://nodejs.org/
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo error: npm install failed.
    exit /b 1
  )
)

node "%~dp0bin\pimg.js" %*
