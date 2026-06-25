/**
 * AI Studio — 企业级 AI 编程工作台
 * 支持：智能对话 · 代码编辑 · AI 代码审查/修复/生成
 */

// ===================================================================
// 状态管理
// ===================================================================
const AppState = {
  conversations: [],
  currentConvId: null,
  isStreaming: false,
  abortController: null,
  uploadedFile: null,
  currentModel: '',
  // Workspace
  workspace: { open: false, path: null, name: null, tree: [], dirHandle: null },
  openFiles: [],        // [{path, name, language, content, dirty}]
  activeFilePath: null,
  fileHandles: {},      // path -> FileSystemFileHandle
  // Edit & Diff
  pendingDiff: null,    // {original, modified, path}
  // Monaco
  monacoReady: false,
  editor: null,         // Monaco editor instance
  diffEditor: null,     // Monaco diff editor instance
  editorModel: null,    // Monaco model for current file
  // Editor Chat
  editorChatHistory: [],
  // Dark mode
  darkMode: false,
};

// ===================================================================
// DOM 引用
// ===================================================================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const El = {};

function initDoms() {
  const ids = ['messages','welcomeScreen','messageInput','sendBtn','fileInput','filePreview',
    'fileIcon','fileName','fileSize','conversationList','modelSelect','statusDot','statusText',
    'chatContainer','workspaceSelector','workspaceDisplay','workspaceModal','workspacePathInput',
    'fileTree','sidebar','editorTabs','editorTabsEmpty','editorContainer','editorPlaceholder',
    'editorReal','editorChatPanel','editorChatMessages','editorChatInput','statusWorkspace',
    'statusFileCount','statusBackend','statusCursor','settingsModal','settingsPath',
    'settingsIgnoreInput','settingsFilterInput','recentWorkspaceList',
    'editorTab','viewChat','viewEditor','sidebarChat','sidebarWorkspace',
    'workspaceTitle','tabBar','diffContainer','diffEditor','connectionStatus','openWorkspaceBtn',
    'backendModal','bcName','bcUrl','bcApiKey','bcModel','bcProvider','testBtn','testResult',
    'savedBackendsList','backendTabs','customBackendTab','customBackendForm','openWorkspaceBtn',
    'workspaceEmptyView','workspaceOpenView','sidebarRecentList'];
  ids.forEach(id => { El[id] = $(`#${id}`); });
}

// ===================================================================
// 工具函数
// ===================================================================
function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2,5); }

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getFileExt(name) { return name.split('.').pop()?.toLowerCase() || ''; }

const IMG_EXTS = new Set(['png','jpg','jpeg','webp','gif','bmp']);
const CODE_EXTS = new Set(['py','js','ts','jsx','tsx','html','css','json',
  'java','cpp','c','h','hpp','go','rs','rb','php','swift','kt','sql','md',
  'yaml','yml','xml','sh','bash','vue','svelte','dart','lua','r','pl','pm',
  'scala','tex','gradle','cfg','ini','conf','toml','dockerfile','gitignore',
  'mjs','cjs','mts','cts','astro','svg','env','log','csv','txt']);

function fileCategory(name) {
  const e = getFileExt(name);
  if (IMG_EXTS.has(e)) return 'image';
  if (CODE_EXTS.has(e)) return 'code';
  return 'other';
}

function fileIcon(name) {
  const e = getFileExt(name);
  const m = {
    py:'🐍',js:'📜',ts:'📘',jsx:'⚛️',tsx:'⚛️',html:'🌐',css:'🎨',json:'📋',
    java:'☕',cpp:'⚙️',c:'🔧',go:'🔵',rs:'🦀',rb:'💎',php:'🐘',swift:'🍎',
    kt:'📱',sql:'🗄️',md:'📝',yaml:'⚙️',yml:'⚙️',xml:'📰',sh:'💻',bash:'💻',
    vue:'🟢',svelte:'🧡',dart:'🎯',lua:'🌙',png:'🖼️',jpg:'🖼️',jpeg:'🖼️',
    webp:'🖼️',gif:'🎞️',pdf:'📄',txt:'📄',csv:'📊',toml:'⚙️',gradle:'🏗️',
    dockerfile:'🐳',gitignore:'📄',
  };
  return m[e] || '📄';
}

// ===================================================================
// Markdown 渲染（安全兼容 CDN 加载失败）
// ===================================================================
try {
  if (typeof marked !== 'undefined' && marked.setOptions) {
    marked.setOptions({ breaks: true, gfm: true,
      highlight: function(code, lang) {
        if (typeof hljs === 'undefined') return code;
        if (lang && hljs.getLanguage(lang)) { try { return hljs.highlight(code,{language:lang}).value; } catch(e) {} }
        try { return hljs.highlightAuto(code).value; } catch(e) { return code; }
      }
    });
  }
} catch(e) { console.warn('Markdown 渲染初始化失败:', e); }

function renderMd(text) {
  if (typeof marked === 'undefined') return '<pre>' + escapeHtml(text) + '</pre>';
  try {
    const html = marked.parse(text);
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html, {
        ADD_TAGS: ['mjx-container','math'],
        ADD_ATTR: ['xmlns','display','data-require-extensions'],
      });
    }
    return html;
  } catch(e) {
    return '<pre>' + escapeHtml(text) + '</pre>';
  }
}

// ===================================================================
// Monaco Editor 初始化
// ===================================================================
let monacoInitPromise = null;

function initMonaco() {
  if (monacoInitPromise) return monacoInitPromise;
  monacoInitPromise = new Promise((resolve) => {
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
    require(['vs/editor/editor.main'], () => {
      AppState.monacoReady = true;
      // Define custom theme
      monaco.editor.defineTheme('ai-studio', {
        base: 'vs',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '6C7086' },
          { token: 'keyword', foreground: '007AFF' },
          { token: 'string', foreground: '34C759' },
          { token: 'number', foreground: 'FF9500' },
          { token: 'type', foreground: 'AF52DE' },
          { token: 'function', foreground: '5856D6' },
        ],
        colors: {
          'editor.background': '#FFFFFF',
          'editor.foreground': '#1D1D1F',
          'editor.lineHighlightBackground': '#F5F5F7',
          'editor.selectionBackground': '#B3D7FF',
          'editorCursor.foreground': '#007AFF',
          'editorLineNumber.foreground': '#C7C7CC',
          'editorLineNumber.activeForeground': '#86868B',
          'editorBracketMatch.background': '#D1E8FF',
          'editorBracketMatch.border': '#007AFF',
          'editorGutter.background': '#FAFAFA',
          'editorWhitespace.foreground': '#E5E5EA',
        }
      });
      monaco.editor.defineTheme('ai-studio-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '6C7086' },
          { token: 'keyword', foreground: '5E9CFF' },
          { token: 'string', foreground: '30D158' },
          { token: 'number', foreground: 'FF9F0A' },
          { token: 'type', foreground: 'BF5AF2' },
          { token: 'function', foreground: '5E5CE6' },
        ],
        colors: {
          'editor.background': '#2C2C2E',
          'editor.foreground': '#F5F5F7',
          'editor.lineHighlightBackground': '#3A3A3C',
          'editor.selectionBackground': '#3A5A8A',
          'editorCursor.foreground': '#007AFF',
          'editorLineNumber.foreground': '#636366',
          'editorLineNumber.activeForeground': '#98989D',
          'editorBracketMatch.background': '#3A5A8A',
          'editorBracketMatch.border': '#007AFF',
          'editorGutter.background': '#2C2C2E',
        }
      });
      resolve();
    });
  });
  return monacoInitPromise;
}

async function ensureMonaco() {
  if (!AppState.monacoReady) await initMonaco();
}

function createEditorModel(content, language) {
  const uri = monaco.Uri.parse('file:///active.' + (language || 'txt'));
  return monaco.editor.createModel(content || '', language || 'plaintext', uri);
}

function getMonacoTheme() {
  return AppState.darkMode ? 'ai-studio-dark' : 'ai-studio';
}

