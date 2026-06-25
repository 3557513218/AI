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

KNOWLEDGE_DIR = Path("knowledge")
KNOWLEDGE_DIR.mkdir(exist_ok=True)

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

# AI 后端选择（ollama 或 dashscope）
AI_BACKEND = os.getenv("AI_BACKEND", "dashscope").lower()

# DashScope (通义千问) 配置
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
DASHSCOPE_MODEL = os.getenv("DASHSCOPE_MODEL", "qwen-plus")

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


# ============ DashScope (通义千问) 工具函数 ============
async def dashscope_chat(messages: list, model: str = None) -> str:
    """调用 DashScope 非流式接口"""
    if not DASHSCOPE_API_KEY:
        raise HTTPException(status_code=500, detail="未配置 DashScope API Key，请在 .env 中设置 DASHSCOPE_API_KEY")

    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    data = {
        "model": model or DASHSCOPE_MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 8192,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=data)
        if resp.status_code == 401:
            raise HTTPException(status_code=500, detail="API Key 无效，请检查 .env 中的 DASHSCOPE_API_KEY")
        resp.raise_for_status()
        result = resp.json()
        return result["choices"][0]["message"]["content"]


async def dashscope_stream(messages: list, model: str = None):
    """流式调用 DashScope API (OpenAI 兼容格式)"""
    if not DASHSCOPE_API_KEY:
        yield f"data: {json.dumps({'type': 'error', 'content': '未配置 DashScope API Key'})}\n\n"
        return

    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    data = {
        "model": model or DASHSCOPE_MODEL,
        "messages": messages,
        "stream": True,
        "temperature": 0.3,
        "max_tokens": 8192,
    }
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream("POST", url, headers=headers, json=data) as response:
                if response.status_code == 401:
                    yield f"data: {json.dumps({'type': 'error', 'content': 'API Key 无效，请检查 .env 中的 DASHSCOPE_API_KEY'})}\n\n"
                    return
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    chunk = line[6:]
                    if chunk == "[DONE]":
                        break
                    try:
                        data = json.loads(chunk)
                        delta = data.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield f"data: {json.dumps({'type': 'text', 'content': content})}\n\n"
                    except json.JSONDecodeError:
                        continue

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except httpx.HTTPStatusError as e:
        error_msg = f"DashScope 请求失败: {e.response.text[:200]}"
        logger.error(error_msg)
        yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"
    except Exception as e:
        error_msg = f"DashScope 错误: {str(e)}"
        logger.error(error_msg)
        yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"


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


def search_knowledge_base(query: str) -> str:
    """搜索知识库，返回与查询相关的内容"""
    import re
    if not KNOWLEDGE_DIR.exists():
        return ""

    # 提取中文词组（2字以上）和英文单词
    chinese_terms = re.findall(r'[一-鿿]{2,}', query)
    english_terms = [w.lower() for w in re.findall(r'[a-zA-Z]{2,}', query)]
    terms = chinese_terms + english_terms

    if not terms:
        return ""

    results = []
    for file_path in sorted(KNOWLEDGE_DIR.iterdir()):
        if not file_path.is_file() or file_path.suffix.lower() not in {".md", ".txt", ".json", ".csv"}:
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception:
            continue

        content_lower = content.lower()
        match_count = sum(1 for t in terms if t.lower() in content_lower)

        if match_count > 0:
            # 用匹配度倒序排列
            results.append((match_count, file_path.stem, content))

    if not results:
        return ""

    results.sort(key=lambda x: x[0], reverse=True)

    parts = []
    for _, filename, content in results[:3]:
        parts.append(f"以下是参考资料「{filename}」中的内容：\n{content.strip()}")

    return "\n\n".join(parts)


def get_system_prompt() -> str:
    from datetime import date
    today = date.today()
    weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
    weekday = weekdays[today.weekday()]
    return f"""你是智能 AI 助手，今天是 {today.year} 年 {today.month} 月 {today.day} 日 {weekday}。请遵循以下原则：

1. **开发任务积极协助**：当用户请你写代码、开发项目、制作软件时，要尽力提供帮助。生成完整的代码、给出步骤指导、设计架构，而不是简单说做不到
2. **事实核查要诚实**：当被问到关于特定人物、事件、日期等具体事实时，如果你不确定，必须坦诚说明"我无法确认"，不要编造不存在的信息
3. **分析图片**：用户上传图片时，仔细观察并描述内容
4. **分析代码**：用户上传代码时，分析逻辑并提供优化建议
5. **格式规范**：使用 Markdown 格式，代码块标明语言
6. **中文优先**：默认使用中文回答
7. **安全负责**：拒绝回答违法、有害、不道德的问题"""


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
    knowledge_context: str = None,
) -> list[dict]:
    """构建 Ollama 格式的消息列表"""
    system_prompt = get_system_prompt()

    # 如果有知识库匹配结果，注入到系统提示中
    if knowledge_context:
        system_prompt += (
            '\n\n以下是用户知识库中与问题相关的参考资料，请**优先基于这些资料**回答。'
            '如果资料中包含了完整的答案，直接引用资料回答。'
            '如果资料中没有相关信息，请如实说「未在知识库中找到相关信息」，不要编造：\n\n'
            f'{knowledge_context}'
        )

    messages = [{"role": "system", "content": system_prompt}]

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



@app.post("/api/chat")
async def chat(
    message: str = Form(""),
    model: str = Form(""),
    file: Optional[UploadFile] = File(None),
):
    """非流式聊天接口"""
    if not message.strip() and not file:
        raise HTTPException(status_code=400, detail="请提供消息内容或上传文件")

    # 搜索知识库
    knowledge = search_knowledge_base(message)
    if knowledge:
        logger.info(f"知识库命中，注入上下文")

    # 根据不同后端处理
    active_cfg = load_active_backend()
    bt = active_cfg.get("type", "ollama")
    bc = active_cfg.get("config", {})

    if bt not in ("ollama", "dashscope") and bc:
        # 自定义后端 — 构建消息并调用
        return await _chat_custom(message, model, file, knowledge, bc)
    if AI_BACKEND == "dashscope" or bt == "dashscope":
        return await _chat_dashscope(message, model, file, knowledge)
    else:
        return await _chat_ollama(message, model, file, knowledge)


async def _chat_custom(message: str, model: str, file, knowledge: str, backend_config: dict):
    """自定义后端非流式聊天"""
    knowledge_context = knowledge if knowledge else None
    try:
        if file:
            file_content, content_type = await read_uploaded_file(file)
            file_category = get_file_category(file.filename or "", content_type)
            messages = build_ollama_messages(
                message, file_content, file.filename or "file", file_category, content_type,
                knowledge_context=knowledge_context,
            )
        else:
            messages = build_ollama_messages(message, knowledge_context=knowledge_context)

        response_text = await _chat_custom_backend(messages, backend_config)
        return {"response": response_text}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"自定义后端错误: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"请求失败: {str(e)[:200]}")


async def _stream_custom(message: str, model: str, file_data, knowledge: str, backend_config: dict):
    """自定义后端流式聊天"""
    try:
        if file_data:
            fb, ct, cat, fn = file_data
            yield f"data: {json.dumps({'type': 'file_info', 'name': fn, 'category': cat})}\n\n"
            messages = build_ollama_messages(message, fb, fn, cat, ct,
                knowledge_context=knowledge if knowledge else None)
        else:
            messages = build_ollama_messages(message, knowledge_context=knowledge if knowledge else None)

        async for event in _stream_custom_backend(messages, backend_config):
            yield event
    except Exception as e:
        error_msg = f"自定义后端流式错误: {str(e)}"
        logger.error(error_msg, exc_info=True)
        yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"


