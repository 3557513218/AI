/**
 * AI Chat 前端应用
 * 支持：文本对话、图片分析、代码分析、流式响应
 */

// ============ 状态管理 ============
const state = {
    conversations: [],
    currentId: null,
    isStreaming: false,
    abortController: null,
    uploadedFile: null,
    currentModel: '',
    availableModels: [],
    ollamaRunning: false,
};

// ============ DOM 引用 ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const elements = {
    sidebar: $('#sidebar'),
    messages: $('#messages'),
    welcome: $('#welcomeScreen'),
    chatContainer: $('#chatContainer'),
    messageInput: $('#messageInput'),
    sendBtn: $('#sendBtn'),
    fileInput: $('#fileInput'),
    filePreview: $('#filePreview'),
    fileIcon: $('#fileIcon'),
    fileName: $('#fileName'),
    fileSize: $('#fileSize'),
    conversationList: $('#conversationList'),
    modelSelect: $('#modelSelect'),
    statusDot: $('#statusDot'),
    statusText: $('#statusText'),
};

// ============ Markdown 渲染 ============
marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
            try { return hljs.highlight(code, { language: lang }).value; } catch (e) { /* fall through */ }
        }
        try {
            const guess = hljs.highlightAuto(code);
            return guess.value;
        } catch (e) { return code; }
    },
});

function renderMarkdown(text) {
    const html = marked.parse(text);
    return DOMPurify.sanitize(html, {
        ADD_TAGS: ['mjx-container', 'math'],
        ADD_ATTR: ['xmlns', 'display', 'data-require-extensions'],
    });
}

// ============ 文件处理 ============
const CODE_EXTENSIONS = new Set([
    'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json',
    'java', 'cpp', 'c', 'h', 'hpp', 'go', 'rs', 'rb', 'php',
    'swift', 'kt', 'scala', 'sh', 'bash', 'zsh', 'sql', 'md',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'svg',
    'txt', 'log', 'csv', 'env', 'dockerfile', 'gitignore',
    'vue', 'svelte', 'astro', 'mjs', 'cjs', 'mts', 'cts',
    'dart', 'lua', 'r', 'pl', 'pm',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

function getFileCategory(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return 'other';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    const icons = {
        py: '🐍', js: '📜', ts: '📘', jsx: '⚛️', tsx: '⚛️',
        html: '🌐', css: '🎨', json: '📋', java: '☕', cpp: '⚙️',
        c: '🔧', go: '🔵', rs: '🦀', rb: '💎', php: '🐘',
        swift: '🍎', kt: '📱', sql: '🗄️', md: '📝',
        yaml: '⚙️', yml: '⚙️', xml: '📰', sh: '💻', bash: '💻',
        vue: '🟢', svelte: '🧡', dart: '🎯', lua: '🌙',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', gif: '🎞️',
        pdf: '📄', txt: '📄', csv: '📊',
    };
    return icons[ext] || '📄';
}

function handleFileSelect(event) {
    const files = event.target.files;
    if (files.length === 0) return;

    // 对于图片，可以多选。目前只处理第一个文件
    const file = files[0];
    state.uploadedFile = file;
    showFilePreview(file);
    elements.messageInput.focus();
}

function showFilePreview(file) {
    const cat = getFileCategory(file.name);
    elements.fileIcon.textContent = getFileIcon(file.name);
    elements.fileName.textContent = file.name;
    elements.fileSize.textContent = formatFileSize(file.size);
    elements.filePreview.style.display = 'flex';
    updateSendButton();
}

function removeFile() {
    state.uploadedFile = null;
    elements.filePreview.style.display = 'none';
    elements.fileInput.value = '';
    updateSendButton();
}

// ============ 拖拽上传 ============
let dragCounter = 0;

document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => { e.preventDefault(); });

elements.chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
        elements.chatContainer.style.border = '2px dashed var(--primary)';
        elements.chatContainer.style.background = 'rgba(108,92,231,0.05)';
    }
});

elements.chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        elements.chatContainer.style.border = 'none';
        elements.chatContainer.style.background = '';
    }
});

elements.chatContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    elements.chatContainer.style.border = 'none';
    elements.chatContainer.style.background = '';

    const file = e.dataTransfer.files[0];
    if (file) {
        state.uploadedFile = file;
        showFilePreview(file);
    }
});