async function openFileInEditor(path, content, language) {
  await ensureMonaco();

  // Dispose previous model
  if (AppState.editorModel) AppState.editorModel.dispose();
  if (AppState.editor) AppState.editor.dispose();
  if (AppState.diffEditor) { AppState.diffEditor.dispose(); AppState.diffEditor = null; }

  El.diffContainer.style.display = 'none';
  El.editorPlaceholder.style.display = 'none';
  El.editorReal.style.display = 'block';

  AppState.editorModel = createEditorModel(content, language);

  AppState.editor = monaco.editor.create(El.editorReal, {
    model: AppState.editorModel,
    theme: getMonacoTheme(),
    fontSize: 13,
    fontFamily: "'SF Mono','JetBrains Mono','Fira Code',Consolas,monospace",
    lineHeight: 22,
    minimap: { enabled: true, scale: 1 },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    tabSize: 2,
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    cursorBlinking: 'smooth',
    smoothScrolling: true,
    padding: { top: 8 },
    renderWhitespace: 'selection',
    guides: { indentation: true, bracketPairs: true },
  });

  AppState.editor.onDidChangeCursorPosition((e) => {
    El.statusCursor.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  // Mark as dirty on change
  AppState.editor.onDidChangeModelContent(() => {
    const tab = document.querySelector(`.editor-tab[data-path="${AppState.activeFilePath}"]`);
    if (tab && !tab.dataset.dirty) {
      tab.dataset.dirty = 'true';
      tab.querySelector('.tab-name').textContent += ' ●';
    }
  });
}

async function showDiffView(original, modified, language) {
  await ensureMonaco();

  if (AppState.editor) { AppState.editor.dispose(); AppState.editor = null; }
  if (AppState.diffEditor) AppState.diffEditor.dispose();

  El.editorReal.style.display = 'none';
  El.editorPlaceholder.style.display = 'none';
  El.diffContainer.style.display = 'flex';

  const originalModel = monaco.editor.createModel(original, language || 'plaintext');
  const modifiedModel = monaco.editor.createModel(modified, language || 'plaintext');

  AppState.diffEditor = monaco.editor.createDiffEditor(El.diffEditor, {
    theme: getMonacoTheme(),
    fontSize: 13,
    fontFamily: "'SF Mono','JetBrains Mono','Fira Code',Consolas,monospace",
    lineHeight: 22,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderSideBySide: true,
    bracketPairColorization: { enabled: true },
  });

  AppState.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
}

// ===================================================================
// Tab 管理
// ===================================================================
function switchTab(name) {
  try {
    $$('.tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (tab) tab.classList.add('active');

    $$('.view').forEach(v => v.classList.remove('active'));
    const viewName = `view${name.charAt(0).toUpperCase()+name.slice(1)}`;
    if (El[viewName]) El[viewName].classList.add('active');
    else console.warn(`View element "${viewName}" not found`);

    if (name === 'editor' && !AppState.workspace.open) {
      openWorkspaceDialog();
    }
    if (name === 'editor') {
      if (El.sidebar) El.sidebar.classList.remove('collapsed');
      switchSidebarMode('workspace');
    } else {
      switchSidebarMode('chat');
    }
  } catch(e) {
    console.error('switchTab error:', e);
  }
}

function switchSidebarMode(mode) {
  El.sidebarChat.classList.toggle('active', mode === 'chat');
  El.sidebarWorkspace.classList.toggle('active', mode === 'workspace');
  if (mode === 'chat') El.sidebar.classList.remove('collapsed');
}

// ===================================================================
// Workspace 管理
// ===================================================================

// ----- IndexedDB 存储文件夹句柄 -----
const DB_NAME = 'ai-studio-workspace-handles';
const DB_VERSION = 1;

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles', { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(name, handle) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put({ name, handle });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch(e) { console.warn('保存句柄失败:', e); }
}

async function loadDirHandle(name) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get(name);
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result?.handle || null);
      req.onerror = () => reject(req.error);
    });
  } catch(e) { return null; }
}

async function removeDirHandle(name) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(name);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch(e) {}
}

// ----- 最近工作空间管理 -----
let recentWorkspaces = [];
try {
  const saved = localStorage.getItem('aiStudioRecentWorkspaces');
  if (saved) recentWorkspaces = JSON.parse(saved);
} catch(e) {}

function saveRecentWorkspaces() {
  try { localStorage.setItem('aiStudioRecentWorkspaces', JSON.stringify(recentWorkspaces)); } catch(e) {}
}

function addRecentWorkspace(name, path, type) {
  recentWorkspaces = recentWorkspaces.filter(w => w.name !== name);
  recentWorkspaces.unshift({ name, path, type, time: Date.now() });
  if (recentWorkspaces.length > 20) recentWorkspaces = recentWorkspaces.slice(0, 20);
  saveRecentWorkspaces();
}

// ----- 从侧边栏重新打开工作空间 -----
async function reopenWorkspace(entry) {
  if (entry.type === 'handle') {
    const handle = await loadDirHandle(entry.name);
    if (handle) {
      try {
        // 检查权限
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          const req = await handle.requestPermission({ mode: 'readwrite' });
          if (req !== 'granted') {
            showError('权限不足', '无法访问文件夹「' + entry.name + '」，请重新选择');
            return;
          }
        }
        await openWorkspaceFromHandle(handle);
        return;
      } catch(e) {
        console.warn('句柄失效，降级到路径', e);
      }
    }
    // 句柄不可用，尝试路径备选
    if (entry.path) {
      await openWorkspaceFromPath(entry.path);
      return;
    }
    showError('无法打开', '文件夹「' + entry.name + '」的访问权限已丢失，请重新选择');
  } else if (entry.path) {
    await openWorkspaceFromPath(entry.path);
  } else {
    showError('无法打开', '工作空间信息不完整');
  }
}

// ----- 从文件夹句柄打开工作空间（支持 showDirectoryPicker） -----
async function openWorkspaceFromHandle(handle) {
  const folderName = handle.name;
  if (!folderName) { showError('打开失败', '无法获取文件夹信息'); return; }

  const treeResult = await buildTreeFromHandle(handle, '');
  AppState.workspace = {
    open: true, path: folderName, name: folderName,
    tree: treeResult.tree, dirHandle: handle,
  };
  AppState.fileHandles = treeResult.handles;
  AppState.openFiles = [];
  AppState.activeFilePath = null;

  addRecentWorkspace(folderName, folderName, 'handle');
  updateWorkspaceUI(folderName, treeResult.count);
  renderFileTree(treeResult.tree);
  switchSidebarMode('workspace');
  switchTab('editor');
}

// ----- 从路径打开工作空间（通过服务器 API） -----
async function openWorkspaceFromPath(path) {
  try {
    const res = await fetch('/api/workspace/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) { const err = await res.json(); showError('打开失败', err.detail); return; }
    const data = await res.json();
    AppState.workspace = {
      open: true, path: data.path, name: data.name, tree: data.tree, dirHandle: null,
    };
    AppState.fileHandles = {};
    AppState.openFiles = [];
    AppState.activeFilePath = null;

    addRecentWorkspace(data.name, data.path, 'path');
    updateWorkspaceUI(data.name, data.fileCount);
    renderFileTree(data.tree);
    switchSidebarMode('workspace');
    switchTab('editor');
  } catch(e) { showError('连接失败', e.message); }
}

function updateWorkspaceUI(name, fileCount) {
  El.workspaceDisplay.textContent = name;
  El.workspaceTitle.textContent = name;
  El.statusWorkspace.textContent = `工作空间: ${name}`;
  El.statusFileCount.textContent = fileCount ? `${fileCount} 个文件` : '';
  // 切换到工作空间已打开视图
  El.workspaceEmptyView.style.display = 'none';
  El.workspaceOpenView.style.display = 'flex';
}

// ----- 侧边栏最近工作空间列表 -----
function renderSidebarRecentWorkspaces() {
  const list = El.sidebarRecentList;
  if (!list) return;
  if (recentWorkspaces.length === 0) {
    list.innerHTML = '<div class="sidebar-recent-empty">暂无历史工作空间</div>';
    return;
  }
  list.innerHTML = recentWorkspaces.map((w, i) =>
    `<div class="sidebar-recent-item" onclick="reopenWorkspaceByIndex(${i})">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <span class="sidebar-recent-name">${escapeHtml(w.name)}</span>
      <span class="sidebar-recent-time">${formatRecentTime(w.time)}</span>
    </div>`
  ).join('');
}

function formatRecentTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff/60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff/3600000) + '小时前';
  return Math.floor(diff/86400000) + '天前';
}

// ----- 原生文件夹选择器 -----
async function pickDirectory() {
  if (typeof showDirectoryPicker === 'undefined') {
    // 非 HTTPS 或非 localhost 环境，提示用户手动输入路径
    if (El.workspacePathInput) {
      El.workspacePathInput.focus();
      El.workspacePathInput.placeholder = '浏览器不支持文件夹选择器，请手动输入路径（如 D:/Projects）';
      El.workspacePathInput.style.borderColor = 'var(--warning)';
      setTimeout(() => {
        if (El.workspacePathInput) El.workspacePathInput.style.borderColor = '';
      }, 3000);
    }
    return;
  }
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    closeModal('workspaceModal');
    await saveDirHandle(handle.name, handle);
    await openWorkspaceFromHandle(handle);
  } catch(e) {
    if (e.name !== 'AbortError' && e.name !== 'SecurityError') {
      showError('打开工作空间失败', e.message);
    }
  }
}

async function buildTreeFromHandle(handle, prefix) {
  const items = [];
  const handles = {};
  let count = 0;

  try {
    for await (const entry of handle.values()) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.kind === 'directory') {
        // 忽略常见的不需要的目录
        const ignoreDirs = ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
          '.idea', '.vscode', '.vs', 'bin', 'obj', 'dist', 'build',
          '.next', '.nuget', 'target', 'vendor', '.svn',
          '.claude', '.mypy_cache', '.pytest_cache', '.ruff_cache'];
        if (ignoreDirs.includes(entry.name)) continue;

        const childResult = await buildTreeFromHandle(entry, relPath);
        if (childResult.count > 0 || true) {
          items.push({
            name: entry.name,
            path: relPath,
            type: 'directory',
            children: childResult.tree,
          });
          count += childResult.count;
          Object.assign(handles, childResult.handles);
        }
      } else {
        handles[relPath] = entry;
        const lang = getFileLanguage(entry.name);  // 复用已有的语言映射
        items.push({
          name: entry.name,
          path: relPath,
          type: 'file',
          size: 0,  // 无法直接获取大小
          language: lang,
        });
        count++;
      }
    }
  } catch(e) {
    console.warn('遍历目录失败:', entry?.name, e);
  }

  // 排序：目录在前，按名称排序
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { tree: items, handles, count };
}