def _messages_to_generate_payload(messages: list, stream: bool = True) -> dict:
    """Convert chat messages format to /api/generate compatible payload."""
    system_parts = []
    prompt_parts = []
    images = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            system_parts.append(content)
        elif role == "user":
            # Collect images (Ollama format: base64 in "images" field)
            msg_images = msg.get("images", [])
            if msg_images:
                images.extend(msg_images)
            # Handle multimodal content (DashScope format)
            if isinstance(content, list):
                text_parts = []
                for part in content:
                    if part.get("type") == "text":
                        text_parts.append(part["text"])
                    elif part.get("type") == "image_url":
                        url = part.get("image_url", {}).get("url", "")
                        if url.startswith("data:"):
                            b64 = url.split(",", 1)[-1]
                            images.append(b64)
                prompt_parts.append(f"User: {' '.join(text_parts)}")
            else:
                prompt_parts.append(f"User: {content}")
        elif role == "assistant":
            prompt_parts.append(f"Assistant: {content}")

    prompt_parts.append("Assistant: ")
    payload = {"prompt": "\n".join(prompt_parts), "stream": stream, "options": {"temperature": 0.3}}
    if system_parts:
        payload["system"] = "\n".join(system_parts)
    if images:
        payload["images"] = images
    return payload


async def _try_chat_or_generate(model: str, messages: list, stream: bool = True):
    """Try /api/chat first, fall back to /api/generate on 404."""
    base = OLLAMA_BASE_URL
    opts = {"temperature": 0.3}

    # Try /api/chat
    chat_payload = {"model": model, "messages": messages, **({"stream": stream} if stream else {}), "options": opts}
    if not stream:
        chat_payload["stream"] = False

    client = httpx.AsyncClient(timeout=300.0)
    try:
        if stream:
            req = await client.post(f"{base}/api/chat", json=chat_payload)
        else:
            req = await client.post(f"{base}/api/chat", json=chat_payload)
        req.raise_for_status()
        return req, client, "chat"
    except httpx.HTTPStatusError as e:
        if e.response.status_code != 404:
            await client.aclose()
            raise
        # 404 → fallback to /api/generate
        logger.info("/api/chat 不可用 (Ollama 版本过旧)，降级到 /api/generate")
        gen_payload = _messages_to_generate_payload(messages, stream=stream)
        gen_payload["model"] = model
        if stream:
            req = await client.post(f"{base}/api/generate", json=gen_payload)
        else:
            req = await client.post(f"{base}/api/generate", json=gen_payload)
        req.raise_for_status()
        return req, client, "generate"


async def _chat_ollama(message: str, model: str, file, knowledge: str):
    """Ollama 后端非流式聊天（兼容 /api/chat 和 /api/generate）"""
    ollama_status = await check_ollama()
    if not ollama_status["running"]:
        raise HTTPException(status_code=503, detail="Ollama 未运行，请先启动 Ollama (ollama serve)")
    models = ollama_status["models"]
    if not models:
        raise HTTPException(status_code=503, detail="Ollama 中没有可用的模型，请先下载 (ollama pull qwen2.5vl:7b)")
    prefer_vision = bool(file and file.content_type in ALLOWED_IMAGE_TYPES)
    active_model = model or pick_best_model(models, prefer_vision=prefer_vision)
    logger.info(f"[Ollama] 使用模型: {active_model}")
    try:
        if file:
            file_content, content_type = await read_uploaded_file(file)
            file_category = get_file_category(file.filename or "", content_type)
            if file_category == "image" and not is_vision_model(active_model):
                return {"response": (f"当前模型 `{active_model}` 不支持图片分析。\n请安装视觉模型后再试。\n或发送文字描述图片内容。")}
            messages = build_ollama_messages(message, file_content, file.filename or "file", file_category, content_type, knowledge_context=knowledge if knowledge else None)
        else:
            messages = build_ollama_messages(message, knowledge_context=knowledge if knowledge else None)
        req, client, api_type = await _try_chat_or_generate(active_model, messages, stream=False)
        data = req.json()
        await client.aclose()
        if api_type == "chat":
            return {"response": data["message"]["content"]}
        else:
            return {"response": data.get("response", "")}
    except httpx.HTTPStatusError as e:
        detail = "Ollama 请求失败"
        try:
            detail = f"Ollama 请求失败: {(await e.response.aread())[:200].decode('utf-8', errors='replace')}"
        except Exception:
            pass
        logger.error(detail)
        raise HTTPException(status_code=502, detail=detail)
    except Exception as e:
        logger.error(f"服务器错误: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"服务器错误: {str(e)}")


async def _chat_dashscope(message: str, model: str, file, knowledge: str):
    """DashScope 后端非流式聊天"""
    active_model = model or DASHSCOPE_MODEL
    logger.info(f"[DashScope] 使用模型: {active_model}")

    try:
        if file:
            file_content, content_type = await read_uploaded_file(file)
            file_category = get_file_category(file.filename or "", content_type)

            if file_category == "image":
                # DashScope qwen-vl 系列支持图片，可以通过 OpenAI 兼容格式传 base64
                import base64
                img_b64 = base64.b64encode(file_content).decode("utf-8")
                text = message.strip() or "请分析这张图片的内容"
                messages = [
                    {"role": "system", "content": get_system_prompt()},
                    {"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{img_b64}"}},
                        {"type": "text", "text": text},
                    ]},
                ]
                # 上传图片时自动切换到视觉模型
                active_model = "qwen-vl-plus"
            else:
                messages = build_ollama_messages(
                    message, file_content, file.filename or "file", file_category, content_type,
                    knowledge_context=knowledge if knowledge else None,
                )
        else:
            messages = build_ollama_messages(message, knowledge_context=knowledge if knowledge else None)

        response_text = await dashscope_chat(messages, active_model)
        return {"response": response_text}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DashScope 错误: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"DashScope 请求失败: {str(e)}")


