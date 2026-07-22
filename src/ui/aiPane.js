/* =========================================================
 * src/ui/aiPane.js
 *
 * 右栏 AI 面板（design.md §2、§4）。
 *
 * - 4 个 tab：总结(summarize) / 概念(explainConcepts) / 质疑(critique) / 对话(chat)
 * - 三大分析 tab：生成按钮 + .md-body 结果区，createStreamingRenderer 边收边渲染
 * - chat tab：消息列表（user/assistant 气泡）+ 输入框 + 发送按钮
 *   · Enter 发送、Shift+Enter 换行
 *   · 输入法合成（composition）期间 Enter 不触发发送
 * - 流式期间禁用按钮、显示停止按钮（AbortController.abort()）
 * - 错误（未填 Key/未加载论文/API 错/取消）捕获后在当前 tab 内清晰展示，绝不静默
 * - 保存按钮：弹出下载选项对话框 → 选择格式(.md / .pdf) + 文件名 + 保存路径
 *
 * 暴露：initAiPane()——创建 DOM、绑定事件、订阅 store。幂等。
 * ========================================================= */

import { getState, setState, subscribe } from '../state/store.js';
import * as client from '../ai/client.js';
import { createStreamingRenderer, renderMarkdown } from './render.js';
import { describeErr } from '../utils/errors.js';

const TABS = [
  { id: 'summarize', label: '总结' },
  { id: 'explainConcepts', label: '概念' },
  { id: 'critique', label: '质疑' },
  { id: 'chat', label: '对话' },
];

/** @type {HTMLElement | null} */
let root = null;

/** @type {AbortController | null} */
let currentController = null;

/** 各分析 tab 最近一次生成的原始 markdown 文本（用于保存）。 */
const savedResults = /** @type {Record<string, string>} */ ({
  summarize: '',
  explainConcepts: '',
  critique: '',
});

/** Tab id → 中文短标签（用于文件名）。 */
const TAB_LABEL = /** @type {Record<string, string>} */ ({
  summarize: '总结',
  explainConcepts: '概念解释',
  critique: '质疑',
  chat: '对话',
});

// ---------- 保存/下载工具 ----------

/**
 * 生成合法的下载文件名（不含扩展名）。
 * @param {string} paperTitle 论文标题（可能含非法字符）
 * @param {string} tag 类型标签（如"总结""质疑""对话"）
 * @returns {string}
 */
function makeFilename(paperTitle, tag) {
  const safe = (paperTitle || '未命名论文').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  const date = new Date().toISOString().slice(0, 10);
  return `${safe}_${tag}_${date}`;
}

/**
 * 触发浏览器直接下载（Blob 方式，不选路径）。
 * @param {string} content 文件内容
 * @param {string} filename 文件名
 * @param {string} [mimeType]
 */
function downloadFile(content, filename, mimeType) {
  const mime = mimeType || 'text/markdown;charset=utf-8';
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 使用 File System Access API 保存到用户选择的路径。
 * 不可用时回退到直接下载。
 * @param {string} content
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<boolean>} 是否成功（用户取消返回 false）
 */