function getFileLanguage(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const langMap = {
    py: 'python', js: 'javascript', ts: 'typescript',
    jsx: 'javascript', tsx: 'typescriptreact', html: 'html',
    css: 'css', json: 'json', md: 'markdown',
    java: 'java', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    go: 'go', rs: 'rust', rb: 'ruby',
    php: 'php', swift: 'swift', kt: 'kotlin',
    sql: 'sql', yaml: 'yaml', yml: 'yaml',
    xml: 'xml', sh: 'shell', bash: 'shell',
    vue: 'vue', svelte: 'svelte', scss: 'scss', less: 'less',
    dockerfile: 'dockerfile', txt: 'text', env: 'ini',
    gitignore: 'ignore', cfg: 'ini', ini: 'ini', conf: 'ini',
    svg: 'xml', gradle: 'groovy', toml: 'ini',
    mjs: 'javascript', cjs: 'javascript',
  };
  return langMap[ext] || 'text';
}

function openWorkspaceDialog() {
  if (!El.workspaceModal || !El.workspacePathInput) {
    console.error('DOM 元素未找到，尝试重新初始化');
    initDoms();
  }
  if (El.workspaceModal) El.workspaceModal.style.display = 'flex';
  if (El.workspacePathInput) { El.workspacePathInput.value = ''; El.workspacePathInput.focus(); }
  loadRecentWorkspaces();
}

function closeModal(id) {
  if (El[id]) El[id].style.display = 'none';
}

function closeModalOnOverlay(e) {
  if (e.target.classList.contains('modal-overlay')) e.target.style.display = 'none';
}

function loadRecentWorkspaces() {
  const list = El.recentWorkspaceList;
  if (recentWorkspaces.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">暂无记录</div>';
    return;
  }
  list.innerHTML = recentWorkspaces.map(w =>
    `<div class="recent-item" onclick="reopenWorkspaceByIndex(${recentWorkspaces.indexOf(w)})">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <span class="recent-path">${escapeHtml(w.name)}</span>
    </div>`
  ).join('');
}

async function confirmOpenWorkspace() {
  const path = El.workspacePathInput.value.trim();
  if (!path) return;
  closeModal('workspaceModal');
  await openWorkspaceFromPath(path);
}

async function reopenWorkspaceByIndex(index) {
  const entry = recentWorkspaces[index];
  if (!entry) return;
  closeModal('workspaceModal');
  await reopenWorkspace(entry);
}

async function closeWorkspace() {
  try { await fetch('/api/workspace/close', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }); } catch(e) {}
  AppState.workspace = { open: false, path: null, name: null, tree: [], dirHandle: null };
  AppState.openFiles = [];
  AppState.activeFilePath = null;
  AppState.fileHandles = {};
  El.workspaceDisplay.textContent = '选择工作空间';
  El.statusWorkspace.textContent = '工作空间: 无';
  El.statusFileCount.textContent = '';
  El.editorTabsEmpty.style.display = 'block';
  El.editorPlaceholder.style.display = 'flex';
  El.editorReal.style.display = 'none';
  El.diffContainer.style.display = 'none';
  if (AppState.editor) { AppState.editor.dispose(); AppState.editor = null; }
  if (AppState.diffEditor) { AppState.diffEditor.dispose(); AppState.diffEditor = null; }

  // 切换到空视图（显示最近工作空间）
  El.workspaceEmptyView.style.display = '';
  El.workspaceOpenView.style.display = 'none';
  renderSidebarRecentWorkspaces();
  switchTab('chat');
}

async function refreshWorkspace() {
  if (!AppState.workspace.open) return;
  try {
    const res = await fetch('/api/workspace/open', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: AppState.workspace.path }),
    });
    if (res.ok) {
      const data = await res.json();
      AppState.workspace.tree = data.tree;
      renderFileTree(data.tree);
      El.statusFileCount.textContent = `${data.fileCount} 个文件`;
    }
  } catch(e) { /* ignore */ }
}

// ===================================================================
// 文件树渲染
// ===================================================================
function renderFileTree(tree, container, depth) {
  container = container || El.fileTree;
  depth = depth || 0;

  // If at root, clear and render
  if (depth === 0) {
    container.innerHTML = '';
    for (const item of tree) {
      renderTreeItem(item, container, 0);
    }
  }
}

function renderTreeItem(item, parent, depth) {
  const padding = 12 + depth * 16;
  const isDir = item.type === 'directory';

  const div = document.createElement('div');
  div.className = 'tree-item';
  div.dataset.path = item.path;
  div.dataset.type = item.type;
  div.style.paddingLeft = padding + 'px';

  if (isDir) {
    div.innerHTML = `
      <span class="tree-arrow">▶</span>
      <span class="tree-icon">📁</span>
      <span class="tree-name">${escapeHtml(item.name)}</span>
    `;
    div.onclick = () => toggleTreeNode(div, item);
    parent.appendChild(div);

    // Children container
    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'tree-children';
    childrenDiv.style.display = 'none';
    childrenDiv.dataset.parent = item.path;
    parent.appendChild(childrenDiv);

  } else {
    div.innerHTML = `
      <span class="tree-arrow" style="visibility:hidden;">▶</span>
      <span class="tree-icon">${fileIcon(item.name)}</span>
      <span class="tree-name">${escapeHtml(item.name)}</span>
    `;
    div.onclick = () => openFileFromTree(item);
    parent.appendChild(div);
  }
}

function toggleTreeNode(el, item) {
  const arrow = el.querySelector('.tree-arrow');
  const childrenContainer = el.nextElementSibling;

  if (!childrenContainer || !childrenContainer.classList.contains('tree-children')) return;

  if (childrenContainer.style.display === 'block') {
    childrenContainer.style.display = 'none';
    arrow.classList.remove('expanded');
    return;
  }

  arrow.classList.add('expanded');

  if (childrenContainer.children.length > 0) {
    childrenContainer.style.display = 'block';
    return;
  }

  // Load children from cached tree
  const treeItem = findTreeItem(AppState.workspace.tree, item.path);
  if (treeItem && treeItem.children) {
    for (const child of treeItem.children) {
      renderTreeItem(child, childrenContainer, item.path.split('/').length);
    }
    childrenContainer.style.display = 'block';
  }
}

function findTreeItem(items, path) {
  for (const item of items) {
    if (item.path === path) return item;
    if (item.children) {
      const found = findTreeItem(item.children, path);
      if (found) return found;
    }
  }
  return null;
}

// ===================================================================
// 文件操作
// ===================================================================
async function openFileFromTree(item) {
  if (item.type === 'directory') return;

  let content, name, language;

  // 使用 File System Access API 读取（如果有句柄）
  const fileHandle = AppState.fileHandles[item.path];
  if (fileHandle) {
    try {
      const file = await fileHandle.getFile();
      name = item.name;
      language = item.language || 'text';
      content = await file.text();
    } catch(e) {
      // 句柄读取失败，降级到服务器 API
      console.warn('句柄读取失败，降级到 API:', e);
    }
  }

  // 降级：通过服务器 API 读取
  if (content === undefined) {
    try {
      const res = await fetch('/api/workspace/read', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ path: item.path }),
      });
      if (!res.ok) {
        const err = await res.json();
        showError('读取文件失败', err.detail);
        return;
      }
      const data = await res.json();
      content = data.content;
      name = data.name;
      language = data.language || 'text';
    } catch(e) {
      showError('文件打开失败', e.message);
      return;
    }
  }

  // Add/switch tab
  addEditorTab(item.path, name);
  AppState.activeFilePath = item.path;

  // Update stored open files
  const existing = AppState.openFiles.find(f => f.path === item.path);
  if (!existing) {
    AppState.openFiles.push({ path: item.path, name, language, content, dirty: false });
  } else {
    existing.content = content;
    existing.language = language;
    existing.dirty = false;
  }

  // Highlight active in tree
  El.fileTree.querySelectorAll('.tree-item.active').forEach(e => e.classList.remove('active'));
  const treeEl = El.fileTree.querySelector(`.tree-item[data-path="${item.path}"]`);
  if (treeEl) treeEl.classList.add('active');

  await openFileInEditor(item.path, content, language);

  // Update status
  El.statusCursor.textContent = `Ln 1, Col 1`;
}

function addEditorTab(path, name) {
  // Check if already open
  const existing = El.editorTabs.querySelector(`.editor-tab[data-path="${path}"]`);
  if (existing) {
    El.editorTabs.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('active'));
    existing.classList.add('active');
    return;
  }

  El.editorTabsEmpty.style.display = 'none';

  El.editorTabs.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('active'));

  const tab = document.createElement('div');
  tab.className = 'editor-tab active';
  tab.dataset.path = path;
  tab.dataset.dirty = 'false';
  tab.innerHTML = `
    <span>${fileIcon(name)}</span>
    <span class="tab-name">${escapeHtml(name)}</span>
    <button class="tab-close" onclick="event.stopPropagation();closeEditorTab('${escapeHtml(path)}')">×</button>
  `;
  tab.onclick = () => switchEditorTab(path);
  El.editorTabs.appendChild(tab);

  // Auto scroll to show new tab
  tab.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function switchEditorTab(path) {
  // Save current file state before switching
  if (AppState.activeFilePath && AppState.editor) {
    const currentFile = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
    if (currentFile) {
      currentFile.content = AppState.editor.getValue();
    }
  }

  AppState.activeFilePath = path;
  El.editorTabs.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('active'));
  const tab = El.editorTabs.querySelector(`.editor-tab[data-path="${path}"]`);
  if (tab) tab.classList.add('active');

  const file = AppState.openFiles.find(f => f.path === path);
  if (file) {
    openFileInEditor(path, file.content, file.language);
  }
}

