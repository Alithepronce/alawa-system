@echo off
title Alawa Management System - Server
cd /d "%~dp0"
echo ================================================
echo   Starting Alawa Management System
echo ================================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js was not found on this computer.
    echo Download it from: https://nodejs.org  (choose the LTS version, 22 or newer)
    pause
    exit /b
)
start "Alawa Server" cmd /c "node server\server.js & pause"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