@app.post("/api/chat/stream")
async def chat_stream(
    message: str = Form(""),
    model: str = Form(""),
    file: Optional[UploadFile] = File(None),
):
    """流式聊天接口 (SSE)"""
    if not message.strip() and not file:
        raise HTTPException(status_code=400, detail="请提供消息内容或上传文件")

    # 搜索知识库
    knowledge = search_knowledge_base(message)
    if knowledge:
        logger.info(f"流式: 知识库命中，注入上下文")

    # 读取文件内容（只读一次）
    file_data = None
    if file:
        raw_bytes, raw_type = await read_uploaded_file(file)
        file_cat = get_file_category(file.filename or "", raw_type)
        file_data = (raw_bytes, raw_type, file_cat, file.filename or "file")

    # 检查自定义后端
    active_cfg = load_active_backend()
    bt = active_cfg.get("type", "ollama")
    bc = active_cfg.get("config", {})

    if bt not in ("ollama", "dashscope") and bc:
        generate_func = _stream_custom(message, model, file_data, knowledge, bc)
    elif AI_BACKEND == "dashscope" or bt == "dashscope":
        generate_func = _stream_dashscope(message, model, file_data, knowledge)
    else:
        generate_func = _stream_ollama(message, model, file_data, knowledge)

    return StreamingResponse(
        generate_func,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _stream_ollama(message: str, model: str, file_data, knowledge: str):
    """Ollama 后端流式聊天（兼容 /api/chat 和 /api/generate）"""
    ollama_status = await check_ollama()
    if not ollama_status["running"]:
        yield f"data: {json.dumps({'type': 'error', 'content': 'Ollama 未运行，请先启动 Ollama'})}\n\n"
        return

    models = ollama_status["models"]
    if not models:
        yield f"data: {json.dumps({'type': 'error', 'content': 'Ollama 中没有可用模型，请先下载模型 (如: ollama pull qwen2.5vl:7b)'})}\n\n"
        return

    active_model = model or pick_best_model(models, prefer_vision=(file_data and file_data[2] == "image"))
    logger.info(f"[Ollama] 流式使用模型: {active_model}")

    try:
        if file_data:
            fb, ct, cat, fn = file_data
            if cat == "image" and not is_vision_model(active_model):
                error_msg = (
                    f"当前模型 `{active_model}` 不支持图片分析。\n\n"
                    f"请安装视觉模型后再试:\n"
                    f"```bash\nollama pull qwen2.5-vl:7b\n```\n\n"
                    f"或发送文字描述图片内容。"
                )
                yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"
                return

            messages = build_ollama_messages(message, fb, fn, cat, ct,
                knowledge_context=knowledge if knowledge else None)
            yield f"data: {json.dumps({'type': 'file_info', 'name': fn, 'category': cat})}\n\n"
        else:
            messages = build_ollama_messages(message, knowledge_context=knowledge if knowledge else None)

        async with httpx.AsyncClient(timeout=300.0) as client:
            # Try /api/chat first
            chat_payload = {
                "model": active_model,
                "messages": messages,
                "stream": True,
                "options": {"temperature": 0.3},
            }
            req = client.build_request("POST", f"{OLLAMA_BASE_URL}/api/chat", json=chat_payload)
            response = await client.send(req, stream=True)

            # Fall back to /api/generate on 404
            if response.status_code == 404:
                await response.aclose()
                logger.info("/api/chat 不可用 (Ollama 版本过旧)，降级到 /api/generate")
                gen_payload = _messages_to_generate_payload(messages, stream=True)
                gen_payload["model"] = active_model
                req = client.build_request("POST", f"{OLLAMA_BASE_URL}/api/generate", json=gen_payload)
                response = await client.send(req, stream=True)
                api_type = "generate"
            else:
                api_type = "chat"

            # Handle non-2xx responses manually (read body to get real Ollama error)
            if response.status_code >= 400:
                body = await response.aread()
                raw = body[:300].decode('utf-8', errors='replace')
                logger.error(f"Ollama 返回错误 ({response.status_code}): {raw}")
                # Detect CUDA/OOM errors and suggest fix
                if "CUDA" in raw or "cuda" in raw or "out of memory" in raw.lower():
                    hint = (
                        "GPU 显存不足或 CUDA 驱动不兼容。\n\n"
                        "解决方案：\n"
                        "1. 安装更小的模型：`ollama pull qwen2.5:3b`\n"
                        "2. 强制 CPU 运行：设置环境变量 `OLLAMA_GPU_LAYERS=0` 并重启 Ollama\n"
                        "3. 更新显卡驱动\n\n"
                        f"原始错误: {raw.strip()[:150]}"
                    )
                    yield f"data: {json.dumps({'type': 'error', 'content': hint})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'error', 'content': f'Ollama 请求失败 ({response.status_code}): {raw.strip()[:200]}'})}\n\n"
                return

            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                    content = ""
                    if api_type == "chat" and "message" in chunk and "content" in chunk["message"]:
                        content = chunk["message"]["content"]
                    elif api_type == "generate" and "response" in chunk:
                        content = chunk["response"]
                    if content:
                        yield f"data: {json.dumps({'type': 'text', 'content': content})}\n\n"
                    if chunk.get("done"):
                        break
                except json.JSONDecodeError:
                    continue

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except Exception as e:
        error_msg = f"服务器错误: {str(e)}"
        logger.error(error_msg, exc_info=True)
        yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"


async def _stream_dashscope(message: str, model: str, file_data, knowledge: str):
    """DashScope 后端流式聊天"""
    active_model = model or DASHSCOPE_MODEL
    logger.info(f"[DashScope] 流式使用模型: {active_model}")

    try:
        if file_data:
            fb, ct, cat, fn = file_data
            yield f"data: {json.dumps({'type': 'file_info', 'name': fn, 'category': cat})}\n\n"

            if cat == "image":
                import base64
                img_b64 = base64.b64encode(fb).decode("utf-8")
                text = message.strip() or "请分析这张图片的内容"
                messages = [
                    {"role": "system", "content": get_system_prompt()},
                    {"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": f"data:{ct};base64,{img_b64}"}},
                        {"type": "text", "text": text},
                    ]},
                ]
                active_model = "qwen-vl-plus"
            else:
                messages = build_ollama_messages(message, fb, fn, cat, ct,
                    knowledge_context=knowledge if knowledge else None)
        else:
            messages = build_ollama_messages(message, knowledge_context=knowledge if knowledge else None)

        async for event in dashscope_stream(messages, active_model):
            yield event

    except Exception as e:
        error_msg = f"DashScope 流式错误: {str(e)}"
        logger.error(error_msg, exc_info=True)
        yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"


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


# ============ Workspace 工作空间 ============
WORKSPACE_IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    ".idea", ".vscode", ".vs", "bin", "obj", "dist", "build",
    ".next", ".nuxt", "target", "vendor", ".svn", ".hg",
    ".claude", ".mypy_cache", ".pytest_cache", ".ruff_cache",
}
MAX_FILE_SIZE_FOR_EDITOR = 1024 * 1024  # 1MB - 超过此大小的文件不在编辑器中打开

# 工作空间状态
workspace_state = {"current": None, "name": None}


def safe_resolve(workspace: Path, rel_path: str) -> Path:
    """安全解析文件路径，防止路径遍历攻击"""
    abs_path = (workspace / rel_path).resolve()
    if not str(abs_path).startswith(str(workspace.resolve())):
        raise HTTPException(status_code=403, detail="路径越权")
    return abs_path


