@echo off
cd /d "%~dp0"
title Cryovanta - Neon Circuit
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js non trovato. Installa la versione LTS da https://nodejs.org e rilancia questo file.
  echo.
  pause
  exit /b 1
)
node scripts\launch.mjs %*
echo.
pause
