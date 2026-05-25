"""
AI Chat Server - 完全本地 AI 聊天应用后端
基于 FastAPI + Ollama 本地模型，支持图片分析、代码分析、流式输出
"""

import os
import json
import base64
import logging
import mimetypes
from pathlib import Path
from typing import Optional
from datetime import datetime

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# ============ 配置 ============
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
ALLOWED_CODE_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json",
    ".java", ".cpp", ".c", ".h", ".hpp", ".go", ".rs", ".rb", ".php",
    ".swift", ".kt", ".scala", ".sh", ".bash", ".zsh", ".sql", ".md",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".svg",
    ".txt", ".log", ".csv", ".env", ".dockerfile", ".gitignore",
    ".vue", ".svelte", ".astro", ".mjs", ".cjs", ".mts", ".cts",
    ".dart", ".lua", ".r", ".pl", ".pm", ".hs", ".ex", ".exs",
    ".erl", ".hrl", ".clj", ".cljs", ".edn", ".scm", ".rkt",
}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB

# Ollama 配置
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "")
# 如果未指定模型，自动检测
VISION_MODEL = os.getenv("VISION_MODEL", "")

# ============ 日志 ============
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ============ FastAPI 应用 ============
app = FastAPI(title="Local AI Chat")

@app.on_event("shutdown")
async def shutdown():
    """服务器关闭时的清理工作"""
    logger.info("服务器正在关闭...")


# 启动时检查 .env 配置
if not os.getenv("OLLAMA_BASE_URL"):
    logger.warning(".env 文件未加载或 OLLAMA_BASE_URL 未设置，使用默认值 http://localhost:11434")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============ Ollama 工具函数 ============
async def ollama_request(method: str, path: str, json_data: dict = None):
    """向 Ollama API 发送请求"""
    url = f"{OLLAMA_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=300.0) as client:
        if method == "GET":
            resp = await client.get(url)
        else:
            resp = await client.post(url, json=json_data)
        resp.raise_for_status()
        return resp


async def check_ollama() -> dict:
    """检查 Ollama 服务状态和可用模型"""
    try:
        resp = await ollama_request("GET", "/api/tags")
        data = resp.json()
        models = [m["name"] for m in data.get("models", [])]
        return {"running": True, "models": models}
    except httpx.ConnectError:
        return {"running": False, "models": []}
    except Exception as e:
        return {"running": False, "models": [], "error": str(e)}


async def get_available_models() -> list[str]:
    """获取 Ollama 中已下载的模型列表"""
    try:
        resp = await ollama_request("GET", "/api/tags")
        data = resp.json()
        return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def pick_best_model(models: list[str], prefer_vision: bool = False) -> str:
    """从可用模型中自动选择最佳模型"""
    if not models:
        return ""

    logger.info(f"可用模型: {models}")

    # 优先使用用户指定的模型
    if prefer_vision and VISION_MODEL and VISION_MODEL in models:
        return VISION_MODEL
    if OLLAMA_MODEL and OLLAMA_MODEL in models:
        return OLLAMA_MODEL

    # 优先级列表：首选 Qwen2.5 和 DeepSeek
    # 有视觉需求的优先选 VL 模型
    if prefer_vision:
        vision_priority = [
            "qwen2.5vl:7b", "qwen2.5vl:72b", "qwen2.5vl:3b",
            "qwen2.5-vl:7b", "qwen2.5-vl:72b", "qwen2.5-vl:3b",
            "llava:13b", "llava:7b", "llava:34b",
            "bakllava:7b",
        ]
        for p in vision_priority:
            for m in models:
                if m.startswith(p.rstrip(":0123456789b")) or m == p:
                    return m

    # 通用模型优先级
    priority = [
        "qwen2.5vl:7b", "qwen2.5vl:14b", "qwen2.5vl:32b", "qwen2.5vl:3b",
        "qwen2.5:7b", "qwen2.5:14b", "qwen2.5:32b", "qwen2.5:3b",
        "deepseek-r1:7b", "deepseek-r1:14b", "deepseek-r1:32b",
        "deepseek-r1:8b",
        "llama3.1:8b", "llama3.1:70b",
        "gemma2:9b", "gemma2:2b",
        "mistral:7b", "mixtral:8x7b",
        "codegemma:7b", "codegemma:2b",
        "phi3:14b", "phi3:3.8b", "phi3:mini",
        "tinyllama:1.1b",
    ]
    for p in priority:
        for m in models:
            if m == p or m.startswith(p.rstrip(":0123456789b") + ":") or m.startswith(p.rstrip(":0123456789b") + "-"):
                return m
    # 如果都不匹配，用第一个
    return models[0]