def build_file_tree(directory: Path, prefix: str = "") -> list:
    """递归构建文件树结构，用于前端展示"""
    items = []
    try:
        entries = sorted(directory.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
    except PermissionError:
        return items

    for entry in entries:
        if entry.name.startswith(".") and entry.name != ".env.example":
            continue
        if entry.is_dir():
            if entry.name in WORKSPACE_IGNORE_DIRS:
                continue
            children = build_file_tree(entry, prefix + "  ")
            items.append({
                "name": entry.name,
                "path": str(entry.relative_to(workspace_state["current"])),
                "type": "directory",
                "children": children,
            })
        else:
            ext = entry.suffix.lower()
            lang_map = {
                ".py": "python", ".js": "javascript", ".ts": "typescript",
                ".jsx": "javascript", ".tsx": "typescriptreact", ".html": "html",
                ".css": "css", ".json": "json", ".md": "markdown",
                ".java": "java", ".cpp": "cpp", ".c": "c", ".h": "c",
                ".hpp": "cpp", ".go": "go", ".rs": "rust", ".rb": "ruby",
                ".php": "php", ".swift": "swift", ".kt": "kotlin",
                ".sql": "sql", ".yaml": "yaml", ".yml": "yaml",
                ".xml": "xml", ".sh": "shell", ".bash": "shell",
                ".vue": "vue", ".svelte": "svelte", ".scss": "scss",
                ".less": "less", ".dockerfile": "dockerfile",
            }
            items.append({
                "name": entry.name,
                "path": str(entry.relative_to(workspace_state["current"])),
                "type": "file",
                "size": entry.stat().st_size,
                "language": lang_map.get(ext, "text"),
            })

    return items


def get_file_language(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    lang_map = {
        ".py": "python", ".js": "javascript", ".ts": "typescript",
        ".jsx": "javascript", ".tsx": "typescriptreact", ".html": "html",
        ".css": "css", ".json": "json", ".md": "markdown",
        ".java": "java", ".cpp": "cpp", ".c": "c",
        ".go": "go", ".rs": "rust", ".rb": "ruby",
        ".php": "php", ".swift": "swift", ".kt": "kotlin",
        ".sql": "sql", ".yaml": "yaml", ".yml": "yaml",
        ".xml": "xml", ".sh": "shell", ".bash": "shell",
        ".vue": "vue", ".svelte": "svelte", ".scss": "scss",
        ".less": "less", ".dockerfile": "dockerfile",
        ".txt": "text", ".env": "ini", ".gitignore": "ignore",
        ".cfg": "ini", ".ini": "ini", ".conf": "ini",
        ".svg": "xml", ".gradle": "groovy", ".toml": "ini",
        ".mjs": "javascript", ".cjs": "javascript",
    }
    return lang_map.get(ext, "text")


@app.get("/api/workspace/status")
async def workspace_status():
    """获取当前工作空间状态"""
    if not workspace_state["current"]:
        return {"open": False, "path": None, "name": None}
    w_path = workspace_state["current"]
    exists = w_path.exists()
    return {
        "open": exists,
        "path": str(w_path) if exists else None,
        "name": workspace_state["name"] if exists else None,
    }


@app.post("/api/workspace/open")
async def open_workspace(data: dict):
    """打开一个工作空间（目录）"""
    path_str = data.get("path", "").strip()
    if not path_str:
        raise HTTPException(status_code=400, detail="请提供工作空间路径")

    path = Path(path_str).resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"路径不存在: {path_str}")
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="路径必须是目录")

    workspace_state["current"] = path
    workspace_state["name"] = path.name

    tree = build_file_tree(path)
    return {
        "path": str(path),
        "name": path.name,
        "tree": tree,
        "fileCount": sum(1 for _ in path.rglob("*") if _.is_file() and not any(
            p.name in WORKSPACE_IGNORE_DIRS for p in _.parents)),
    }


@app.post("/api/workspace/close")
async def close_workspace():
    """关闭当前工作空间"""
    workspace_state["current"] = None
    workspace_state["name"] = None
    return {"open": False}


@app.post("/api/workspace/read")
async def read_workspace_file(data: dict):
    """读取工作空间中的文件内容"""
    if not workspace_state["current"]:
        raise HTTPException(status_code=400, detail="未打开工作空间")

    rel_path = data.get("path", "")
    if not rel_path:
        raise HTTPException(status_code=400, detail="请提供文件路径")

    abs_path = safe_resolve(workspace_state["current"], rel_path)
    if not abs_path.exists() or not abs_path.is_file():
        raise HTTPException(status_code=404, detail=f"文件不存在: {rel_path}")
    if abs_path.stat().st_size > MAX_FILE_SIZE_FOR_EDITOR:
        raise HTTPException(status_code=413, detail="文件太大，无法在编辑器中打开")

    try:
        content = abs_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            content = abs_path.read_text(encoding="gbk")
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="不支持的文件编码")

    return {
        "path": rel_path,
        "name": abs_path.name,
        "content": content,
        "language": get_file_language(abs_path.name),
        "size": abs_path.stat().st_size,
    }


@app.post("/api/workspace/write")
async def write_workspace_file(data: dict):
    """写入/保存工作空间中的文件"""
    if not workspace_state["current"]:
        raise HTTPException(status_code=400, detail="未打开工作空间")

    rel_path = data.get("path", "")
    content = data.get("content", "")

    if not rel_path:
        raise HTTPException(status_code=400, detail="请提供文件路径")

    abs_path = safe_resolve(workspace_state["current"], rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(content, encoding="utf-8")

    return {"path": rel_path, "saved": True, "size": abs_path.stat().st_size}


@app.post("/api/workspace/create")
async def create_workspace_file(data: dict):
    """在工作空间中创建新文件或目录"""
    if not workspace_state["current"]:
        raise HTTPException(status_code=400, detail="未打开工作空间")

    rel_path = data.get("path", "")
    file_type = data.get("type", "file")  # "file" or "directory"

    if not rel_path:
        raise HTTPException(status_code=400, detail="请提供路径")

    abs_path = safe_resolve(workspace_state["current"], rel_path)
    if abs_path.exists():
        raise HTTPException(status_code=409, detail="路径已存在")

    if file_type == "directory":
        abs_path.mkdir(parents=True)
    else:
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text("", encoding="utf-8")

    return {"path": rel_path, "created": True}


@app.post("/api/workspace/delete")
async def delete_workspace_item(data: dict):
    """删除工作空间中的文件或目录"""
    if not workspace_state["current"]:
        raise HTTPException(status_code=400, detail="未打开工作空间")

    rel_path = data.get("path", "")
    if not rel_path:
        raise HTTPException(status_code=400, detail="请提供路径")

    abs_path = safe_resolve(workspace_state["current"], rel_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="路径不存在")

    if abs_path.is_dir():
        import shutil
        shutil.rmtree(abs_path)
    else:
        abs_path.unlink()

    return {"path": rel_path, "deleted": True}


@app.post("/api/workspace/rename")
async def rename_workspace_item(data: dict):
    """重命名工作空间中的文件或目录"""
    if not workspace_state["current"]:
        raise HTTPException(status_code=400, detail="未打开工作空间")

    old_path = data.get("oldPath", "")
    new_path = data.get("newPath", "")
    if not old_path or not new_path:
        raise HTTPException(status_code=400, detail="请提供旧路径和新路径")

    abs_old = safe_resolve(workspace_state["current"], old_path)
    abs_new = safe_resolve(workspace_state["current"], new_path)

    if not abs_old.exists():
        raise HTTPException(status_code=404, detail="原路径不存在")
    if abs_new.exists():
        raise HTTPException(status_code=409, detail="新路径已存在")

    abs_old.rename(abs_new)
    return {"oldPath": old_path, "newPath": new_path, "renamed": True}


async def _call_ai_for_code(prompt: str, system_extra: str = "") -> str:
    """内部调用 AI 处理代码（非流式），返回结果文本"""
    system_prompt = f"你是一个专业的代码助手。请严格按用户要求输出代码或分析结果。" + system_extra

    messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]

    # 检查自定义后端
    active = load_active_backend()
    backend_type = active.get("type", "ollama")
    config = active.get("config", {})

    if backend_type not in ("ollama", "dashscope") and config:
        return await _chat_custom_backend(messages, config)

    if AI_BACKEND == "dashscope" or backend_type == "dashscope":
        return await dashscope_chat(messages)
    else:
        ollama_status = await check_ollama()
        if not ollama_status["running"]:
            raise HTTPException(status_code=503, detail="Ollama 未运行")
        models = ollama_status["models"]
        if not models:
            raise HTTPException(status_code=503, detail="没有可用模型")
        active_model = pick_best_model(models)

        resp, client, api_type = await _try_chat_or_generate(active_model, messages, stream=False)
        data = resp.json()
        await client.aclose()
        if api_type == "chat":
            return data["message"]["content"]
        else:
            return data.get("response", "")