// ============ 图片点击全屏 ============
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('image-preview')) {
        const full = document.createElement('div');
        full.className = 'image-fullscreen';
        const img = document.createElement('img');
        img.src = e.target.src;
        full.appendChild(img);
        full.onclick = () => full.remove();
        document.body.appendChild(full);
    }
});

// ============ 消息管理 ============
function addMessage(role, content, extra = {}) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.dataset.messageId = extra.id || Date.now().toString();

    const avatar = role === 'user' ? '👤' : '🤖';
    const roleName = role === 'user' ? '你' : 'AI';

    let extraHtml = '';
    if (extra.imagePreview) {
        extraHtml = `<img src="${extra.imagePreview}" class="image-preview" alt="上传的图片">`;
    }
    if (extra.fileAttachment) {
        extraHtml = `<div class="file-attachment">
            <span class="file-icon">${extra.fileIcon || '📄'}</span>
            <span class="file-name">${extra.fileName || extra.fileAttachment}</span>
            <span class="file-size">${extra.fileSize || ''}</span>
        </div>` + extraHtml;
    }

    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    msgDiv.innerHTML = `
        <div class="message-avatar">${avatar}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-role">${roleName}</span>
                <span class="message-time">${time}</span>
            </div>
            <div class="message-bubble">
                ${extraHtml}
                ${content ? (role === 'ai' ? renderMarkdown(content) : escapeHtml(content)) : '<div class="typing-indicator"><span></span><span></span><span></span></div>'}
            </div>
        </div>
    `;

    elements.messages.appendChild(msgDiv);
    scrollToBottom();
    return msgDiv;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getLastAiBubble() {
    const msgs = elements.messages.querySelectorAll('.message.ai .message-bubble');
    return msgs[msgs.length - 1];
}

function updateAiMessage(text, isDelta = false) {
    const bubble = getLastAiBubble();
    if (!bubble) return;

    if (isDelta) {
        // 流式更新：替换打字指示器或追加
        const typingIndicator = bubble.querySelector('.typing-indicator');
        if (typingIndicator) {
            bubble.innerHTML = renderMarkdown(text);
        } else {
            // 累加更新：获取纯文本，追加新内容后重新渲染
            // 由于我们使用流式，每次拿到完整增量会更简单
            bubble.innerHTML = renderMarkdown(text);
        }
    } else {
        bubble.innerHTML = renderMarkdown(text);
    }

    // 重新高亮代码块
    bubble.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
    });

    scrollToBottom();
}

function scrollToBottom() {
    const container = elements.chatContainer;
    requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
    });
}

// ============ 对话管理 ============
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getCurrentConversation() {
    return state.conversations.find(c => c.id === state.currentId);
}

function getConversationTitle(messages) {
    if (messages.length === 0) return '新对话';
    const first = messages[0];
    // 提取文本内容作为标题
    let text = '';
    if (typeof first.content === 'string') {
        text = first.content;
    } else if (Array.isArray(first.content)) {
        const textPart = first.content.find(c => c.type === 'text');
        text = textPart?.text || '';
    }
    // 如果包含文件
    if (first.fileName) {
        return `[${first.fileName}] ${text.slice(0, 20)}`;
    }
    return text.slice(0, 30) || '新对话';
}

function switchConversation(id) {
    state.currentId = id;
    renderMessages();
    renderConversationList();
    updateWelcomeVisibility();
}

function newChat() {
    const id = generateId();
    state.conversations.push({ id, messages: [], model: state.currentModel });
    state.currentId = id;
    elements.messages.innerHTML = '';
    renderConversationList();
    updateWelcomeVisibility();
    removeFile();
    elements.messageInput.focus();
}

function createConversationIfNeeded() {
    if (state.currentId) return;
    newChat();
}

function renderConversationList() {
    const list = elements.conversationList;
    list.innerHTML = state.conversations.map(c => {
        const title = getConversationTitle(c.messages);
        const active = c.id === state.currentId ? 'active' : '';
        return `<div class="conversation-item ${active}" onclick="switchConversation('${c.id}')">
            <span class="icon">💬</span>
            <span>${escapeHtml(title)}</span>
        </div>`;
    }).join('') || '<div style="padding:20px;text-align:center;color:var(--text-sidebar-muted);font-size:13px;">暂无对话记录</div>';
}

