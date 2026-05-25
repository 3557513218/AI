@echo off
cd /d "%~dp0"
title Local AI Chat

:: Ollama 路径（固定安装位置）
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

echo ============================================
echo         Local AI Chat
echo ============================================
echo.

:: 检查 Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [!] 请安装 Python: https://www.python.org/downloads/
    pause
    exit /b 1
)

:: 检查 Ollama 是否运行
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | findstr /I "ollama" >nul
if errorlevel 1 (
    echo [!] Ollama 未运行
    echo     请从开始菜单启动 Ollama
    pause
    exit /b 1
)

:: 检查模型
"%OLLAMA_EXE%" list 2>nul | findstr "qwen2.5vl" >nul
if errorlevel 1 (
    echo 正在下载模型 qwen2.5vl:7b...
    "%OLLAMA_EXE%" pull qwen2.5vl:7b
)

:: 安装 Python 依赖
pip install -r requirements.txt >nul 2>&1

:: 启动
echo.
echo ============================================
echo  启动成功!
echo  本机:   http://localhost:8080
echo  按 Ctrl+C 停止服务器
echo ============================================
echo.

python server.py

pause