@app.post("/api/workspace/review")
async def review_code(data: dict):
    """AI 代码审查：检查错误、安全问题、改进建议"""
    content = data.get("content", "")
    filename = data.get("filename", "file")
    lang = get_file_language(filename)

    prompt = f"""请审查以下 {lang} 代码，以 JSON 数组格式返回问题列表（不要加 markdown 包裹）。

逐个检查这些方面：
1. 语法错误和运行时错误
2. 安全漏洞（SQL注入、XSS等）
3. 性能问题
4. 代码逻辑错误
5. 最佳实践违反

每个问题的格式：
{{"severity": "error|warning|info", "line": <行号>, "message": "<描述>", "suggestion": "<修复建议>"}}

如果没有问题，返回空数组 []。

代码：
```{lang}
{content}
```"""

    try:
        result = await _call_ai_for_code(prompt)
        # 清理 markdown 包裹
        result = result.strip()
        if result.startswith("```"):
            result = result.split("\n", 1)[-1]
        if result.endswith("```"):
            result = result.rsplit("\n", 1)[0]
        result = result.strip()
        # 尝试解析 JSON
        try:
            issues = json.loads(result)
        except json.JSONDecodeError:
            issues = [{"severity": "warning", "line": 0, "message": "AI 审查结果解析异常", "suggestion": result[:200]}]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 审查失败: {str(e)}")

    return {"issues": issues, "file": filename}


@app.post("/api/workspace/edit")
async def edit_code_with_ai(data: dict):
    """AI 根据用户需求编辑代码，返回修改后的完整内容（非流式）"""
    return await _process_edit_code(data, stream=False)


