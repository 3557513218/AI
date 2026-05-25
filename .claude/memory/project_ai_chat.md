---
name: AI Chat Project
description: 完全本地运行的 AI 聊天应用，基于 Ollama + Qwen2.5，支持图片/代码分析
type: project
---

# AI Chat Project - 完全本地的 AI 助手

一个完全在本地运行的 AI 聊天应用，类似豆包/Kimi/DeepSeek，无需任何 API 密钥，数据不出本机。

**架构:**
- 后端: Python FastAPI + SSE 流式输出 + 文件处理
- 前端: 现代 Web UI，Markdown 渲染，代码高亮
- AI 引擎: Ollama 本地运行 Qwen2.5-VL 7B 模型（支持文字 + 图片分析）
- 所有数据在本地处理，无需联网

**功能:**
- 实时流式对话 (SSE)
- 图片上传与分析 (支持 Qwen2.5-VL 等视觉模型)
- 代码文件上传与分析 (40+ 编程语言)
- 文件拖拽上传
- 多对话管理 (侧边栏切换)
- Markdown 渲染 + 代码语法高亮
- 模型选择器 (自动检测 Ollama 可用模型)
- 响应式设计 (桌面 + 移动端)

**项目结构:**
- `server.py` - FastAPI 后端 (聊天/上传/流式接口)
- `requirements.txt` - Python 依赖
- `.env` - Ollama 配置
- `static/index.html` - 主页面
- `static/css/style.css` - 样式
- `static/js/app.js` - 前端逻辑
- `start.bat` / `start.sh` - 启动脚本

**使用方法:**
1. 确保 Ollama 已安装并运行
2. 下载模型: `ollama pull qwen2.5:7b`
3. 启动: `pip install -r requirements.txt && python server.py`
4. 访问: `http://localhost:8080`

**安装的模型:** qwen2.5vl:7b (6.0GB, 支持图片分析 + 文字)