async function closeEditorTab(path) {
  const file = AppState.openFiles.find(f => f.path === path);
  if (file && file.dirty) {
    // Auto save
    await saveCurrentFile();
  }

  const tab = El.editorTabs.querySelector(`.editor-tab[data-path="${path}"]`);
  if (tab) tab.remove();

  AppState.openFiles = AppState.openFiles.filter(f => f.path !== path);
  if (AppState.activeFilePath === path) {
    AppState.activeFilePath = null;
    // Switch to first remaining tab or show placeholder
    const remaining = El.editorTabs.querySelector('.editor-tab');
    if (remaining) {
      switchEditorTab(remaining.dataset.path);
    } else {
      El.editorTabsEmpty.style.display = 'block';
      El.editorPlaceholder.style.display = 'flex';
      El.editorReal.style.display = 'none';
      if (AppState.editor) { AppState.editor.dispose(); AppState.editor = null; }
    }
  }
}

async function saveCurrentFile() {
  if (!AppState.activeFilePath) return;
  const content = AppState.editor?.getValue();
  if (content === undefined) return;

  // 优先使用 File System Access API 写入
  const fileHandle = AppState.fileHandles[AppState.activeFilePath];
  if (fileHandle) {
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
      if (file) { file.content = content; file.dirty = false; }
      const tab = El.editorTabs.querySelector(`.editor-tab[data-path="${AppState.activeFilePath}"]`);
      if (tab) {
        tab.dataset.dirty = 'false';
        tab.querySelector('.tab-name').textContent = AppState.openFiles.find(f => f.path === AppState.activeFilePath)?.name || '';
      }
      return;
    } catch(e) {
      console.warn('句柄写入失败，降级到 API:', e);
    }
  }

  // 降级：通过服务器 API 写入
  try {
    const res = await fetch('/api/workspace/write', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: AppState.activeFilePath, content }),
    });
    if (res.ok) {
      const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
      if (file) { file.content = content; file.dirty = false; }
      const tab = El.editorTabs.querySelector(`.editor-tab[data-path="${AppState.activeFilePath}"]`);
      if (tab) {
        tab.dataset.dirty = 'false';
        tab.querySelector('.tab-name').textContent = AppState.openFiles.find(f => f.path === AppState.activeFilePath)?.name || '';
      }
    }
  } catch(e) { /* ignore */ }
}

// ===================================================================
// Editor Chat (AI 代码助手)
// ===================================================================
function editorChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendEditorChat();
  }
}

function addEditorChatMessage(role, content) {
  const div = document.createElement('div');
  div.className = `ec-message ${role}`;
  div.innerHTML = `
    <div class="ec-role">${role === 'user' ? '你' : 'AI'}</div>
    <div class="ec-text">${role === 'ai' ? renderMd(content) : escapeHtml(content)}</div>
  `;
  El.editorChatMessages.appendChild(div);
  scrollEditorChatToBottom();
  return div;
}

function clearEditorChat() {
  El.editorChatMessages.innerHTML = `<div class="editor-chat-welcome">
    <p>在编辑器中打开文件后，可以：</p>
    <ul><li>• 要求修改代码</li><li>• 检查代码错误</li><li>• 修复问题</li><li>• 生成新功能</li></ul>
  </div>`;
  AppState.editorChatHistory = [];
}

async function sendEditorChat() {
  const text = El.editorChatInput.value.trim();
  if (!text) return;

  const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
  if (!file) {
    addEditorChatMessage('ai', '请先在文件树中选择一个文件。');
    return;
  }

  El.editorChatInput.value = '';
  addEditorChatMessage('user', text);

  // Save current content
  file.content = AppState.editor?.getValue() || file.content;
  AppState.editorChatHistory.push({ role: 'user', content: text });

  // AI response placeholder
  const thinkingDiv = addEditorChatMessage('ai', '_正在思考..._');
  const textEl = thinkingDiv.querySelector('.ec-text');

  let fullResponse = '';
  let hasChanges = false;
  let modified = '';

  try {
    const res = await fetch('/api/workspace/edit/stream', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        content: file.content,
        message: text,
        filename: file.name,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: '请求失败' }));
      textEl.innerHTML = `❌ ${escapeHtml(err.detail || `HTTP ${res.status}`)}`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
              textEl.innerHTML = renderMd(fullResponse);
              addCopyButtons(textEl);
              scrollEditorChatToBottom();
              break;
            case 'error':
              textEl.innerHTML = `❌ ${escapeHtml(data.content)}`;
              return;
            case 'done':
              hasChanges = data.hasChanges;
              modified = data.modified || '';
              break;
          }
        } catch (e) {
          // skip parse errors
        }
      }
    }

    if (fullResponse) {
      if (hasChanges) {
        // 有代码变更：显示 diff
        textEl.innerHTML = renderMd(fullResponse);
        addCopyButtons(textEl);
        await showDiffView(file.content, modified, file.language);
        AppState.pendingDiff = { original: file.content, modified: modified, path: file.path };

        const actionDiv = document.createElement('div');
        actionDiv.className = 'ec-message ai';
        actionDiv.innerHTML = `<div class="ec-text" style="padding:4px 0;">
          <span style="color:var(--success);font-weight:600;">✓ 变更已生成</span>
          — 点击上方"接受更改"应用或"拒绝"放弃
        </div>`;
        El.editorChatMessages.appendChild(actionDiv);

        AppState.editorChatHistory.push({ role: 'assistant', content: '已生成变更' });
      } else {
        AppState.editorChatHistory.push({ role: 'assistant', content: fullResponse });
      }
    } else {
      textEl.innerHTML = '未能获取有效响应。';
    }

  } catch(e) {
    textEl.innerHTML = `❌ 请求失败: ${escapeHtml(e.message)}`;
  }

  scrollEditorChatToBottom();
}

async function acceptChanges() {
  if (!AppState.pendingDiff) return;
  const { modified, path } = AppState.pendingDiff;

  // Security scan before applying
  const filename = path.split('/').pop() || path.split('\\').pop() || 'file';
  const report = await scanCodeForSecurity(modified, filename);
  if (report && report.overall !== 'safe') {
    const confirmed = await showSecurityConfirm(AppState.pendingDiff.original, modified, filename);
    if (!confirmed) return;
  }

  // Update open file content
  const file = AppState.openFiles.find(f => f.path === path);
  if (file) file.content = modified;

  // Close diff and return to editor with modified content
  El.diffContainer.style.display = 'none';
  El.editorReal.style.display = 'block';

  if (AppState.diffEditor) { AppState.diffEditor.dispose(); AppState.diffEditor = null; }

  const lang = file?.language || 'text';
  await openFileInEditor(path, modified, lang);
  AppState.activeFilePath = path;

  // Auto save
  await saveCurrentFile();

  addEditorChatMessage('ai', `✓ 变更已应用到 \`${path}\``);
  AppState.pendingDiff = null;
}

function rejectChanges() {
  El.diffContainer.style.display = 'none';
  El.editorReal.style.display = 'block';

  if (AppState.diffEditor) { AppState.diffEditor.dispose(); AppState.diffEditor = null; }

  const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
  if (file && AppState.pendingDiff) {
    openFileInEditor(file.path, file.content, file.language);
  }

  addEditorChatMessage('ai', `✕ 已放弃变更。`);
  AppState.pendingDiff = null;
}

async function reviewCurrentFile() {
  const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
  if (!file) {
    addEditorChatMessage('ai', '请先在文件树中选择一个文件。');
    return;
  }

  file.content = AppState.editor?.getValue() || file.content;
  El.editorChatInput.value = '审查代码错误、安全问题和改进建议';
  await sendEditorChatDirect('review');
}

async function fixCurrentFile() {
  const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
  if (!file) {
    addEditorChatMessage('ai', '请先在文件树中选择一个文件。');
    return;
  }

  file.content = AppState.editor?.getValue() || file.content;
  El.editorChatInput.value = '请修复这段代码中的错误和问题';
  await sendEditorChatDirect('fix');
}

async function securityCheckCurrentFile() {
  const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
  if (!file) {
    addEditorChatMessage('ai', '请先在文件树中选择一个文件。');
    return;
  }

  file.content = AppState.editor?.getValue() || file.content;
  const thinkingDiv = addEditorChatMessage('ai', '_正在执行安全检查..._');

  try {
    const report = await scanCodeForSecurity(file.content, file.name);
    if (!report) {
      thinkingDiv.querySelector('.ec-text').innerHTML = '❌ 安全检查失败，请稍后重试。';
      return;
    }
    thinkingDiv.querySelector('.ec-text').innerHTML = renderSecurityReport(report);
  } catch(e) {
    thinkingDiv.querySelector('.ec-text').innerHTML = `❌ 安全检查出错: ${escapeHtml(e.message)}`;
  }
}