@app.post("/api/workspace/edit/stream")
async def edit_code_with_ai_stream(data: dict):
    """AI 根据用户需求编辑代码（流式返回，打字机效果）"""
    content = data.get("content", "")
    message = data.get("message", "")
    filename = data.get("filename", "file")
    lang = get_file_language(filename)

    async def generate():
        try:
            async for chunk in _stream_edit_response(message, filename, content, lang):
                yield chunk
        except Exception as e:
            logger.error(f"编辑流式错误: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _looks_like_code(text: str) -> bool:
    """判断文本是否看起来像代码"""
    code_patterns = [
        'def ', 'class ', 'import ', 'return ',
        'if __name__', 'function ', 'const ', 'let ', 'var ',
        '=>', 'from ', '#include', 'int main', 'public class',
        'void ', 'async def', '@app', 'module.exports',
    ]
    return any(p in text for p in code_patterns)


async def _stream_edit_response(message: str, filename: str, content: str, lang: str):
    """流式处理编辑请求，返回 SSE 事件"""
    prompt = f"""你是一个智能代码助手，正在帮用户处理文件 `{filename}`。

当前文件内容：
```{lang}
{content}
```

用户消息: {message}

请判断用户意图：

如果用户是闲聊或询问代码相关问题（"你好"、"这段代码是做什么的"、"解释一下"等），直接回答即可。

如果用户明确要求修改代码（"帮我改"、"添加功能"、"修复bug"、"重构"等），输出修改后的完整代码。"""

    active_cfg = load_active_backend()
    bt = active_cfg.get("type", "ollama")
    bc = active_cfg.get("config", {})

    if bt not in ("ollama", "dashscope") and bc:
        # 自定义后端 - 非流式
        messages = [{"role": "system", "content": "你是一个专业的代码助手。"}, {"role": "user", "content": prompt}]
        result = await _chat_custom_backend(messages, bc)
        yield f"data: {json.dumps({'type': 'text', 'content': result})}\n\n"
        has_changes = _looks_like_code(result) and result.strip() != content.strip()
        yield f"data: {json.dumps({'type': 'done', 'hasChanges': has_changes, 'modified': result if has_changes else content})}\n\n"
        return

    if AI_BACKEND == "dashscope" or bt == "dashscope":
        # DashScope 流式
        messages = [{"role": "system", "content": "你是一个专业的代码助手。"}, {"role": "user", "content": prompt}]
        full = ""
        async for event in dashscope_stream(messages):
            yield event
            if event.startswith("data: "):
                try:
                    d = json.loads(event[6:])
                    if d.get("type") == "text":
                        full += d["content"]
                except json.JSONDecodeError:
                    pass
        has_changes = _looks_like_code(full) and full.strip() != content.strip()
        yield f"data: {json.dumps({'type': 'done', 'hasChanges': has_changes, 'modified': full if has_changes else content})}\n\n"
        return

    # Ollama 流式
    ollama_status = await check_ollama()
    if not ollama_status["running"]:
        yield f"data: {json.dumps({'type': 'error', 'content': 'Ollama 未运行'})}\n\n"
        return

    models = ollama_status["models"]
    if not models:
        yield f"data: {json.dumps({'type': 'error', 'content': '没有可用模型'})}\n\n"
        return

    active_model = pick_best_model(models)
    messages = [{"role": "system", "content": "你是一个专业的代码助手。"}, {"role": "user", "content": prompt}]

    full_response = ""
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            # Try /api/chat first, fall back to /api/generate
            chat_payload = {"model": active_model, "messages": messages, "stream": True, "options": {"temperature": 0.2}}
            req = client.build_request("POST", f"{OLLAMA_BASE_URL}/api/chat", json=chat_payload)
            response = await client.send(req, stream=True)

            if response.status_code == 404:
                await response.aclose()
                logger.info("/api/chat 不可用，降级到 /api/generate")
                gen_payload = _messages_to_generate_payload(messages, stream=True)
                gen_payload["model"] = active_model
                req = client.build_request("POST", f"{OLLAMA_BASE_URL}/api/generate", json=gen_payload)
                response = await client.send(req, stream=True)
                api_type = "generate"
            else:
                api_type = "chat"

            if response.status_code >= 400:
                body = await response.aread()
                err = body[:200].decode('utf-8', errors='replace')
                yield f"data: {json.dumps({'type': 'error', 'content': f'Ollama 错误: {err}'})}\n\n"
                return

            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                    token = ""
                    if api_type == "chat" and "message" in chunk and "content" in chunk["message"]:
                        token = chunk["message"]["content"]
                    elif api_type == "generate" and "response" in chunk:
                        token = chunk["response"]
                    if token:
                        full_response += token
                        yield f"data: {json.dumps({'type': 'text', 'content': token})}\n\n"
                    if chunk.get("done"):
                        break
                except json.JSONDecodeError:
                    continue

        # 判断是否有代码变更：提取代码块并与原文比较
        has_changes = False
        import re
        code_blocks = re.findall(r'```(?:\w+)?\n(.*?)```', full_response, re.DOTALL)
        if code_blocks:
            combined_code = "\n".join(cb.strip() for cb in code_blocks)
            has_changes = combined_code != content.strip()
            if has_changes:
                full_response = combined_code
        elif _looks_like_code(full_response) and full_response.strip() != content.strip():
            has_changes = True

        yield f"data: {json.dumps({'type': 'done', 'hasChanges': has_changes, 'modified': full_response if has_changes else content})}\n\n"

    except Exception as e:
        logger.error(f"Ollama 流式错误: {e}", exc_info=True)
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"


async def _process_edit_code(data: dict, stream: bool = False):
    """非流式处理编辑请求（保持原来的行为）"""
    content = data.get("content", "")
    message = data.get("message", "")
    filename = data.get("filename", "file")
    lang = get_file_language(filename)

    prompt = f"""你是一个智能代码助手，正在帮用户处理文件 `{filename}`。

当前文件内容：
```{lang}
{content}
```

用户消息: {message}

请判断用户意图，**严格按以下 JSON 格式返回**（不要加 markdown 包裹，不要加 ====，纯 JSON）：

## 如果用户是闲聊或询问代码相关问题（"你好"、"这段代码是做什么的"、"解释一下"、"分析架构"等）：
{{"type": "answer", "content": "你的详细回答"}}

## 如果用户明确要求修改代码（"帮我改"、"添加功能"、"修复bug"、"重构"等）：
{{"type": "code", "content": "修改后的完整代码"}}

注意：
- 用户说"你好"、"在吗"等打招呼或闲聊时，必须走 answer 类型
- 用户问代码相关问题但没说修改时，走 answer 类型
- 只有用户明确要求修改代码时，才走 code 类型
- answer 要详细专业，code 要输出完整可运行的代码"""

    try:
        result = await _call_ai_for_code(prompt, system_extra="\n请严格按 JSON 格式输出，不要加 markdown 包裹。")

        import re

        def try_extract_json(text):
            """Try to find and parse JSON with type/content fields from text."""
            start = text.find('{"type":')
            if start < 0:
                start = text.find('{"type"')
            if start < 0:
                return None
            # Try to find valid JSON by progressively looking for }
            depth = 0
            for end in range(start, len(text)):
                if text[end] == '{':
                    depth += 1
                elif text[end] == '}':
                    depth -= 1
                    if depth == 0:
                        try:
                            candidate = json.loads(text[start:end+1])
                            if "type" in candidate and "content" in candidate:
                                return candidate
                        except json.JSONDecodeError:
                            continue
            return None

        parsed = try_extract_json(result)

        if parsed and parsed.get("type") == "answer":
            response_text = parsed.get("content", result.strip())
            has_changes = False
        elif parsed and parsed.get("type") == "code":
            response_text = parsed.get("content", result.strip())
            has_changes = response_text.strip() != content.strip()
        else:
            response_text = result.strip()
            # 如果结果本身以 {"type": 开头，说明 JSON 解析失败，直接去掉外层 JSON
            if response_text.startswith('{"type":') or response_text.startswith('{"type"'):
                # 尝试更暴力地提取 content
                content_match = re.search(r'"content"\s*:\s*"((?:[^"\\]|\\.)*)"', response_text, re.DOTALL)
                if content_match:
                    response_text = content_match.group(1)
                    has_changes = False
                else:
                    # 直接显示原始结果
                    has_changes = False
            else:
                code_blocks = re.findall(r'```(?:\w+)?\n(.*?)```', result, re.DOTALL)
                if code_blocks and len(code_blocks[0]) > len(content) * 0.5 and code_blocks[0].strip() != content.strip():
                    response_text = code_blocks[0].strip()
                    has_changes = True
                else:
                    has_changes = False

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 处理失败: {str(e)}")

    return {
        "original": content,
        "response": response_text,
        "hasChanges": has_changes,
        "modified": response_text if has_changes else content,
    }


@app.post("/api/workspace/fix")
async def fix_code_with_ai(data: dict):
    """AI 修复代码中的错误"""
    content = data.get("content", "")
    error_description = data.get("error", "")
    filename = data.get("filename", "file")
    lang = get_file_language(filename)

    error_ctx = f"\n需要修复的错误: {error_description}" if error_description else ""
    prompt = f"""以下 {lang} 代码存在错误需要修复。{error_ctx}

请输出 **完整修复后的代码**（不要省略），用 ==== 包裹：

====
<完整修复后的代码>
====

原始代码：
```{lang}
{content}
```"""

    try:
        result = await _call_ai_for_code(prompt, system_extra="\n输出完整修复后的代码。使用 ==== 包裹。")

        import re
        match = re.search(r'====\s*\n(.*?)\n====', result, re.DOTALL)
        if match:
            new_content = match.group(1).strip()
        else:
            code_match = re.search(r'```(?:\w+)?\n(.*?)```', result, re.DOTALL)
            if code_match:
                new_content = code_match.group(1).strip()
            else:
                new_content = result.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 修复失败: {str(e)}")

    return {
        "original": content,
        "modified": new_content,
        "hasChanges": new_content != content,
    }


@app.post("/api/workspace/generate")
async def generate_code(data: dict):
    """AI 生成新的代码文件"""
    message = data.get("message", "")
    context = data.get("context", "")

    context_str = f"\n项目上下文:\n{context}" if context else ""
    prompt = f"""根据以下需求生成代码{context_str}：

{message}

请生成完整的、可直接运行的代码。输出格式：
====
<文件路径（相对于项目根目录）>
====
<文件内容>
====

如果涉及多个文件，重复以上格式。"""

    try:
        result = await _call_ai_for_code(prompt, system_extra="\n输出完整代码，使用 ==== 分隔。生成可直接运行的项目代码。")

        # 解析生成结果，可能有多个文件
        files = []
        current_file = {"path": "", "content": ""}
        in_content = False
        in_path = False

        for line in result.split("\n"):
            if line.strip() == "====":
                if in_content:
                    files.append(current_file)
                    current_file = {"path": "", "content": ""}
                    in_content = False
                    in_path = True
                else:
                    in_path = True
                continue
            if in_path:
                current_file["path"] = line.strip()
                in_path = False
                in_content = True
            elif in_content:
                current_file["content"] += line + "\n"

        if current_file["content"] and current_file["path"]:
            files.append(current_file)

        # 清理 content 末尾换行
        for f in files:
            f["content"] = f["content"].rstrip("\n")

        if not files:
            # fallback: 整个结果作为一个文件
            files = [{"path": "generated", "content": result.strip()}]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")

    return {"files": files}


# ============ 自定义后端配置 (CC Switch 风格) ============
CONFIG_DIR = Path("config")
CONFIG_DIR.mkdir(exist_ok=True)
CUSTOM_BACKENDS_FILE = CONFIG_DIR / "custom_backends.json"
ACTIVE_BACKEND_FILE = CONFIG_DIR / "active_backend.json"


def load_custom_backends() -> dict:
    if CUSTOM_BACKENDS_FILE.exists():
        try:
            return json.loads(CUSTOM_BACKENDS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, Exception):
            return {}
    return {}


def save_custom_backends(backends: dict):
    CUSTOM_BACKENDS_FILE.write_text(json.dumps(backends, ensure_ascii=False, indent=2), encoding="utf-8")


def load_active_backend() -> dict:
    if ACTIVE_BACKEND_FILE.exists():
        try:
            return json.loads(ACTIVE_BACKEND_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, Exception):
            return {"type": "ollama"}
    return {"type": "ollama"}


def save_active_backend(config: dict):
    ACTIVE_BACKEND_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def get_active_chat_backend() -> str:
    """Get the active backend type: 'ollama', 'dashscope', or custom backend name"""
    return load_active_backend().get("type", "ollama")


@app.get("/api/settings/backends")
async def list_backends():
    """获取所有自定义后端配置"""
    backends = load_custom_backends()
    active = load_active_backend()
    dashscope_configured = bool(DASHSCOPE_API_KEY)
    builtin = [{"id": "ollama", "name": "Ollama (本地)", "type": "builtin"}]
    if dashscope_configured:
        builtin.append({"id": "dashscope", "name": "通义千问 (DashScope)", "type": "builtin"})
    return {
        "backends": backends,
        "active": active,
        "builtin": builtin,
        "dashscope_configured": dashscope_configured,
    }


@app.post("/api/settings/backends")
async def save_backend(data: dict):
    """保存/更新一个自定义后端配置"""
    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请提供后端名称")

    backends = load_custom_backends()
    backends[name] = {
        "name": name,
        "base_url": data.get("base_url", "").rstrip("/"),
        "api_key": data.get("api_key", ""),
        "model": data.get("model", ""),
        "provider": data.get("provider", "openai"),  # openai, anthropic
    }
    save_custom_backends(backends)
    return {"saved": True, "name": name}


@app.delete("/api/settings/backends")
async def delete_backend(data: dict):
    """删除一个自定义后端配置"""
    name = data.get("name", "")
    backends = load_custom_backends()
    if name in backends:
        del backends[name]
        save_custom_backends(backends)
    return {"deleted": True}


@app.post("/api/settings/activate-backend")
async def activate_backend(data: dict):
    """激活一个后端（ollama / dashscope / 自定义名称）"""
    backend_type = data.get("type", "ollama")
    config = {"type": backend_type}

    if backend_type not in ("ollama", "dashscope"):
        # 自定义后端：查找配置
        backends = load_custom_backends()
        if backend_type not in backends:
            raise HTTPException(status_code=404, detail=f"后端 '{backend_type}' 未配置")
        config["config"] = backends[backend_type]

    save_active_backend(config)
    return {"active": config}


@app.post("/api/settings/test-backend")
async def test_backend(data: dict):
    """测试后端连接"""
    base_url = data.get("base_url", "").rstrip("/")
    api_key = data.get("api_key", "")
    model = data.get("model", "")
    provider = data.get("provider", "openai")

    if not base_url:
        raise HTTPException(status_code=400, detail="请提供 API 地址")

    try:
        if provider == "anthropic":
            url = f"{base_url}/v1/messages"
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
            json_data = {
                "model": model or "claude-sonnet-4-20250514",
                "max_tokens": 50,
                "messages": [{"role": "user", "content": "Hi"}],
            }
        else:
            # OpenAI 兼容格式
            url = f"{base_url}/chat/completions"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            json_data = {
                "model": model or "gpt-4o-mini",
                "messages": [{"role": "user", "content": "Hi"}],
                "max_tokens": 10,
            }

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=json_data)

            if resp.status_code == 401:
                return {"success": False, "error": "API Key 无效 (401)"}
            if resp.status_code == 404:
                return {"success": False, "error": "端点不存在 (404)，请检查 URL"}
            if resp.status_code == 429:
                return {"success": False, "error": "请求过多 (429)，请稍后重试"}

            resp.raise_for_status()
            return {"success": True, "message": f"连接成功 · 模型: {model or 'default'}"}

    except httpx.ConnectError:
        return {"success": False, "error": "无法连接到服务器，请检查 URL 和网络"}
    except httpx.TimeoutException:
        return {"success": False, "error": "连接超时，请检查 URL 是否正确"}
    except Exception as e:
        return {"success": False, "error": f"连接失败: {str(e)[:100]}"}