async function saveViaFileSystemAPI(content, filename, mimeType) {
  try {
    if (!window.showSaveFilePicker) {
      downloadFile(content, filename, mimeType);
      return true;
    }
    const ext = filename.split('.').pop() || 'md';
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: ext === 'pdf' ? 'PDF 文档' : 'Markdown 文档',
        accept: ext === 'pdf'
          ? { 'application/pdf': ['.pdf'] }
          : { 'text/markdown': ['.md'] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch (err) {
    // AbortError = 用户点了取消
    if (/** @type {DOMException} */ (err).name === 'AbortError') return false;
    // 其他错误回退到直接下载
    downloadFile(content, filename, mimeType);
    return true;
  }
}

/**
 * 构建 markdown → 完整 HTML 文档（供打印/PDF 使用）。
 * 复用 renderMarkdown 以得到正确的 KaTeX 渲染结果。
 * @param {string} markdownContent
 * @returns {string} 完整的 HTML 文档字符串
 */
function buildPrintHtml(markdownContent) {
  const temp = document.createElement('div');
  renderMarkdown(temp, markdownContent || '');
  const bodyHtml = temp.innerHTML;

  // 收集当前页所有 <style>（含 KaTeX 字体/样式），保证打印窗口排版一致
  const styles = Array.from(document.querySelectorAll('style'))
    .map((s) => s.outerHTML)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>AI 阅读导出</title>
  ${styles}
  <style>
    body {
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.8;
      color: #1f2328;
    }
    @media print {
      body { margin: 0; padding: 20px; }
    }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/**
 * 执行实际下载。
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'chat'} task
 * @param {'md' | 'pdf'} format
 * @param {string} filename
 * @param {boolean} useFileSystemAPI 是否使用 File System Access API 选择路径
 * @returns {Promise<boolean>}
 */
async function executeDownload(task, format, filename, useFileSystemAPI) {
  // 获取 markdown 内容
  let markdownContent;
  if (task === 'chat') {
    markdownContent = buildChatMarkdown();
  } else {
    markdownContent = buildAnalyzeMarkdown(
      /** @type {'summarize' | 'explainConcepts' | 'critique'} */ (task),
      savedResults[task] || '',
    );
  }

  if (format === 'md') {
    if (useFileSystemAPI) {
      return await saveViaFileSystemAPI(markdownContent, filename, 'text/markdown;charset=utf-8');
    }
    downloadFile(markdownContent, filename, 'text/markdown;charset=utf-8');
    return true;
  }

  // PDF：打开打印窗口（用户可在打印对话框中选择"另存为 PDF"并指定路径）
  const html = buildPrintHtml(markdownContent);
  const w = window.open('', '_blank');
  if (!w) {
    alert('弹窗被浏览器拦截，请允许本站弹窗后重试。');
    return false;
  }
  w.document.write(html);
  w.document.close();
  // 等待资源加载完毕后触发打印
  w.addEventListener('load', () => {
    setTimeout(() => w.print(), 200);
  });
  // 兜底：document 可能已经 complete
  if (w.document.readyState === 'complete') {
    setTimeout(() => w.print(), 300);
  }
  return true;
}

/**
 * 构建分析 Tab 的 markdown 文件内容。
 * @param {'summarize' | 'explainConcepts' | 'critique'} task
 * @param {string} rawText AI 原始输出
 * @returns {string}
 */
function buildAnalyzeMarkdown(task, rawText) {
  const { paper } = getState();
  const title = paper?.meta?.title || paper?.name || '未命名论文';
  const now = new Date().toLocaleString('zh-CN');
  const tag = TAB_LABEL[task] || task;
  return [
    `# ${title}`,
    '',
    `> **${tag}**  |  生成时间：${now}`,
    '',
    '---',
    '',
    (rawText || '').trim(),
  ].join('\n');
}

/**
 * 构建对话记录的 markdown 文件内容。
 * @returns {string}
 */
function buildChatMarkdown() {
  const { paper, messages } = getState();
  const title = paper?.meta?.title || paper?.name || '未命名论文';
  const now = new Date().toLocaleString('zh-CN');
  const lines = [
    `# ${title}`,
    '',
    `> **对话记录**  |  导出时间：${now}`,
    '',
    '---',
    '',
  ];
  for (const m of messages) {
    const roleLabel = m.role === 'user' ? '**🧑 你**' : '**🤖 AI**';
    lines.push(`### ${roleLabel}`);
    lines.push('');
    lines.push((m.content || '').trim());
    lines.push('');
  }
  return lines.join('\n');
}

/** 同步分析 Tab 保存按钮状态。 */
function syncSaveButton(task) {
  if (!root) return;
  const btn = root.querySelector(`[data-action="save"][data-task="${task}"]`);
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = !savedResults[task] || getState().ui.busy;
  }
}

/** 同步对话 Tab 保存按钮状态。 */
function syncChatSaveButton() {
  if (!root) return;
  const btn = root.querySelector('[data-action="save-chat"]');
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = getState().messages.length === 0 || getState().ui.busy;
  }
}

// =========================================================
// 下载选项对话框
// =========================================================

/** 关闭已存在的下载对话框。 */
function closeDownloadDialog() {
  document.querySelectorAll('.download-dialog-overlay').forEach((el) => el.remove());
}

/**
 * 弹出下载选项对话框。
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'chat'} task
 */
function showDownloadDialog(task) {
  closeDownloadDialog();

  const tag = TAB_LABEL[task] || task;
  const baseName = makeFilename(
    getState().paper?.meta?.title || getState().paper?.name || '',
    tag,
  );

  const overlay = document.createElement('div');
  overlay.className = 'download-dialog-overlay';
  overlay.innerHTML = `
    <div class="download-dialog">
      <div class="download-dialog__header">
        <h3>保存「${escapeHtml(tag)}」</h3>
        <button type="button" class="download-dialog__close"
          data-action="dl-close">&times;</button>
      </div>
      <div class="download-dialog__body">
        <label class="download-dialog__label">文件格式</label>
        <div class="download-dialog__format">
          <label class="download-dialog__radio">
            <input type="radio" name="dl-format" value="md" checked>
            <span class="download-dialog__radio-text">
              <strong>Markdown (.md)</strong>
              <small>纯文本格式，兼容性好，可再次编辑</small>
            </span>
          </label>
          <label class="download-dialog__radio">
            <input type="radio" name="dl-format" value="pdf">
            <span class="download-dialog__radio-text">
              <strong>PDF (.pdf)</strong>
              <small>排版固定，适合打印和分享</small>
            </span>
          </label>
        </div>
        <label class="download-dialog__label" for="dl-filename">文件名</label>
        <input id="dl-filename" type="text"
          class="download-dialog__filename-input"
          value="${escapeHtml(baseName)}.md" data-dl-filename>
      </div>
      <div class="download-dialog__actions">
        <button type="button" class="ai-btn ai-btn--ghost"
          data-action="dl-close">取消</button>
        <button type="button" class="ai-btn ai-btn--ghost"
          data-action="dl-direct">直接下载</button>
        <button type="button" class="ai-btn ai-btn--primary"
          data-action="dl-path">选择路径保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // --- 事件绑定 ---
  const close = () => closeDownloadDialog();
  const filenameInput = /** @type {HTMLInputElement | null} */ (
    overlay.querySelector('[data-dl-filename]')
  );

  // 关闭按钮 + 点击遮罩关闭
  overlay.querySelectorAll('[data-action="dl-close"]').forEach((b) =>
    b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  // 直接下载
  overlay.querySelector('[data-action="dl-direct"]')?.addEventListener('click', () => {
    const format = /** @type {HTMLInputElement} */ (
      overlay.querySelector('input[name="dl-format"]:checked')
    ).value;
    const fname = filenameInput?.value || `${baseName}.${format}`;
    void executeDownload(task, /** @type {'md' | 'pdf'} */ (format), fname, false);
    close();
  });

  // 选择路径保存
  overlay.querySelector('[data-action="dl-path"]')?.addEventListener('click', async () => {
    const format = /** @type {HTMLInputElement} */ (
      overlay.querySelector('input[name="dl-format"]:checked')
    ).value;
    const fname = filenameInput?.value || `${baseName}.${format}`;
    const ok = await executeDownload(task, /** @type {'md' | 'pdf'} */ (format), fname, true);
    if (ok) close();
  });

  // 切换格式时同步扩展名
  overlay.querySelectorAll('input[name="dl-format"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!filenameInput) return;
      const fmt = /** @type {HTMLInputElement} */ (
        overlay.querySelector('input[name="dl-format"]:checked')
      ).value;
      filenameInput.value = filenameInput.value.replace(/\.(md|pdf)$/, `.${fmt}`);
    });
  });

  // 聚焦并全选文件名
  if (filenameInput) {
    filenameInput.focus();
    filenameInput.select();
  }
}

// ---------- escapeHtml ----------

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =========================================================
// 初始化
// =========================================================

/**
 * 初始化右栏 AI 面板。幂等。
 */
export function initAiPane() {
  if (root) return;
  const paneAi = document.getElementById('pane-ai');
  if (!paneAi) {
    console.warn('[aiPane] 找不到 #pane-ai');
    return;
  }
  // 清空原占位
  paneAi.innerHTML = '';

  root = document.createElement('div');
  root.className = 'ai-pane';
  root.innerHTML = `
    <div class="ai-tabs" role="tablist">
      ${TABS.map(
        (t) => `
        <button type="button" class="ai-tab" role="tab"
          data-tab="${t.id}" aria-selected="false">${t.label}</button>`,
      ).join('')}
    </div>
    <div class="ai-body">
      ${renderAnalyzeTab('summarize', '总结', '生成结构化的全文总结（一句话/背景/方法/结果/局限）。')}
      ${renderAnalyzeTab('explainConcepts', '解释概念', '抽取并解释论文中的关键概念（含官方定义 + 通俗解释）。')}
      ${renderAnalyzeTab('critique', '批判质疑', '从方法/结果/论证三个层面对论文提出质疑并给改进建议。')}
      ${renderChatTab()}
    </div>
  `;
  paneAi.appendChild(root);

  bindTabs();
  bindAnalyzeButtons();
  bindChat();

  // 订阅 store：tab 高亮 + busy 态同步 + 追问联动 + 保存按钮状态
  subscribe((s) => {
    syncTabs(s.ui.activeTab);
    syncBusy(s.ui.busy);
    syncChatSaveButton();
    // 中栏追问联动：textPane 设置 quickAsk + 切到 chat tab
    if (s.ui.quickAsk && s.ui.activeTab === 'chat' && !s.ui.busy) {
      const text = s.ui.quickAsk;
      setState({ ui: { ...getState().ui, quickAsk: null } });
      const input = /** @type {HTMLTextAreaElement | null} */ (
        root?.querySelector('[data-chat-input]')
      );
      if (input) {
        input.value = text;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
        void sendChat();
      }
    }
  });
  syncTabs(getState().ui.activeTab);
  syncBusy(getState().ui.busy);
  syncChatSaveButton();
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} desc
 */
function renderAnalyzeTab(id, label, desc) {
  return `
    <section class="ai-pane__section" data-section="${id}" hidden>
      <div class="ai-section__head">
        <div class="ai-section__title">${label}</div>
        <div class="ai-section__actions">
          <button type="button" class="ai-btn ai-btn--primary"
            data-action="generate" data-task="${id}">生成</button>
          <button type="button" class="ai-btn ai-btn--ghost"
            data-action="save" data-task="${id}" disabled>保存</button>
          <button type="button" class="ai-btn ai-btn--ghost"
            data-action="stop" hidden>停止</button>
        </div>
      </div>
      <div class="ai-section__desc">${desc}</div>
      <div class="ai-error" data-error hidden></div>
      <div class="ai-result" data-result>
        <div class="ai-placeholder">点击"生成"开始（结果会流式显示在这里）。</div>
      </div>
    </section>
  `;
}

function renderChatTab() {
  return `
    <section class="ai-pane__section ai-pane__section--chat" data-section="chat" hidden>
      <div class="ai-error" data-error hidden></div>
      <div class="chat-list" data-chat-list></div>
      <div class="chat-composer">
        <textarea class="chat-input" data-chat-input rows="2"
          placeholder="基于当前论文提问…（Enter 发送 · Shift+Enter 换行）"></textarea>
        <div class="chat-composer__actions">
          <button type="button" class="ai-btn ai-btn--ghost"
            data-action="save-chat" disabled>保存对话</button>
          <button type="button" class="ai-btn ai-btn--ghost"
            data-action="stop" hidden>停止</button>
          <button type="button" class="ai-btn ai-btn--primary"
            data-action="send">发送</button>
        </div>
      </div>
    </section>
  `;
}

// =========================================================
// Tab 切换
// =========================================================

function bindTabs() {
  if (!root) return;
  root.querySelectorAll('.ai-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = /** @type {HTMLElement} */ (btn);
      const id = el.dataset.tab;
      if (!id) return;
      if (getState().ui.busy) return;
      setState({
        ui: { ...getState().ui, activeTab: /** @type {any} */ (id) },
      });
    });
  });
}

/**
 * @param {string} activeTab
 */
function syncTabs(activeTab) {
  if (!root) return;
  root.querySelectorAll('.ai-tab').forEach((btn) => {
    const el = /** @type {HTMLElement} */ (btn);
    const active = el.dataset.tab === activeTab;
    el.setAttribute('aria-selected', String(active));
    el.classList.toggle('ai-tab--active', active);
  });
  root.querySelectorAll('.ai-pane__section').forEach((sec) => {
    const el = /** @type {HTMLElement} */ (sec);
    el.hidden = el.dataset.section !== activeTab;
  });
}

// =========================================================
// busy 态
// =========================================================

/**
 * @param {boolean} busy
 */
function syncBusy(busy) {
  if (!root) return;
  root.querySelectorAll('[data-action="generate"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = busy;
  });
  root.querySelectorAll('[data-action="send"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = busy;
  });
  root.querySelectorAll('[data-action="save"]').forEach((btn) => {
    const el = /** @type {HTMLElement} */ (btn);
    /** @type {HTMLButtonElement} */ (btn).disabled =
      busy || !savedResults[el.dataset.task || ''];
  });
  root.querySelectorAll('[data-action="save-chat"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled =
      busy || getState().messages.length === 0;
  });
  root.querySelectorAll('[data-action="stop"]').forEach((btn) => {
    /** @type {HTMLElement} */ (btn).hidden = !busy;
  });
}

// =========================================================
// 分析 tab
// =========================================================

function bindAnalyzeButtons() {
  if (!root) return;
  root.querySelectorAll('[data-action="generate"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement} */ (e.currentTarget);
      const task = el.dataset.task;
      if (!task) return;
      void runAnalyze(
        /** @type {'summarize' | 'explainConcepts' | 'critique'} */ (task),
      );
    });
  });
  root.querySelectorAll('[data-action="stop"]').forEach((btn) => {
    btn.addEventListener('click', () => abortCurrent());
  });
  // 分析 Tab 保存按钮 → 弹出下载对话框
  root.querySelectorAll('[data-action="save"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement} */ (e.currentTarget);
      const task = el.dataset.task;
      if (!task || !savedResults[task]) return;
      showDownloadDialog(
        /** @type {'summarize' | 'explainConcepts' | 'critique'} */ (task),
      );
    });
  });
  // 对话 Tab 保存按钮 → 弹出下载对话框
  const saveChatBtn = root.querySelector('[data-action="save-chat"]');
  saveChatBtn?.addEventListener('click', () => {
    showDownloadDialog('chat');
  });
}

/**
 * @param {'summarize' | 'explainConcepts' | 'critique'} task
 */
async function runAnalyze(task) {
  if (!root) return;
  if (getState().ui.busy) return;
  const section = /** @type {HTMLElement} */ (
    root.querySelector(`[data-section="${task}"]`)
  );
  if (!section) return;
  const resultEl = /** @type {HTMLElement} */ (
    section.querySelector('[data-result]')
  );
  const errorEl = /** @type {HTMLElement} */ (
    section.querySelector('[data-error]')
  );
  if (!resultEl || !errorEl) return;

  hideError(errorEl);
  resultEl.innerHTML = '<div class="ai-placeholder">生成中…</div>';

  currentController = new AbortController();
  setState({ ui: { ...getState().ui, busy: true } });

  const renderer = createStreamingRenderer(resultEl, { intervalMs: 80 });
  try {
    const iterable =
      task === 'summarize'
        ? client.summarize(currentController.signal)
        : task === 'explainConcepts'
          ? client.explainConcepts(currentController.signal)
          : client.critique(currentController.signal);
    for await (const chunk of iterable) {
      renderer.push(chunk);
    }
    renderer.finalize();
    savedResults[task] = renderer.getText();
  } catch (err) {
    renderer.finalize();
    savedResults[task] = renderer.getText();
    showError(errorEl, describeErr(err));
  } finally {
    syncSaveButton(task);
    setState({ ui: { ...getState().ui, busy: false } });
    currentController = null;
  }
}

// =========================================================
// 对话 tab
// =========================================================

function bindChat() {
  if (!root) return;
  const sendBtn = root.querySelector('[data-action="send"]');
  const input = /** @type {HTMLTextAreaElement | null} */ (
    root.querySelector('[data-chat-input]')
  );
  sendBtn?.addEventListener('click', () => void sendChat());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendChat();
    }
  });
  renderChatList();
}

async function sendChat() {
  if (!root) return;
  if (getState().ui.busy) return;
  const input = /** @type {HTMLTextAreaElement | null} */ (
    root.querySelector('[data-chat-input]')
  );
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const errorEl = /** @type {HTMLElement} */ (
    root.querySelector('.ai-pane__section--chat [data-error]')
  );
  if (errorEl) hideError(errorEl);

  input.value = '';
  appendChatBubble('user', text);

  const assistantEl = appendChatBubble('assistant', '');

  currentController = new AbortController();
  setState({ ui: { ...getState().ui, busy: true } });

  const renderer = createStreamingRenderer(assistantEl, { intervalMs: 80 });
  try {
    for await (const chunk of client.chat(text, currentController.signal)) {
      renderer.push(chunk);
    }
    renderer.finalize();
  } catch (err) {
    renderer.finalize();
    if (errorEl) showError(errorEl, describeErr(err));
  } finally {
    setState({ ui: { ...getState().ui, busy: false } });
    currentController = null;
    syncChatSaveButton();
  }
}

function renderChatList() {
  if (!root) return;
  const list = root.querySelector('[data-chat-list]');
  if (!list) return;
  list.innerHTML = '';
  const { messages } = getState();
  for (const m of messages) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-bubble--${m.role}`;
    if (m.role === 'assistant') {
      renderMarkdown(bubble, m.content || '', { finalize: true });
    } else {
      bubble.textContent = m.content || '';
    }
    list.appendChild(bubble);
  }
  scrollChatToBottom();
}

/**
 * @param {'user' | 'assistant'} role
 * @param {string} text
 * @returns {HTMLElement}
 */
function appendChatBubble(role, text) {
  if (!root) return document.createElement('div');
  const list = root.querySelector('[data-chat-list]');
  if (!list) return document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble--${role}`;
  if (role === 'user') {
    bubble.textContent = text;
  }
  list.appendChild(bubble);
  scrollChatToBottom();
  return bubble;
}

function scrollChatToBottom() {
  if (!root) return;
  const list = root.querySelector('[data-chat-list]');
  if (list instanceof HTMLElement) {
    list.scrollTop = list.scrollHeight;
  }
}

// =========================================================
// 工具
// =========================================================

function abortCurrent() {
  if (currentController) {
    try { currentController.abort(); } catch { /* ignore */ }
  }
}

/**
 * @param {HTMLElement} el
 * @param {string} msg
 */
function showError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

/**
 * @param {HTMLElement | null | undefined} el
 */
function hideError(el) {
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}