function renderMessages() {
    const conv = getCurrentConversation();
    elements.messages.innerHTML = '';
    if (!conv) return;

    for (const msg of conv.messages) {
        const extra = {};
        if (msg.fileName && msg.fileCategory === 'image' && msg.filePreview) {
            extra.imagePreview = msg.filePreview;
        }
        if (msg.fileName) {
            extra.fileAttachment = msg.fileName;
            extra.fileIcon = msg.fileIcon || '📄';
            extra.fileSize = msg.fileSize || '';
        }
        addMessage(msg.role, msg.text || '', extra);
    }
}

function updateWelcomeVisibility() {
    const conv = getCurrentConversation();
    const hasMessages = conv && conv.messages.length > 0;

    elements.welcome.style.display = hasMessages ? 'none' : 'flex';
    elements.messages.style.display = hasMessages ? 'flex' : 'none';
}

function clearChat() {
    const conv = getCurrentConversation();
    if (conv) {
        conv.messages = [];
        elements.messages.innerHTML = '';
        updateWelcomeVisibility();
    }
}

// ============ 模型切换 ============
function changeModel() {
    state.currentModel = elements.modelSelect.value;
    const conv = getCurrentConversation();
    if (conv) conv.model = state.currentModel;
}

async function loadModels() {
    try {
        const res = await fetch('/api/health');
        const data = await res.json();
        state.availableModels = data.models || [];
        state.ollamaRunning = data.ollama_running;

        const select = elements.modelSelect;
        select.innerHTML = '<option value="">自动选择</option>';
        for (const m of state.availableModels) {
            const opt = document.createElement('option');
            opt.value = m;
            // 美化显示名称
            const display = m.replace(':7b', '').replace(':latest', '').replace(/-/g, ' ');
            opt.textContent = m;
            select.appendChild(opt);
        }
    } catch (e) {
        console.warn('无法加载模型列表:', e);
    }
}

// ============ 发送消息 ============
async function sendMessage() {
    const text = elements.messageInput.value.trim();
    const file = state.uploadedFile;

    if (!text && !file) return;
    if (state.isStreaming) return;

    createConversationIfNeeded();

    const conv = getCurrentConversation();
    if (!conv) return;

    // 构建用户消息
    let userText = text;
    let userExtra = {};

    if (file) {
        const cat = getFileCategory(file.name);
        userExtra.fileName = file.name;
        userExtra.fileSize = formatFileSize(file.size);
        userExtra.fileIcon = getFileIcon(file.name);
        userExtra.fileCategory = cat;

        if (cat === 'image') {
            const reader = new FileReader();
            const previewPromise = new Promise((resolve) => {
                reader.onload = (e) => {
                    userExtra.imagePreview = e.target.result;
                    resolve();
                };
                reader.onerror = () => {
                    console.warn('图片预览加载失败');
                    resolve();
                };
            });
            reader.readAsDataURL(file);
            await previewPromise;
        }
    }

    // 清空输入框
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    updateSendButton();

    // 先保存到对话历史，再更新界面
    conv.messages.push({
        role: 'user',
        text: userText,
        fileName: file?.name,
        fileCategory: file ? getFileCategory(file.name) : null,
        filePreview: userExtra.imagePreview || null,
        fileIcon: userExtra.fileIcon || null,
        fileSize: userExtra.fileSize || null,
        content: null,
    });

    // 添加用户消息到界面，切换到聊天视图
    addMessage('user', userText || (file ? `[上传文件] ${file.name}` : ''), userExtra);
    updateWelcomeVisibility();

    // 添加 AI 消息占位
    addMessage('ai', '');

    // 设置流式状态
    state.isStreaming = true;
    state.abortController = new AbortController();
    elements.sendBtn.disabled = false;
    elements.messageInput.disabled = true;
    updateSendButtonUI(true);
    scrollToBottom();

    try {
        const formData = new FormData();
        formData.append('message', text);
        if (file) {
            formData.append('file', file);
        }
        formData.append('model', state.currentModel);

        const response = await fetch('/api/chat/stream', {
            method: 'POST',
            body: formData,
            signal: state.abortController.signal,
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ detail: '请求失败' }));
            throw new Error(err.detail || `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    switch (data.type) {
                        case 'text':
                            fullResponse += data.content;
                            updateAiMessage(fullResponse, true);
                            break;
                        case 'error':
                            throw new Error(data.content);
                        case 'done':
                            break;
                    }
                } catch (e) {
                    if (e.message !== 'The operation was aborted') throw e;
                }
            }
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            try {
                const data = JSON.parse(buffer.slice(6));
                if (data.type === 'text') {
                    fullResponse += data.content;
                    updateAiMessage(fullResponse, true);
                }
            } catch (e) { /* ignore parse errors on incomplete chunks */ }
        }

        conv.messages.push({
            role: 'assistant',
            text: fullResponse,
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            // 用户主动取消，保留已生成的内容
            const bubble = getLastAiBubble();
            if (bubble && bubble.querySelector('.typing-indicator')) {
                bubble.innerHTML = '<div style="color:var(--text-secondary);padding:8px;font-size:13px;">已取消生成</div>';
            }
        } else {
            console.error('请求失败:', err);
            const errorBubble = getLastAiBubble();
            if (errorBubble) {
                errorBubble.innerHTML = `<div style="color:#E74C3C;padding:8px;">
                    <strong>出错了</strong><br>
                    <span style="font-size:14px;">${escapeHtml(err.message)}</span>
                </div>`;
            }
        }
    } finally {
        state.isStreaming = false;
        state.abortController = null;
        elements.messageInput.disabled = false;
        updateSendButtonUI(false);
        removeFile();
        updateSendButton();
        elements.messageInput.focus();
        updateWelcomeVisibility();
        renderConversationList();
    }
}

function updateSendButtonUI(isStreaming) {
    if (isStreaming) {
        elements.sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
        elements.sendBtn.title = '停止生成';
        elements.sendBtn.onclick = stopGeneration;
        elements.sendBtn.style.background = '#E74C3C';
    } else {
        elements.sendBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21L23 12 2 3v7l15 2-15 2v7z"/></svg>`;
        elements.sendBtn.title = '发送';
        elements.sendBtn.style.background = '';
        elements.sendBtn.onclick = sendMessage;
    }
}