async def _chat_custom_backend(messages: list, backend_config: dict) -> str:
    """使用自定义 OpenAI 兼容后端进行聊天"""
    base_url = backend_config.get("base_url", "")
    api_key = backend_config.get("api_key", "")
    model = backend_config.get("model", "gpt-4o-mini")
    provider = backend_config.get("provider", "openai")

    if provider == "anthropic":
        url = f"{base_url}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        # 转换消息格式
        system_msg = None
        anthro_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_msg = msg["content"]
            else:
                anthro_messages.append({"role": msg["role"], "content": msg["content"]})

        json_data = {
            "model": model,
            "max_tokens": 4096,
            "messages": anthro_messages,
        }
        if system_msg:
            json_data["system"] = system_msg

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, json=json_data)
            resp.raise_for_status()
            result = resp.json()
            return result["content"][0]["text"]
    else:
        # OpenAI 兼容格式
        url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        json_data = {
            "model": model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 8192,
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, json=json_data)
            resp.raise_for_status()
            result = resp.json()
            return result["choices"][0]["message"]["content"]


async def _stream_custom_backend(messages: list, backend_config: dict):
    """使用自定义 OpenAI 兼容后端进行流式聊天"""
    base_url = backend_config.get("base_url", "")
    api_key = backend_config.get("api_key", "")
    model = backend_config.get("model", "gpt-4o-mini")
    provider = backend_config.get("provider", "openai")

    if provider == "anthropic":
        url = f"{base_url}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        system_msg = None
        anthro_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_msg = msg["content"]
            else:
                anthro_messages.append({"role": msg["role"], "content": msg["content"]})

        json_data = {
            "model": model,
            "max_tokens": 4096,
            "stream": True,
            "messages": anthro_messages,
        }
        if system_msg:
            json_data["system"] = system_msg

        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream("POST", url, headers=headers, json=json_data) as response:
                    response.raise_for_status()
                    buffer = ""
                    async for chunk in response.aiter_bytes():
                        buffer += chunk.decode("utf-8")
                        # SSE parse
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            if line.startswith("data: "):
                                data_str = line[6:]
                                if data_str == "[DONE]":
                                    break
                                try:
                                    data_obj = json.loads(data_str)
                                    if data_obj["type"] == "content_block_delta":
                                        yield f"data: {json.dumps({'type': 'text', 'content': data_obj['delta'].get('text', '')})}\n\n"
                                except json.JSONDecodeError:
                                    continue
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': f'请求失败: {str(e)[:100]}'})}\n\n"
            return
    else:
        # OpenAI 兼容格式流式
        url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        json_data = {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": 0.3,
            "max_tokens": 8192,
        }

        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream("POST", url, headers=headers, json=json_data) as response:
                    if response.status_code == 401:
                        yield f"data: {json.dumps({'type': 'error', 'content': 'API Key 无效'})}\n\n"
                        return
                    response.raise_for_status()

                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        chunk = line[6:]
                        if chunk == "[DONE]":
                            break
                        try:
                            data_obj = json.loads(chunk)
                            delta = data_obj.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield f"data: {json.dumps({'type': 'text', 'content': content})}\n\n"
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': f'流式请求失败: {str(e)[:100]}'})}\n\n"
            return

    yield f"data: {json.dumps({'type': 'done'})}\n\n"


# 重写 health 检查以支持自定义后端
@app.get("/api/health")
async def health_with_custom():
    """健康检查（支持自定义后端）"""
    active = load_active_backend()
    backend_type = active.get("type", "ollama")
    config = active.get("config", {})

    if backend_type != "ollama" and backend_type != "dashscope":
        # 自定义后端
        return {
            "status": "ok",
            "backend": "custom",
            "active_model": config.get("model", "unknown"),
            "models": [config.get("model", "custom")],
            "custom_provider": config.get("provider", "openai"),
            "timestamp": datetime.now().isoformat(),
            "message": f"自定义后端: {config.get('name', backend_type)} · {config.get('model', '')}",
        }

    if backend_type == "dashscope":
        if not DASHSCOPE_API_KEY:
            return {
                "status": "error",
                "backend": "dashscope",
                "active_model": DASHSCOPE_MODEL,
                "models": [],
                "timestamp": datetime.now().isoformat(),
                "message": "未配置 DashScope API Key",
            }
        return {
            "status": "ok",
            "backend": "dashscope",
            "active_model": DASHSCOPE_MODEL,
            "models": [DASHSCOPE_MODEL],
            "timestamp": datetime.now().isoformat(),
            "message": f"DashScope 已连接 · 模型: {DASHSCOPE_MODEL}",
        }

    # Ollama 模式
    try:
        ollama_status = await check_ollama()
        models = ollama_status.get("models", [])
        active_model = pick_best_model(models)
        return {
            "status": "ok" if ollama_status["running"] else "error",
            "backend": "ollama",
            "ollama_running": ollama_status["running"],
            "models": models,
            "active_model": active_model,
            "timestamp": datetime.now().isoformat(),
            "message": "Ollama 运行正常" if ollama_status["running"] else "Ollama 未运行",
        }
    except Exception as e:
        return {
            "status": "error",
            "backend": "ollama",
            "models": [],
            "active_model": "",
            "timestamp": datetime.now().isoformat(),
            "message": f"Ollama 检查失败: {str(e)[:50]}",
        }


