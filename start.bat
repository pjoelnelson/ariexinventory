@echo off
title Barcode Inventory Server
cd /d "%~dp0"
node server.js
echo.
echo The server stopped. Press any key to close this window.
pause >nul
