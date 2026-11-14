@echo off
setlocal
set "CLIENT=%~dp0client"
set "ELECTRON=%CLIENT%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo LatexStudio could not start: local Electron is missing.
  echo Install the locked development dependencies first.
  pause
  exit /b 1
)
if not exist "%CLIENT%\out\main\index.js" (
  echo LatexStudio could not start: the latest build is missing.
  echo Build the application first.
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "ELECTRON_RENDERER_URL="
start "" /D "%CLIENT%" "%ELECTRON%" "%CLIENT%"
endlocal