async function sendEditorChatDirect(mode) {
  const text = El.editorChatInput.value.trim();
  if (!text) return;

  const file = AppState.openFiles.find(f => f.path === AppState.activeFilePath);
  if (!file) return;

  El.editorChatInput.value = '';
  addEditorChatMessage('user', text);

  const body = { content: file.content, filename: file.name };
  if (mode !== 'review') body.message = text;

  if (mode === 'review') {
    // 审查模式：非流式
    const thinkingDiv = addEditorChatMessage('ai', '_正在审查..._');
    try {
      const res = await fetch('/api/workspace/review', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        thinkingDiv.querySelector('.ec-text').innerHTML = `❌ ${escapeHtml(err.detail || '请求失败')}`;
        return;
      }
      const data = await res.json();
      const issues = data.issues || [];
      if (issues.length === 0) {
        thinkingDiv.querySelector('.ec-text').innerHTML = '✅ 代码审查通过，未发现问题。';
      } else {
        let report = '## 代码审查结果\n\n';
        const bySeverity = { error: [], warning: [], info: [] };
        issues.forEach(i => { (bySeverity[i.severity] || bySeverity.info).push(i); });
        if (bySeverity.error.length) {
          report += '### 🔴 错误\n';
          bySeverity.error.forEach(i => { report += `- **第 ${i.line} 行**: ${i.message}\n  - 建议: ${i.suggestion}\n`; });
        }
        if (bySeverity.warning.length) {
          report += '### 🟡 警告\n';
          bySeverity.warning.forEach(i => { report += `- **第 ${i.line} 行**: ${i.message}\n  - 建议: ${i.suggestion}\n`; });
        }
        if (bySeverity.info.length) {
          report += '### 🔵 建议\n';
          bySeverity.info.forEach(i => { report += `- **第 ${i.line} 行**: ${i.message}\n  - 建议: ${i.suggestion}\n`; });
        }
        thinkingDiv.querySelector('.ec-text').innerHTML = renderMd(report);
      }
    } catch(e) {
      thinkingDiv.querySelector('.ec-text').innerHTML = `❌ 请求失败: ${escapeHtml(e.message)}`;
    }
  } else {
    // 修复模式：流式输出（与聊天相同）
    const thinkingDiv = addEditorChatMessage('ai', '_正在处理..._');
    const textEl = thinkingDiv.querySelector('.ec-text');
    let fullResponse = '';

    try {
      const res = await fetch('/api/workspace/edit/stream', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '请求失败' }));
        textEl.innerHTML = `❌ ${escapeHtml(err.detail || `HTTP ${res.status}`)}`;
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
                textEl.innerHTML = renderMd(fullResponse);
                addCopyButtons(textEl);
                scrollEditorChatToBottom();
                break;
              case 'error':
                textEl.innerHTML = `❌ ${escapeHtml(data.content)}`;
                return;
              case 'done':
                if (data.hasChanges) {
                  addCopyButtons(textEl);
                  await showDiffView(file.content, data.modified, file.language);
                  AppState.pendingDiff = { original: file.content, modified: data.modified, path: file.path };
                  const actionDiv = document.createElement('div');
                  actionDiv.className = 'ec-message ai';
                  actionDiv.innerHTML = `<div class="ec-text" style="padding:4px 0;">
                    <span style="color:var(--success);font-weight:600;">✓ 已处理</span>
                    — 点击上方"接受更改"应用
                  </div>`;
                  El.editorChatMessages.appendChild(actionDiv);
                }
                break;
            }
          } catch(e) {}
        }
      }
    } catch(e) {
      textEl.innerHTML = `❌ 请求失败: ${escapeHtml(e.message)}`;
    }
  }

  scrollEditorChatToBottom();
}

function showWorkspaceSettings() {
  El.settingsPath.textContent = AppState.workspace.path || '-';
  El.settingsModal.style.display = 'flex';
}

// ===================================================================
// 对话管理
// ===================================================================
function getCurrentConv() {
  return AppState.conversations.find(c => c.id === AppState.currentConvId);
}

function newChat() {
  const id = genId();
  AppState.conversations.push({ id, messages: [], model: AppState.currentModel });
  AppState.currentConvId = id;
  El.messages.innerHTML = '';
  renderConvList();
  updateWelcome();
  removeFile();
  El.messageInput.focus();
}

function ensureConv() {
  if (!AppState.currentConvId) newChat();
}

function switchConv(id) {
  AppState.currentConvId = id;
  renderMessages();
  renderConvList();
  updateWelcome();
}

function renderConvList() {
  El.conversationList.innerHTML = AppState.conversations.slice().reverse().map(c => {
    const title = getConvTitle(c.messages);
    const active = c.id === AppState.currentConvId ? 'active' : '';
    return `<div class="conversation-item ${active}" onclick="switchConv('${c.id}')">
      <span class="conv-icon">💬</span>
      <span class="conv-title">${escapeHtml(title)}</span>
      <button class="btn-del-conv" onclick="deleteConv('${c.id}', event)" title="删除">×</button>
    </div>`;
  }).join('') || '<div style="padding:20px;text-align:center;color:var(--text-sidebar-muted);font-size:12px;">暂无对话记录</div>';
}

function getConvTitle(msgs) {
  if (!msgs.length) return '新对话';
  const first = msgs[0];
  const text = first.text || first.content || '';
  if (first.fileName) return `[${first.fileName}] ${text.slice(0,20)}`;
  return text.slice(0, 30) || '新对话';
}

function deleteConv(id, event) {
  event.stopPropagation();
  if (!confirm('确定删除？')) return;
  const idx = AppState.conversations.findIndex(c => c.id === id);
  if (idx === -1) return;
  AppState.conversations.splice(idx, 1);
  if (AppState.currentConvId === id) {
    if (AppState.conversations.length > 0) {
      switchConv(AppState.conversations[Math.min(idx, AppState.conversations.length-1)].id);
    } else { newChat(); }
  } else { renderConvList(); }
}

function renderMessages() {
  const conv = getCurrentConv();
  El.messages.innerHTML = '';
  if (!conv) return;
  conv.messages.forEach((msg, i) => {
    const extra = {};
    if (msg.fileName && msg.fileCategory === 'image' && msg.filePreview) extra.imagePreview = msg.filePreview;
    if (msg.fileName) { extra.fileName = msg.fileName; extra.fileIcon = msg.fileIcon; extra.fileSize = msg.fileSize; }
    extra.messageIdx = i;
    addMessageEl(msg.role, msg.text || '', extra);
  });
}

function updateWelcome() {
  const conv = getCurrentConv();
  const hasMsg = conv && conv.messages.length > 0;
  El.welcomeScreen.style.display = hasMsg ? 'none' : 'flex';
  El.messages.style.display = hasMsg ? 'flex' : 'none';
}

function clearChat() {
  const conv = getCurrentConv();
  if (conv) { conv.messages = []; El.messages.innerHTML = ''; updateWelcome(); }
}

