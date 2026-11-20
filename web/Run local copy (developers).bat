@echo off
title Author's Room
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org then run this again. & pause & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node -v') do set NODEMAJOR=%%v
set NODEMAJOR=%NODEMAJOR:v=%
if %NODEMAJOR% LSS 20 (echo Node.js 20 or newer is needed. You have %NODEMAJOR%. Install the LTS version from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo First run: installing, this takes a minute... & call npm install || (echo Install failed. Check your internet and run again. & pause & exit /b 1))
rem Clear the app's temporary build cache so a fresh start never shows a frozen page after an update.
if exist .next rmdir /s /q .next
start "" cmd /c "timeout /t 12 >nul & start http://localhost:3000"
echo.
echo Author's Room is starting. Your browser opens in a few seconds.
echo Keep this window open while you use the app. Close it when you are done.
echo.
call npm run dev
pause
