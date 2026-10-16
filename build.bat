@echo off
rem Build the standalone pimg binary (dist\pimg.exe) via Node.js SEA.
rem Requires: node 22+ and npm dependencies installed.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo error: node not found. Install Node.js 22+ from https://nodejs.org/
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 exit /b 1
)

call npm run build:binary
