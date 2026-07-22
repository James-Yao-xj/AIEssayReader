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
 * - 保存按钮：将 AI 结果/对话以 Markdown 文件下载到本地
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
 * 生成合法的下载文件名。
 * @param {string} paperTitle 论文标题（可能含非法字符）
 * @param {string} tag 类型标签（如"总结""质疑""对话"）
 * @returns {string}
 */
function makeFilename(paperTitle, tag) {
  const safe = (paperTitle || '未命名论文').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  const date = new Date().toISOString().slice(0, 10);
  return `${safe}_${tag}_${date}.md`;
}

/**
 * 触发浏览器下载。
 * @param {string} content 文件内容
 * @param {string} filename 文件名
 */
function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
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
      // 立即清空 quickAsk 防重入
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
      // 流式中禁止切换 tab（避免视觉错乱）
      if (getState().ui.busy) return;
      setState({
        ui: { ...getState().ui, activeTab: /** @type {any} */ (id) },
      });
    });
  });
}

/**
 * 同步 tab 高亮与 section 可见性。
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
// busy 态：禁用按钮、显示停止按钮
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
    /** @type {HTMLButtonElement} */ (btn).disabled = busy || !savedResults[/** @type {HTMLElement} */ (btn).dataset.task || ''];
  });
  root.querySelectorAll('[data-action="save-chat"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = busy || getState().messages.length === 0;
  });
  root.querySelectorAll('[data-action="stop"]').forEach((btn) => {
    /** @type {HTMLElement} */ (btn).hidden = !busy;
  });
}

// =========================================================
// 分析 tab（summarize / explainConcepts / critique）
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
  // 所有停止按钮共用同一个 abort 入口
  root.querySelectorAll('[data-action="stop"]').forEach((btn) => {
    btn.addEventListener('click', () => abortCurrent());
  });
  // 分析 Tab 保存按钮
  root.querySelectorAll('[data-action="save"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement} */ (e.currentTarget);
      const task = el.dataset.task;
      if (!task || !savedResults[task]) return;
      const content = buildAnalyzeMarkdown(
        /** @type {'summarize' | 'explainConcepts' | 'critique'} */ (task),
        savedResults[task],
      );
      const tag = TAB_LABEL[task] || task;
      const filename = makeFilename(
        getState().paper?.meta?.title || getState().paper?.name || '',
        tag,
      );
      downloadFile(content, filename);
    });
  });
  // 对话 Tab 保存按钮
  const saveChatBtn = root.querySelector('[data-action="save-chat"]');
  saveChatBtn?.addEventListener('click', () => {
    const content = buildChatMarkdown();
    const filename = makeFilename(
      getState().paper?.meta?.title || getState().paper?.name || '',
      '对话',
    );
    downloadFile(content, filename);
  });
}

/**
 * 跑一次分析任务（流式）。
 * @param {'summarize' | 'explainConcepts' | 'critique'} task
 */
async function runAnalyze(task) {
  if (!root) return;
  if (getState().ui.busy) return; // 双重保险
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
  // 立刻显示"生成中…"占位（首次 push 会被覆盖）
  resultEl.innerHTML = '<div class="ai-placeholder">生成中…</div>';

  // 启动 AbortController + busy
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
    // 已收到的部分先 finalize 渲染好，再在错误区显示原因
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
    // Enter 发送；Shift+Enter 换行；输入法合成中不触发
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.isComposing
    ) {
      e.preventDefault();
      void sendChat();
    }
  });

  // 初始渲染（若 store 已有历史消息——比如刷新前同会话，但当前未做持久化，通常为空）
  renderChatList();
}

/**
 * 发送一条对话。
 */
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

  // 立即清空输入框、追加 user 气泡
  input.value = '';
  appendChatBubble('user', text);

  // 追加一个空 assistant 气泡，作为流式渲染目标（:empty 时 CSS 隐藏）
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

/**
 * 把 store.messages 全量渲染到对话列表。
 * 仅在初始化时调用；运行时 UI 自行 append，不订阅 messages 变化（避免与流式状态打架）。
 */
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
 * 追加一个气泡并滚到底。assistant 气泡返回的元素将作为流式渲染目标。
 * @param {'user' | 'assistant'} role
 * @param {string} text
 * @returns {HTMLElement} 气泡元素本身
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
  // assistant 气泡内容会由 createStreamingRenderer 填充
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
    try {
      currentController.abort();
    } catch {
      /* ignore */
    }
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
