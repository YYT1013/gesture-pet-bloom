@echo off
title Gesture Pet - local dev server
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 goto static-fallback
if not exist "node_modules\vite\bin\vite.js" goto static-fallback

echo Starting Vite at http://127.0.0.1:4173/
call npm run dev -- --host 127.0.0.1 --port 4173 --open
if not errorlevel 1 goto end
echo Vite exited with an error. Falling back to the static server...

:static-fallback
echo Starting dependency-free static server at http://localhost:8766/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"
if errorlevel 1 pause

:end
