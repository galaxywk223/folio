@echo off
rem folio command line: runs folio.cjs with the Electron runtime inside Folio.exe, so no separate Node.js is needed.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Folio.exe" "%~dp0folio.cjs" %*
endlocal & exit /b %ERRORLEVEL%
