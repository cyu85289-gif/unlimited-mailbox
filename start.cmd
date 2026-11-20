@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 无限邮箱 - 收件箱
echo.
echo   正在启动无限邮箱...
echo.
node --no-warnings server.mjs
echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