function stopGeneration() {
    if (state.abortController) {
        state.abortController.abort();
    }
    elements.sendBtn.disabled = true;
    elements.sendBtn.title = '正在停止...';
}

function updateSendButton() {
    const text = elements.messageInput.value.trim();
    const hasFile = !!state.uploadedFile;
    elements.sendBtn.disabled = (!text && !hasFile) || state.isStreaming;
}

// ============ 键盘事件 ============
elements.messageInput.addEventListener('input', () => {
    // 自动调整高度
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = Math.min(elements.messageInput.scrollHeight, 200) + 'px';
    updateSendButton();
});

elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage().catch(err => console.error('发送消息失败:', err));
    }
});

// ============ 侧边栏切换 ============
function toggleSidebar() {
    elements.sidebar.classList.toggle('open');
}

// 移动端点击主区域关闭侧边栏
elements.chatContainer.addEventListener('click', () => {
    if (window.innerWidth <= 768 && elements.sidebar.classList.contains('open')) {
        elements.sidebar.classList.remove('open');
    }
});

// ============ 健康检查 ============
async function checkHealth() {
    try {
        const res = await fetch('/api/health');
        const data = await res.json();
        state.availableModels = data.models || [];

        if (data.backend === 'dashscope') {
            // DashScope 云端模式
            if (data.status === 'ok') {
                elements.statusDot.className = 'status-dot connected';
                elements.statusText.textContent = `通义千问 · ${data.active_model}`;
            } else {
                elements.statusDot.className = 'status-dot disconnected';
                elements.statusText.textContent = 'API Key 未配置';
            }
        } else {
            // Ollama 本地模式
            state.ollamaRunning = data.ollama_running;
            if (!data.ollama_running) {
                elements.statusDot.className = 'status-dot disconnected';
                elements.statusText.textContent = 'Ollama 未运行';
            } else if (data.models.length === 0) {
                elements.statusDot.className = 'status-dot disconnected';
                elements.statusText.textContent = '未下载模型';
            } else {
                elements.statusDot.className = 'status-dot connected';
                const active = data.active_model || data.models[0];
                elements.statusText.textContent = `本地模型 · ${active}`;
            }
        }

        // 加载模型列表到选择器
        await loadModels();
    } catch (e) {
        elements.statusDot.className = 'status-dot disconnected';
        elements.statusText.textContent = '无法连接服务器';
    }
}

// ============ 初始化 ============
function init() {
    // 创建默认对话
    newChat();

    // 加载模型列表 + 健康检查
    checkHealth();

    // 自动调整 textarea 高度
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = elements.messageInput.scrollHeight + 'px';

    console.log('本地 AI Chat 已启动');
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