# ============ 工具函数 ============
def is_vision_model(model: str) -> bool:
    """判断模型是否支持图片分析"""
    name = model.lower()
    vision_keywords = ["vl", "vision", "llava", "bakllava", "cogvlm", "minicpm-v"]
    return any(k in name for k in vision_keywords)


def get_file_category(filename: str, content_type: str) -> str:
    if content_type in ALLOWED_IMAGE_TYPES:
        return "image"
    ext = Path(filename).suffix.lower()
    if ext in ALLOWED_CODE_EXTENSIONS:
        return "code"
    return "other"


def get_system_prompt() -> str:
    from datetime import date
    today = date.today()
    return f"""你是智能 AI 助手，今天是 {today.year} 年 {today.month} 月 {today.day} 日。请遵循以下原则：

1. **回答问题**：准确、简洁、有深度，对复杂问题可以分步骤解释
2. **分析图片**：当用户上传图片时，仔细观察图片内容，详细描述并回答相关问题
3. **分析代码**：当用户上传代码时，理解代码逻辑，指出潜在问题，提供优化建议
4. **编程帮助**：提供代码示例、debug 建议、架构设计等
5. **格式规范**：使用 Markdown 格式，代码块标明语言
6. **中文优先**：默认使用中文回答，除非用户用其他语言提问
7. **诚实透明**：如果不确定或不知道，坦诚说明，不要编造信息
8. **安全负责**：拒绝回答违法、有害、不道德的问题"""


async def read_uploaded_file(file: UploadFile) -> tuple[bytes, str]:
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="文件大小超过限制 (最大 20MB)")
    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    return content, content_type


def build_ollama_messages(
    user_message: str,
    file_content: bytes = None,
    file_name: str = None,
    file_category: str = None,
    content_type: str = None,
) -> list[dict]:
    """构建 Ollama 格式的消息列表"""
    messages = [{"role": "system", "content": get_system_prompt()}]

    if not file_content:
        # 纯文本消息
        messages.append({"role": "user", "content": user_message or "你好"})
        return messages

    # 有文件上传
    if file_category == "image":
        img_base64 = base64.b64encode(file_content).decode("utf-8")
        text_content = user_message.strip() or "请分析这张图片的内容，详细描述你看到的一切。"
        messages.append({
            "role": "user",
            "content": text_content,
            "images": [img_base64],
        })
        return messages

    # 代码文件
    if file_category == "code":
        try:
            code_text = file_content.decode("utf-8")
        except UnicodeDecodeError:
            try:
                code_text = file_content.decode("gbk")
            except UnicodeDecodeError:
                code_text = file_content.decode("latin-1")

        ext = Path(file_name).suffix.lower()
        lang = ext.lstrip(".") if ext else "text"

        if user_message.strip():
            text = f"用户引用了文件 `{file_name}`：\n\n```{lang}\n{code_text}\n```\n\n用户的问题：{user_message}"
        else:
            text = f"请分析以下 `{file_name}` 文件中的代码：\n\n```{lang}\n{code_text}\n```"
        messages.append({"role": "user", "content": text})
        return messages

    # 其他文件
    try:
        file_text = file_content.decode("utf-8")
    except UnicodeDecodeError:
        file_text = f"[二进制文件: {file_name}, 大小: {len(file_content)} bytes]"

    if user_message.strip():
        text = f"用户上传了文件 `{file_name}`：\n\n```\n{file_text}\n```\n\n用户的问题：{user_message}"
    else:
        text = f"用户上传了文件 `{file_name}`，内容如下：\n\n```\n{file_text}\n```"
    messages.append({"role": "user", "content": text})
    return messages