// ===================================================================
// 消息渲染
// ===================================================================
function addMessageEl(role, content, extra) {
  extra = extra || {};
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.dataset.messageId = extra.id || Date.now().toString();
  if (extra.messageIdx !== undefined) div.dataset.messageIdx = extra.messageIdx;

  const avatar = role === 'user' ? '👤' : '🤖';
  const roleName = role === 'user' ? '你' : 'AI';

  let extraHtml = '';
  if (extra.imagePreview) extraHtml = `<img src="${extra.imagePreview}" class="image-preview" alt="图片">`;
  if (extra.fileName) {
    extraHtml = `<div class="file-attachment">
      <span class="fa-icon">${extra.fileIcon || '📄'}</span>
      <span class="fa-name">${escapeHtml(extra.fileName)}</span>
      <span class="fa-size">${extra.fileSize || ''}</span>
    </div>` + extraHtml;
  }

  const time = new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' });
  const editBtn = role === 'user' ? `<button class="btn-edit-msg" onclick="editMessage(this)" title="编辑">✏️</button>` : '';

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-role">${roleName}</span>
        <span class="message-time">${time}</span>
        ${editBtn}
      </div>
      <div class="message-bubble">
        ${extraHtml}
        ${content ? (role === 'ai' ? renderMd(content) : escapeHtml(content)) : '<div class="typing-indicator"><span></span><span></span><span></span></div>'}
      </div>
    </div>
  `;

  El.messages.appendChild(div);
  scrollToBottom();
  return div;
}

function getLastAiBubble() {
  const msgs = El.messages.querySelectorAll('.message.ai .message-bubble');
  return msgs[msgs.length - 1];
}

function updateAiMessage(text, isDelta) {
  const bubble = getLastAiBubble();
  if (!bubble) return;
  const typing = bubble.querySelector('.typing-indicator');
  if (typing) {
    bubble.innerHTML = renderMd(text);
  } else {
    bubble.innerHTML = renderMd(text);
  }
  if (typeof hljs !== 'undefined') {
    bubble.querySelectorAll('pre code').forEach((block) => { try { hljs.highlightElement(block); } catch(e) {} });
  }
  addCopyButtons(bubble);
  scrollToBottom();
}

// 滚动锁标记：用户主动上滑后停止自动滚动
let _chatScrollLock = false;
let _ecScrollLock = false;

function scrollToBottom() {
  if (_chatScrollLock) return;
  requestAnimationFrame(() => { El.chatContainer.scrollTop = El.chatContainer.scrollHeight; });
}
function scrollEditorChatToBottom() {
  if (_ecScrollLock) return;
  requestAnimationFrame(() => { El.editorChatMessages.scrollTop = El.editorChatMessages.scrollHeight; });
}
function isNearBottom(el, threshold = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

// ===== 代码块复制按钮 =====
function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-code-btn')) return;
    const code = pre.querySelector('code');
    if (!code || !code.textContent.trim()) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制';
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制';
          btn.classList.remove('copied');
        }, 2000);
      } catch(e) {
        btn.textContent = '复制失败';
      }
    };
    pre.appendChild(btn);
  });
}

// ===================================================================
// 文件处理（聊天上传）
// ===================================================================
function handleFileSelect(event) {
  const files = event.target.files;
  if (!files.length) return;
  AppState.uploadedFile = files[0];
  showFilePreview(files[0]);
  El.messageInput.focus();
}

function showFilePreview(file) {
  El.fileIcon.textContent = fileIcon(file.name);
  El.fileName.textContent = file.name;
  El.fileSize.textContent = formatSize(file.size);
  El.filePreview.style.display = 'flex';
  updateSendBtn();
}

function removeFile() {
  AppState.uploadedFile = null;
  El.filePreview.style.display = 'none';
  El.fileInput.value = '';
  updateSendBtn();
}

function updateSendBtn() {
  const text = El.messageInput.value.trim();
  const hasFile = !!AppState.uploadedFile;
  El.sendBtn.disabled = (!text && !hasFile) || AppState.isStreaming;
}

// Drag & drop (文档级事件可以保留在模块级)
let dragCounter = 0;
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// 图片全屏点击（不依赖 El，可以保留模块级）
document.addEventListener('click', e => {
  if (e.target.classList.contains('image-preview')) {
    const full = document.createElement('div');
    full.className = 'image-fullscreen';
    const img = document.createElement('img'); img.src = e.target.src;
    full.appendChild(img);
    full.onclick = () => full.remove();
    document.body.appendChild(full);
  }
});

// ===================================================================
// 发送消息
// ===================================================================
async function sendMessage() {
  const text = El.messageInput.value.trim();
  const file = AppState.uploadedFile;

  if (!text && !file) return;
  if (AppState.isStreaming) return;

  ensureConv();
  const conv = getCurrentConv();
  if (!conv) return;

  let userText = text;
  let userExtra = {};

  if (file) {
    const cat = fileCategory(file.name);
    userExtra.fileName = file.name;
    userExtra.fileSize = formatSize(file.size);
    userExtra.fileIcon = fileIcon(file.name);
    userExtra.fileCategory = cat;

    if (cat === 'image') {
      const reader = new FileReader();
      await new Promise((resolve) => {
        reader.onload = (e) => { userExtra.imagePreview = e.target.result; resolve(); };
        reader.onerror = () => resolve();
        reader.readAsDataURL(file);
      });
    }
    userExtra.fileAttachment = file.name;
  }

  El.messageInput.value = '';
  El.messageInput.style.height = 'auto';
  updateSendBtn();

  conv.messages.push({
    role: 'user', text: userText,
    fileName: file?.name, fileCategory: file ? fileCategory(file.name) : null,
    filePreview: userExtra.imagePreview || null,
    fileIcon: userExtra.fileIcon || null, fileSize: userExtra.fileSize || null,
  });

  addMessageEl('user', userText || (file ? `[上传文件] ${file.name}` : ''), userExtra);
  updateWelcome();
  renderConvList();

  addMessageEl('ai', '');

  AppState.isStreaming = true;
  AppState.abortController = new AbortController();
  El.messageInput.disabled = true;
  updateSendBtnUI(true);
  scrollToBottom();

  try {
    const fullResponse = await streamChat(text, file);
    conv.messages.push({ role: 'assistant', text: fullResponse });
  } catch (err) {
    if (err.name === 'AbortError') {
      const bubble = getLastAiBubble();
      if (bubble && bubble.querySelector('.typing-indicator')) {
        bubble.innerHTML = '<div style="color:var(--text-secondary);padding:8px;font-size:13px;">已取消生成</div>';
      }
    } else {
      console.error('请求失败:', err);
      const errorBubble = getLastAiBubble();
      if (errorBubble) {
        errorBubble.innerHTML = `<div style="color:var(--error);padding:8px;">
          <strong>出错了</strong><br>
          <span style="font-size:13px;">${escapeHtml(err.message)}</span>
        </div>`;
      }
    }
  } finally {
    AppState.isStreaming = false;
    AppState.abortController = null;
    El.messageInput.disabled = false;
    updateSendBtnUI(false);
    removeFile();
    updateSendBtn();
    El.messageInput.focus();
    updateWelcome();
    renderConvList();
  }
}

function updateSendBtnUI(isStreaming) {
  if (isStreaming) {
    El.sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    El.sendBtn.title = '停止生成';
    El.sendBtn.onclick = stopGeneration;
    El.sendBtn.style.background = 'var(--error)';
    El.sendBtn.disabled = false;
  } else {
    El.sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21L23 12 2 3v7l15 2-15 2v7z"/></svg>`;
    El.sendBtn.title = '发送';
    El.sendBtn.onclick = sendMessage;
    El.sendBtn.style.background = '';
    updateSendBtn();
  }
}

function stopGeneration() {
  if (AppState.abortController) AppState.abortController.abort();
  El.sendBtn.disabled = true;
  El.sendBtn.title = '正在停止...';
}

// ===================================================================
// 流式聊天
// ===================================================================
async function streamChat(text, file) {
  const formData = new FormData();
  formData.append('message', text);
  if (file) formData.append('file', file);
  formData.append('model', AppState.currentModel);

  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    body: formData,
    signal: AppState.abortController?.signal,
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

  // Handle remaining buffer
  if (buffer.startsWith('data: ')) {
    try {
      const data = JSON.parse(buffer.slice(6));
      if (data.type === 'text') {
        fullResponse += data.content;
        updateAiMessage(fullResponse, true);
      }
    } catch(e) {}
  }

  return fullResponse;
}

// ===================================================================
// 模型 & 健康检查
// ===================================================================
function changeModel() {
  AppState.currentModel = El.modelSelect.value;
  const conv = getCurrentConv();
  if (conv) conv.model = AppState.currentModel;
}

async function loadModels() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const models = data.models || [];

    El.modelSelect.innerHTML = '';
    if (models.length > 0) {
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        El.modelSelect.appendChild(opt);
      });
      // 默认选中第一个模型
      if (!AppState.currentModel) {
        El.modelSelect.selectedIndex = 0;
        AppState.currentModel = models[0];
      } else if (models.includes(AppState.currentModel)) {
        El.modelSelect.value = AppState.currentModel;
      }
    } else {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '暂无可用模型';
      opt.disabled = true;
      El.modelSelect.appendChild(opt);
    }

    if (data.backend === 'dashscope') {
      El.statusBackend.textContent = `后端: 通义千问 · ${data.active_model || data.models?.[0] || ''}`;
    } else {
      El.statusBackend.textContent = `后端: Ollama · ${data.active_model || 'auto'}`;
    }
  } catch(e) {
    console.warn('无法加载模型列表:', e);
  }
}

async function checkHealth() {
  try {
    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch('/api/health', { signal: controller.signal });
    clearTimeout(timeoutId);

    const data = await res.json();
    const models = data.models || [];

    if (data.backend === 'dashscope') {
      if (data.status === 'ok') {
        El.statusDot.className = 'status-dot connected';
        El.statusText.textContent = `通义千问 · ${data.active_model}`;
      } else {
        El.statusDot.className = 'status-dot disconnected';
        El.statusText.textContent = 'API Key 未配置';
      }
    } else {
      if (!data.ollama_running) {
        El.statusDot.className = 'status-dot disconnected';
        El.statusText.textContent = 'Ollama 未运行';
      } else if (models.length === 0) {
        El.statusDot.className = 'status-dot disconnected';
        El.statusText.textContent = '未下载模型';
      } else {
        El.statusDot.className = 'status-dot connected';
        El.statusText.textContent = `本地模型 · ${data.active_model || models[0]}`;
      }
    }
    await loadModels();
  } catch(e) {
    El.statusDot.className = 'status-dot disconnected';
    if (e.name === 'AbortError') {
      El.statusText.textContent = '检查超时';
    } else {
      El.statusText.textContent = '无法连接服务器';
    }
  }
}

// ===================================================================
// 消息编辑
// ===================================================================
function editMessage(btn) {
  const msgDiv = btn.closest('.message');
  const idx = parseInt(msgDiv.dataset.messageIdx);
  const conv = getCurrentConv();
  if (!conv || isNaN(idx) || idx >= conv.messages.length) return;

  const bubble = msgDiv.querySelector('.message-bubble');
  const originalText = conv.messages[idx].text || '';
  if (bubble.querySelector('.edit-textarea')) return;

  const html = bubble.innerHTML;
  bubble.innerHTML = `
    <textarea class="edit-textarea">${escapeHtml(originalText)}</textarea>
    <div class="edit-actions">
      <button class="btn-save-edit">保存</button>
      <button class="btn-cancel-edit">取消</button>
    </div>
  `;

  const ta = bubble.querySelector('.edit-textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  bubble.querySelector('.btn-save-edit').onclick = () => saveEdit(conv, idx);
  bubble.querySelector('.btn-cancel-edit').onclick = () => { bubble.innerHTML = html; };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(conv, idx); }
  };
}

