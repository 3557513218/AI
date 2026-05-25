#!/usr/bin/env bash
set -e

echo "============================================"
echo "  本地 AI Chat - 完全本地运行，无需联网"
echo "============================================"
echo ""

# 检查 Ollama
if ! command -v ollama &>/dev/null; then
    echo "[错误] 未检测到 Ollama，请先安装:"
    echo "  curl -fsSL https://ollama.com/install.sh | sh"
    echo "  安装后: ollama pull qwen2.5vl:7b"
    exit 1
fi

echo "[检查] Python 依赖..."
pip install -r requirements.txt -q

echo ""
echo "============================================"
echo "  启动前请确保:"
echo "  1. Ollama 已在后台运行 (ollama serve)"
echo "  2. 已下载模型 (ollama pull qwen2.5:7b)"
echo ""
echo "  访问地址: http://localhost:8080"
echo "  按 Ctrl+C 停止服务器"
echo "============================================"
echo ""

python server.py