# ============ API 路由 ============
@app.get("/api/health")
async def health():
    """健康检查"""
    ollama_status = await check_ollama()
    models = ollama_status.get("models", [])
    active_model = pick_best_model(models)

    return {
        "status": "ok" if ollama_status["running"] else "error",
        "ollama_running": ollama_status["running"],
        "models": models,
        "active_model": active_model,
        "timestamp": datetime.now().isoformat(),
        "message": "Ollama 运行正常" if ollama_status["running"] else "Ollama 未运行，请先启动 Ollama",
    }


@app.post("/api/chat")
async def chat(
    message: str = Form(""),
    model: str = Form(""),
    file: Optional[UploadFile] = File(None),
):
    """非流式聊天接口"""
    if not message.strip() and not file:
        raise HTTPException(status_code=400, detail="请提供消息内容或上传文件")

    # 检查 Ollama 状态
    ollama_status = await check_ollama()
    if not ollama_status["running"]:
        raise HTTPException(status_code=503, detail="Ollama 未运行，请先启动 Ollama (ollama serve)")

    # 选择模型
    models = ollama_status["models"]
    if not models:
        raise HTTPException(status_code=503, detail="Ollama 中没有可用的模型，请先下载 (ollama pull qwen2.5vl:7b)")

    # 如果有图片文件，优先选择视觉模型
    prefer_vision = bool(file and file.content_type in ALLOWED_IMAGE_TYPES)
    active_model = model or pick_best_model(models, prefer_vision=prefer_vision)
    logger.info(f"使用模型: {active_model}")

    try:
        # 构建消息
        if file:
            file_content, content_type = await read_uploaded_file(file)
            file_category = get_file_category(file.filename or "", content_type)

            # 图片但模型不支持视觉
            if file_category == "image" and not is_vision_model(active_model):
                return {"response": (
                    f"当前模型 `{active_model}` 不支持图片分析。\n\n"
                    f"请安装视觉模型后再试:\n"
                    f"```\nollama pull qwen2.5-vl:7b\n```\n\n"
                    f"或发送文字描述图片内容。"
                )}

            messages = build_ollama_messages(
                message, file_content, file.filename or "file", file_category, content_type
            )
        else:
            messages = build_ollama_messages(message)

        # 调用 Ollama
        resp = await ollama_request("POST", "/api/chat", {
            "model": active_model,
            "messages": messages,
            "stream": False,
        })
        data = resp.json()

        return {"response": data["message"]["content"]}

    except httpx.HTTPStatusError as e:
        logger.error(f"Ollama 错误: {e}")
        raise HTTPException(status_code=502, detail=f"Ollama 请求失败: {e.response.text[:200]}")
    except Exception as e:
        logger.error(f"服务器错误: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"服务器错误: {str(e)}")


@app.post("/api/chat/stream")
async def chat_stream(
    message: str = Form(""),
    model: str = Form(""),
    file: Optional[UploadFile] = File(None),
):
    """流式聊天接口 (SSE)"""
    if not message.strip() and not file:
        raise HTTPException(status_code=400, detail="请提供消息内容或上传文件")

    # 检查 Ollama
    ollama_status = await check_ollama()
    if not ollama_status["running"]:
        async def error_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Ollama 未运行，请先启动 Ollama'})}\n\n"
        return StreamingResponse(error_gen(), media_type="text/event-stream")

    models = ollama_status["models"]
    if not models:
        async def error_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Ollama 中没有可用模型，请先下载模型 (如: ollama pull qwen2.5vl:7b)'})}\n\n"
        return StreamingResponse(error_gen(), media_type="text/event-stream")

    # 读取文件内容（只读一次）
    file_data = None  # (bytes, content_type, category, filename)
    if file:
        raw_bytes, raw_type = await read_uploaded_file(file)
        file_cat = get_file_category(file.filename or "", raw_type)
        file_data = (raw_bytes, raw_type, file_cat, file.filename or "file")

    active_model = model or pick_best_model(models, prefer_vision=(file_data and file_data[2] == "image"))
    logger.info(f"流式使用模型: {active_model}")

    async def generate():
        try:
            if file_data:
                fb, ct, cat, fn = file_data

                # 图片但模型不支持视觉 → 返回错误提示
                if cat == "image" and not is_vision_model(active_model):
                    error_msg = (
                        f"当前模型 `{active_model}` 不支持图片分析。\n\n"
                        f"请安装视觉模型后再试:\n"
                        f"```bash\nollama pull qwen2.5-vl:7b\n```\n\n"
                        f"或发送文字描述图片内容。"
                    )
                    yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"
                    return

                messages = build_ollama_messages(message, fb, fn, cat, ct)
                yield f"data: {json.dumps({'type': 'file_info', 'name': fn, 'category': cat})}\n\n"
            else:
                messages = build_ollama_messages(message)

            # 流式调用 Ollama
            url = f"{OLLAMA_BASE_URL}/api/chat"
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST", url,
                    json={
                        "model": active_model,
                        "messages": messages,
                        "stream": True,
                    }
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                            if "message" in chunk and "content" in chunk["message"]:
                                content = chunk["message"]["content"]
                                if content:
                                    yield f"data: {json.dumps({'type': 'text', 'content': content})}\n\n"
                            if chunk.get("done"):
                                break
                        except json.JSONDecodeError:
                            continue

            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except httpx.HTTPStatusError as e:
            error_msg = f"Ollama 请求失败: {e.response.text[:200]}"
            logger.error(error_msg)
            yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"
        except Exception as e:
            error_msg = f"服务器错误: {str(e)}"
            logger.error(error_msg, exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """上传文件并返回预览信息"""
    content, content_type = await read_uploaded_file(file)
    file_category = get_file_category(file.filename or "", content_type)

    # 安全处理文件名：移除路径分隔符，防止路径遍历
    raw_name = file.filename or "unnamed"
    # 只保留文件名部分，移除所有路径分隔符
    safe_name = Path(raw_name).name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_filename = f"{timestamp}_{safe_name}"
    file_path = UPLOAD_DIR / safe_filename

    with open(file_path, "wb") as f:
        f.write(content)

    result = {
        "filename": file.filename,
        "size": len(content),
        "category": file_category,
        "content_type": content_type,
        "path": f"/uploads/{safe_filename}",
    }

    if file_category == "image":
        result["preview"] = base64.b64encode(content).decode("utf-8")
        result["preview_type"] = content_type

    return result


# ============ 静态文件服务 ============
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/", StaticFiles(directory="static", html=True), name="static")


# ============ 启动入口 ============
def get_lan_ips() -> list[str]:
    """获取本机局域网 IP 地址"""
    import socket
    ips = []
    try:
        hostname = socket.gethostname()
        for addr in socket.gethostbyname_ex(hostname)[2]:
            if addr.startswith(("192.168.", "10.", "172.")):
                ips.append(addr)
    except Exception:
        pass
    # 备用方法
    if not ips:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
            s.close()
        except Exception:
            pass
    return ips


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8080"))
    lan_ips = get_lan_ips()

    print()
    print("=" * 54)
    print("  Local AI Chat is Running")
    print("=" * 54)
    print(f"  Local:     http://localhost:{port}")
    for ip in lan_ips:
        print(f"  Network:   http://{ip}:{port}")
    print(f"  Ollama:    {OLLAMA_BASE_URL}")
    print(f"  Model:     {OLLAMA_MODEL or 'auto'}")
    print("=" * 54)
    print("  Ctrl+C to stop the server")
    print("=" * 54)
    print()

    uvicorn.run("server:app", host=host, port=port, reload=False)