async function saveEdit(conv, idx) {
  const msgDiv = document.querySelector(`.message[data-message-idx="${idx}"]`);
  if (!msgDiv) return;
  const ta = msgDiv.querySelector('.edit-textarea');
  const newText = ta.value.trim();
  if (!newText) return;

  conv.messages[idx].text = newText;
  conv.messages = conv.messages.slice(0, idx + 1);
  AppState.currentConvId = conv.id;
  renderMessages();
  updateWelcome();
  renderConvList();

  addMessageEl('ai', '');
  AppState.isStreaming = true;
  AppState.abortController = new AbortController();
  El.messageInput.disabled = true;
  updateSendBtnUI(true);
  scrollToBottom();

  try {
    const fullResponse = await streamChat(newText, null);
    conv.messages.push({ role: 'assistant', text: fullResponse });
  } catch (err) {
    if (err.name === 'AbortError') {
      const bubble = getLastAiBubble();
      if (bubble && bubble.querySelector('.typing-indicator')) {
        bubble.innerHTML = '<div style="color:var(--text-secondary);padding:8px;font-size:13px;">已取消生成</div>';
      }
    } else {
      console.error('编辑请求失败:', err);
      const errorBubble = getLastAiBubble();
      if (errorBubble) {
        errorBubble.innerHTML = `<div style="color:var(--error);padding:8px;"><strong>出错了</strong><br><span style="font-size:13px;">${escapeHtml(err.message)}</span></div>`;
      }
    }
  } finally {
    AppState.isStreaming = false;
    AppState.abortController = null;
    El.messageInput.disabled = false;
    updateSendBtnUI(false);
    updateSendBtn();
    El.messageInput.focus();
    updateWelcome();
    renderConvList();
  }
}

// ===================================================================
// 快捷发送
// ===================================================================
function quickSend(text) {
  El.messageInput.value = text;
  El.messageInput.style.height = 'auto';
  El.messageInput.style.height = Math.min(El.messageInput.scrollHeight, 200) + 'px';
  updateSendBtn();
  sendMessage();
}

// ===================================================================
// 暗色模式
// ===================================================================
function toggleDarkMode() {
  AppState.darkMode = !AppState.darkMode;
  document.body.classList.toggle('dark', AppState.darkMode);
  try { localStorage.setItem('aiStudioDarkMode', AppState.darkMode); } catch(e) {}

  // Update Monaco theme
  if (AppState.editor) monaco.editor.setTheme(getMonacoTheme());
  if (AppState.diffEditor) monaco.editor.setTheme(getMonacoTheme());
}

// ===================================================================
// 键盘事件 & 自动调整
// ===================================================================

// 键盘快捷键（不依赖 El 初始化顺序）
document.addEventListener('keydown', (e) => {
  // Ctrl+Enter to send in editor chat
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && document.activeElement === El.editorChatInput) {
    e.preventDefault();
    sendEditorChat();
  }
  // Escape to close modals
  if (e.key === 'Escape') {
    $$('.modal-overlay').forEach(m => m.style.display = 'none');
  }
  // Ctrl+S to save current file
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (AppState.activeFilePath) saveCurrentFile();
  }
});

// Sidebar toggle
function toggleSidebar() {
  El.sidebar.classList.toggle('open');
}

// ===================================================================
// 错误提示
// ===================================================================
function showError(title, detail) {
  console.error(title, detail);
  const area = El.viewChat && El.viewChat.classList.contains('active') ? El.messages : El.editorChatMessages;
  if (!area) return;
  if (area === El.editorChatMessages) {
    addEditorChatMessage('ai', `**${escapeHtml(title)}**\n\n${escapeHtml(detail)}`);
  } else {
    const div = document.createElement('div');
    div.style.cssText = 'text-align:center;padding:20px;color:var(--error);font-size:13px;';
    div.innerHTML = `<strong>${escapeHtml(title)}</strong><br><span>${escapeHtml(detail)}</span>`;
    area.appendChild(div);
    scrollToBottom();
  }
}

// ===================================================================
// 后端配置 (CC Switch 风格)
// ===================================================================
function openBackendConfig() {
  El.backendModal.style.display = 'flex';
  loadBackendStatus();
  loadSavedBackends();
}

async function loadBackendStatus() {
  try {
    const res = await fetch('/api/settings/backends');
    if (!res.ok) return;
    const data = await res.json();
    const active = data.active?.type || 'ollama';
    // 根据配置显示/隐藏通义千问标签
    const dashscopeTab = El.backendTabs.querySelector('.backend-tab[data-backend="dashscope"]');
    if (dashscopeTab) {
      dashscopeTab.style.display = data.dashscope_configured ? '' : 'none';
    }
    // Update tabs
    El.backendTabs.querySelectorAll('.backend-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.backend === active);
    });
    if (active !== 'ollama' && active !== 'dashscope') {
      // Custom backend is active
      El.customBackendTab.classList.add('active');
      showCustomBackendForm();
    }
  } catch(e) { console.warn('加载后端状态失败:', e); }
}

function activateBackendTab(type) {
  // 仅切换标签高亮和表单显示，不调用服务器
  El.backendTabs.querySelectorAll('.backend-tab').forEach(t => {
    t.classList.remove('active');
  });
  const tab = El.backendTabs.querySelector(`.backend-tab[data-backend="${type}"]`);
  if (tab) tab.classList.add('active');

  if (type === 'custom') {
    showCustomBackendForm();
  } else {
    hideCustomBackendForm();
    // 内置后端直接激活
    activateBackend(type);
  }
}

function showCustomBackendForm() {
  El.customBackendForm.style.display = 'block';
  El.testResult.style.display = 'none';
}

function hideCustomBackendForm() {
  El.customBackendForm.style.display = 'none';
}

function toggleApiKeyVisibility() {
  const input = El.bcApiKey;
  if (input.type === 'password') {
    input.type = 'text';
  } else {
    input.type = 'password';
  }
}

async function activateBackend(type) {
  try {
    const res = await fetch('/api/settings/activate-backend', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ type }),
    });
    if (!res.ok) {
      const err = await res.json();
      showError('激活失败', err.detail || '未知错误');
      return;
    }
    // Update UI
    El.backendTabs.querySelectorAll('.backend-tab').forEach(t => {
      t.classList.remove('active');
    });
    const tab = El.backendTabs.querySelector(`.backend-tab[data-backend="${type}"]`);
    if (tab) tab.classList.add('active');
    if (type === 'custom') {
      showCustomBackendForm();
    } else {
      hideCustomBackendForm();
    }
    checkHealth();
    showError('后端已切换', `已切换到 ${type === 'ollama' ? 'Ollama (本地)' : type === 'dashscope' ? '通义千问 (DashScope)' : type}`);
  } catch(e) {
    showError('激活失败', e.message);
  }
}

async function testBackendConnection() {
  const url = El.bcUrl.value.trim();
  const apiKey = El.bcApiKey.value.trim();
  const model = El.bcModel.value.trim();
  const provider = El.bcProvider.value;

  if (!url) { showTestResult('error', '请填写 API 地址'); return; }

  showTestResult('loading', '正在测试连接...');

  try {
    const res = await fetch('/api/settings/test-backend', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ base_url: url, api_key: apiKey, model, provider }),
    });
    const data = await res.json();
    if (data.success) {
      showTestResult('success', data.message || '连接成功 ✓');
    } else {
      showTestResult('error', data.error || '连接失败');
    }
  } catch(e) {
    showTestResult('error', '请求失败: ' + e.message);
  }
}

function showTestResult(type, msg) {
  El.testResult.style.display = 'block';
  El.testResult.className = 'test-result ' + type;
  El.testResult.innerHTML = type === 'loading'
    ? `<span>⏳ ${escapeHtml(msg)}</span>`
    : type === 'success'
    ? `<span>✅ ${escapeHtml(msg)}</span>`
    : `<span>❌ ${escapeHtml(msg)}</span>`;
}

async function saveCustomBackend() {
  const name = El.bcName.value.trim();
  const url = El.bcUrl.value.trim();
  const apiKey = El.bcApiKey.value.trim();
  const model = El.bcModel.value.trim();
  const provider = El.bcProvider.value;

  if (!name) { showTestResult('error', '请填写后端名称'); return; }
  if (!url) { showTestResult('error', '请填写 API 地址'); return; }

  try {
    const res = await fetch('/api/settings/backends', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, base_url: url, api_key: apiKey, model, provider }),
    });
    if (!res.ok) {
      const err = await res.json();
      showTestResult('error', err.detail || '保存失败');
      return;
    }
    showTestResult('success', `后端「${name}」已保存 ✓`);
    loadSavedBackends();
    // Auto-activate
    await activateBackend(name);
  } catch(e) {
    showTestResult('error', '保存失败: ' + e.message);
  }
}

