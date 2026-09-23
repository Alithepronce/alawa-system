@echo off
chcp 65001 >nul
title نظام إدارة العلوة — منظومة زمام
cd /d "%~dp0"
echo ================================================
echo   تشغيل نظام إدارة العلوة — منظومة زمام الذكية
echo ================================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo تعذر العثور على بيئة Node.js في هذا الحاسوب.
    echo يرجى تثبيت Node.js الإصدار 22 أو أحدث من: https://nodejs.org
    pause
    exit /b
)
start "Alawa Server" cmd /c "node server\server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