# ============ 安全校验系统 ============
# 危险模式检查 - 检测 AI 生成代码中的安全隐患

SUSPICIOUS_PATTERNS = [
    # Python 危险函数
    (r'\beval\s*\(', '高危', '使用 eval() 执行动态代码可能导致代码注入攻击'),
    (r'\bexec\s*\(', '高危', '使用 exec() 执行动态代码可能导致代码注入攻击'),
    (r'__import__\s*\(', '高危', '动态导入可能导致代码注入'),
    (r'\bcompile\s*\(', '高危', '动态编译代码可能导致代码注入'),
    # 危险系统调用
    (r'os\.system\s*\(', '高危', '直接执行系统命令可能导致命令注入'),
    (r'os\.popen\s*\(', '高危', '执行系统命令可能导致命令注入'),
    (r'subprocess\.(call|Popen|run|check_call|check_output)\s*\(', '高危', '执行系统命令可能导致命令注入'),
    (r'shutil\.rmtree\s*\(', '警告', '递归删除目录可能导致数据丢失'),
    # 文件操作
    (r'open\s*\(\s*[\'"]\s*w', '警告', '以写入模式打开文件可能覆盖现有数据'),
    (r'os\.remove\s*\(', '警告', '删除文件操作请确认路径正确'),
    (r'os\.unlink\s*\(', '警告', '删除文件操作请确认路径正确'),
    (r'os\.rmdir\s*\(', '警告', '删除目录操作请确认路径正确'),
    # 网络请求
    (r'requests?\.(get|post|put|delete|patch)\s*\(', '警告', '发起网络请求，请确认目标地址可信'),
    (r'urllib\.request', '警告', '发起网络请求，请确认目标地址可信'),
    (r'httpclient|httpx\.(get|post|put|delete)', '警告', '发起网络请求，请确认目标地址可信'),
    # 编码/混淆
    (r'base64\.b64(de|en)code\s*\(', '警告', 'Base64 编码/解码可能用于隐藏恶意代码'),
    (r'\.decode\s*\(\s*[\'"]rot13', '警告', 'ROT13 编码可能用于混淆'),
    # JavaScript 危险
    (r'new\s+Function\s*\(', '高危', '动态创建函数可能导致代码注入'),
    (r'document\.write\s*\(', '警告', 'document.write 可能引发 XSS 攻击'),
    (r'innerHTML\s*=', '警告', '直接设置 innerHTML 可能引发 XSS 攻击'),
    (r'localStorage|sessionStorage', '信息', '使用浏览器存储，敏感数据不应明文存储'),
    # 数据库
    (r'DROP\s+TABLE', '高危', 'DROP TABLE 将永久删除数据表'),
    (r'TRUNCATE\s+TABLE', '高危', 'TRUNCATE 将清空数据表'),
    (r'DELETE\s+FROM.*WHERE', '警告', 'DELETE 操作请确保 WHERE 条件正确'),
    # 注入风险
    (r'f[\'"]\s*\+\s*[\'"]SELECT', '高危', '字符串拼接 SQL 查询可能导致 SQL 注入'),
    (r'\+\s*[\'"]\s*\+\s*(request|input|param|body)', '警告', '直接将用户输入拼接到代码中可能导致注入'),
    # 其他
    (r'pickle\.loads?\s*\(', '高危', 'pickle 反序列化可能执行任意代码'),
    (r'socket\.\w+\s*\(', '警告', 'Socket 操作可能用于网络通信，请确认用途'),
    (r'token|secret|password|credential|apikey[\s\'\"]{0,3}=[\s\'\"]{0,3}(?!\*|x)', '警告', '代码中可能包含硬编码的密钥/密码'),
    (r'cryptominer|coinbase|binance|wallet', '警告', '包含加密货币相关代码，请确认用途'),
]


@app.post("/api/security/scan")
async def security_scan(data: dict):
    """扫描代码中的安全隐患"""
    content = data.get("content", "")
    filename = data.get("filename", "file")
    ext = Path(filename).suffix.lower()

    findings = []

    # 1. 模式匹配扫描
    import re
    for pattern, severity, description in SUSPICIOUS_PATTERNS:
        matches = re.finditer(pattern, content, re.IGNORECASE | re.MULTILINE)
        for match in matches:
            # 计算行号
            line_num = content[:match.start()].count('\n') + 1
            # 获取匹配行内容
            lines = content.split('\n')
            line_content = lines[line_num - 1].strip() if line_num <= len(lines) else ""

            # 去重：同一行同一模式的只报告一次
            existing = [f for f in findings
                        if f["line"] == line_num and f["pattern"] == pattern]
            if existing:
                continue

            findings.append({
                "severity": severity,
                "line": line_num,
                "code": line_content[:100],
                "pattern": pattern,
                "description": description,
            })

    # 2. 检查已知恶意包名（Node.js）
    malicious_packages = {
        "npm": [
            "electron-native-notify", "node-hc-window", "klow", "okhttp",
            "rpc-websocket", "event-stream", "flatmap-stream",
        ],
        "pip": [
            "python3-dateutil", "jeIlyfish", "tensorflow-gpu-macos",
        ],
    }

    for registry, packages in malicious_packages.items():
        for pkg in packages:
            if pkg.lower() in content.lower():
                findings.append({
                    "severity": "高危",
                    "line": 1,
                    "code": f"[引用已知恶意包] {pkg}",
                    "pattern": pkg,
                    "description": f"已知恶意 {registry} 包「{pkg}」，请勿使用",
                })

    summary = {"high": 0, "warning": 0, "info": 0}
    for f in findings:
        if f["severity"] == "高危":
            summary["high"] += 1
        elif f["severity"] == "警告":
            summary["warning"] += 1
        else:
            summary["info"] += 1

    overall = "safe"
    if summary["high"] > 0:
        overall = "danger"
    elif summary["warning"] > 0:
        overall = "warning"

    # 为每个文件添加安全评分（0-100）
    score = 100
    score -= summary["high"] * 30
    score -= summary["warning"] * 10
    score -= summary["info"] * 3
    score = max(0, score)

    return {
        "findings": findings,
        "summary": summary,
        "overall": overall,
        "score": score,
        "filename": filename,
    }


# ============ 静态文件服务 ============
@app.middleware("http")
async def no_cache_js_css(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

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
    active = load_active_backend()
    bt = active.get("type", "ollama")
    bc = active.get("config", {})
    if bt not in ("ollama", "dashscope") and bc:
        print(f"  Backend:   自定义 · {bc.get('name', bt)}")
        print(f"  Model:     {bc.get('model', '?')}")
        print(f"  Endpoint:  {bc.get('base_url', '?')}")
    elif AI_BACKEND == "dashscope" or bt == "dashscope":
        print(f"  Backend:   DashScope (通义千问)")
        print(f"  Model:     {DASHSCOPE_MODEL}")
    else:
        print(f"  Backend:   Ollama (本地)")
        print(f"  Ollama:    {OLLAMA_BASE_URL}")
        print(f"  Model:     {OLLAMA_MODEL or 'auto'}")
    print("=" * 54)
    print("  Ctrl+C to stop the server")
    print("=" * 54)
    print()

    uvicorn.run("server:app", host=host, port=port, reload=False)