async function loadSavedBackends() {
  try {
    const res = await fetch('/api/settings/backends');
    if (!res.ok) return;
    const data = await res.json();
    const backends = data.backends || {};
    const list = El.savedBackendsList;
    const names = Object.keys(backends);
    if (names.length === 0) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);padding:8px 0;">暂无自定义后端配置</div>';
      return;
    }
    list.innerHTML = names.map(name => {
      const b = backends[name];
      const active = data.active?.type === name;
      return `<div class="saved-backend-item" style="${active ? 'border-color:var(--accent);background:rgba(0,122,255,0.05);' : ''}">
        <span class="sb-icon">🔌</span>
        <div class="sb-info">
          <div class="sb-name">${escapeHtml(name)}${active ? ' <span style="color:var(--accent);font-size:10px;">✓ 当前</span>' : ''}</div>
          <div class="sb-detail">${escapeHtml(b.base_url || '')} · ${escapeHtml(b.model || '')}</div>
        </div>
        <div class="sb-actions">
          <button class="sb-btn" onclick="activateBackend('${escapeHtml(name)}')">使用</button>
          <button class="sb-btn danger" onclick="deleteCustomBackend('${escapeHtml(name)}')">删除</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.warn('加载后端列表失败:', e); }
}

async function deleteCustomBackend(name) {
  if (!confirm(`确定删除后端「${name}」？`)) return;
  try {
    await fetch('/api/settings/backends', {
      method: 'DELETE',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name }),
    });
    loadSavedBackends();
    showTestResult('success', `已删除「${name}」`);
  } catch(e) {
    showTestResult('error', '删除失败: ' + e.message);
  }
}

// ===================================================================
// 安全校验集成
// ===================================================================
async function scanCodeForSecurity(content, filename) {
  try {
    const res = await fetch('/api/security/scan', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ content, filename }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) {
    console.warn('安全扫描失败:', e);
    return null;
  }
}

function renderSecurityReport(report) {
  if (!report || !report.findings || report.findings.length === 0) {
    return `<div class="security-report">
      <div class="sr-header safe">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        ✅ 安全检查通过 — 未发现明显风险
      </div>
    </div>`;
  }

  const sevLabel = { high: '高危', warning: '警告', info: '信息' };
  const sevClass = { high: 'high', warning: 'warning', info: 'info' };
  const overallClass = report.overall === 'danger' ? 'danger' : report.overall === 'warning' ? 'warning' : 'safe';
  const overallText = report.overall === 'danger' ? '⚠️ 发现安全隐患' : report.overall === 'warning' ? '⚡ 发现潜在问题' : '✅ 基本安全';

  let findingsHtml = report.findings.map(f =>
    `<div class="sr-finding">
      <span class="sr-severity ${sevClass[f.severity] || 'info'}">${sevLabel[f.severity] || f.severity}</span>
      <span class="sr-desc">${escapeHtml(f.description)}</span>
      <div><span class="sr-line">第 ${f.line} 行</span> <span class="sr-code">${escapeHtml(f.code || '')}</span></div>
    </div>`
  ).join('');

  return `<div class="security-report">
    <div class="sr-header ${overallClass}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      ${overallText} (评分: ${report.score}/100)
    </div>
    <div class="sr-body">${findingsHtml}</div>
  </div>`;
}

async function showSecurityConfirm(originalContent, newContent, filename) {
  return new Promise(async (resolve) => {
    // Scan the new code
    const report = await scanCodeForSecurity(newContent, filename);

    // Check if there are high-severity issues
    const hasHighRisk = report && report.findings.some(f => f.severity === '高危');

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'security-confirm-overlay';
    overlay.innerHTML = `
      <div class="security-confirm">
        <div class="sc-title">
          ${hasHighRisk ? '⚠️ 安全风险提醒' : '🔒 代码变更确认'}
        </div>
        <div class="sc-text">
          ${report ? renderSecurityReport(report) : '<p>正在扫描代码安全性...</p>'}
          <p style="margin-top:12px;font-size:13px;color:var(--text-secondary);">
            ${hasHighRisk
              ? '检测到高危风险，请谨慎应用此变更。'
              : '请确认是否应用此 AI 生成的代码变更？'}
          </p>
        </div>
        <div class="sc-actions">
          <button class="modal-btn secondary" id="scReject">取消</button>
          <button class="modal-btn primary" id="scAccept" style="${hasHighRisk ? 'background:var(--error);' : ''}">
            ${hasHighRisk ? '仍然应用' : '✓ 确认应用'}
          </button>
        </div>
      </div>
    `;

    // Find the editor container to place the overlay
    const container = El.editorContainer || document.querySelector('.editor-layout');
    if (container) {
      container.style.position = 'relative';
      container.appendChild(overlay);
    }

    document.getElementById('scReject').onclick = () => {
      overlay.remove();
      if (container) container.style.position = '';
      resolve(false);
    };
    document.getElementById('scAccept').onclick = () => {
      overlay.remove();
      if (container) container.style.position = '';
      resolve(true);
    };
  });
}

async function acceptChangesWithSecurity() {
  if (!AppState.pendingDiff) return;
  const { modified, path } = AppState.pendingDiff;
  const filename = path.split('/').pop() || path.split('\\').pop() || 'file';

  // Show security confirmation
  const confirmed = await showSecurityConfirm(AppState.pendingDiff.original, modified, filename);
  if (!confirmed) return;

  // Proceed with accept
  await acceptChanges();
}

// ===================================================================
// 初始化
// ===================================================================
async function init() {
  try {
    initDoms();

    // 滚动监听：用户主动上滑时锁定自动滚动
    El.chatContainer.addEventListener('scroll', () => {
      _chatScrollLock = !isNearBottom(El.chatContainer, 30);
    }, { passive: true });
    El.editorChatMessages.addEventListener('scroll', () => {
      _ecScrollLock = !isNearBottom(El.editorChatMessages, 30);
    }, { passive: true });

    // Dark mode from localStorage
    try {
      const savedDark = localStorage.getItem('aiStudioDarkMode') === 'true';
      if (savedDark) { AppState.darkMode = true; document.body.classList.add('dark'); }
    } catch(e) { /* localStorage 可能不可用 */ }

    // Create default conversation
    newChat();

    // Health check & model list (不阻塞后续初始化)
    checkHealth().catch(e => console.warn('checkHealth 失败:', e));

    // Initialize Monaco (不阻塞)
    initMonaco().then(() => {
      try { monaco.editor.setTheme(getMonacoTheme()); } catch(e) {}
    }).catch(e => console.warn('Monaco 初始化失败:', e));

    // Auto-resize textarea
    if (El.messageInput) El.messageInput.style.height = 'auto';

    // === UI 事件绑定（必须在 initDoms 之后） ===
    try {
      // 消息输入框自动调整
      if (El.messageInput) {
        El.messageInput.addEventListener('input', () => {
          El.messageInput.style.height = 'auto';
          El.messageInput.style.height = Math.min(El.messageInput.scrollHeight, 200) + 'px';
          updateSendBtn();
        });
        El.messageInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
      }
      // 聊天区域拖拽上传
      if (El.chatContainer) {
        El.chatContainer.addEventListener('dragenter', e => {
          e.preventDefault(); dragCounter++;
          if (dragCounter === 1) {
            El.chatContainer.style.border = '2px dashed var(--accent)';
            El.chatContainer.style.background = 'rgba(0,122,255,0.03)';
          }
        });
        El.chatContainer.addEventListener('dragleave', e => {
          e.preventDefault(); dragCounter--;
          if (dragCounter === 0) {
            El.chatContainer.style.border = 'none';
            El.chatContainer.style.background = '';
          }
        });
        El.chatContainer.addEventListener('drop', e => {
          e.preventDefault(); dragCounter = 0;
          El.chatContainer.style.border = 'none';
          El.chatContainer.style.background = '';
          const file = e.dataTransfer.files[0];
          if (file) { AppState.uploadedFile = file; showFilePreview(file); }
        });
        // Mobile: click main content to close sidebar
        El.chatContainer.addEventListener('click', () => {
          if (window.innerWidth <= 768 && El.sidebar.classList.contains('open')) {
            El.sidebar.classList.remove('open');
          }
        });
      }
      // 工作空间选择器点击 — 始终弹出选择/切换对话框
      if (El.workspaceSelector) {
        El.workspaceSelector.addEventListener('click', () => {
          openWorkspaceDialog();
        });
      }
    } catch(e) { console.warn('UI 事件绑定失败:', e); }

    // === 安全可靠的按钮绑定 (addEventListener 备份) ===
    const bindBtn = (id, fn) => {
      try {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); });
      } catch(e) { console.warn('按钮绑定失败:', id, e); }
    };
    bindBtn('openWorkspaceBtn', () => openWorkspaceDialog());
    const editorTab = document.getElementById('editorTab');
    if (editorTab) editorTab.addEventListener('click', (e) => { e.preventDefault(); switchTab('editor'); });
    const chatTab = document.querySelector('.tab[data-tab="chat"]');
    if (chatTab) chatTab.addEventListener('click', (e) => { e.preventDefault(); switchTab('chat'); });

    // === 延时加载模型列表后自动选中第一个 ===
    setTimeout(async () => {
      try {
        if (!AppState.currentModel && El.modelSelect && El.modelSelect.options.length > 0) {
          El.modelSelect.selectedIndex = 0;
          AppState.currentModel = El.modelSelect.value;
        }
      } catch(e) { console.warn('模型自动选择失败:', e); }
    }, 2000);

    // === 加载已保存的自定义后端 ===
    try { loadSavedBackends(); } catch(e) { console.warn('加载后端列表失败:', e); }

    // === 初始化侧边栏视图（未打开工作空间） ===
    try {
      if (El.workspaceEmptyView && El.workspaceOpenView) {
        El.workspaceEmptyView.style.display = '';
        El.workspaceOpenView.style.display = 'none';
      }
      renderSidebarRecentWorkspaces();
    } catch(e) {}

    console.log('AI Studio 已启动');
  } catch(e) {
    console.error('AI Studio 初始化失败:', e);
    // 即使初始化出错，也尽量保证按钮可用
    try {
      document.querySelectorAll('[onclick]').forEach(el => {
        const fnName = el.getAttribute('onclick').replace(/\(.*\)/, '').trim();
        if (typeof window[fnName] !== 'function') {
          console.warn('onclick 函数未定义:', fnName);
        }
      });
    } catch(e2) {}
  }
}

document.addEventListener('DOMContentLoaded', init);
