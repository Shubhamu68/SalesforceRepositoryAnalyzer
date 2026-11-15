@echo off
setlocal
cd /d "%~dp0"
title Salesforce Repository Analyzer
if not exist "runtime\node.exe" (
  echo Missing runtime\node.exe. Extract the complete ZIP before launching.
  pause
  exit /b 1
)
"runtime\node.exe" "scripts\launcher.mjs"
if errorlevel 1 (
  echo.
  echo The Analyzer could not start. See the messages above.
  pause
)
endlocal
