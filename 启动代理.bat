@echo off
chcp 65001 >nul
title 算上一卦 - 本地 AI 中转服务
cd /d "%~dp0"

echo.
echo   ============================================
echo    算上一卦 · 本地 AI 中转服务
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未找到 Node.js。
  echo   请先安装 Node.js 18 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo   [提示] 未找到 .env 配置文件。
  echo.
  echo   首次使用请先复制 .env.example 为 .env，并填入你的 API Key：
  echo     copy .env.example .env
  echo.
  pause
  exit /b 1
)

echo   正在启动... 浏览器版本会自动连接本服务获得 AI 深度解读。
echo   关闭本窗口即停止服务。
echo.
node server\proxy.js

echo.
echo   服务已停止。
pause
