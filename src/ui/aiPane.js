import { showSegmentedDialog } from './segmentedDialog.js';
import { showDownloadDialog } from './exportDialog.js';
/* =========================================================
 * src/ui/aiPane.js
 *
 * 右栏 AI 面板（design.md §2、§4）。
 *
 * - 5 个 tab：总结(summarize) / 概念(explainConcepts) / 质疑(critique) / 翻译(translate) / 对话(chat)
 * - 四大分析 tab：生成按钮 + .md-body 结果区，createStreamingRenderer 边收边渲染
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
import { searchRelated, computeBadges } from '../related/relatedPapers.js';

const TABS = [
  { id: 'summarize', label: '总结' },
  { id: 'explainConcepts', label: '概念' },
  { id: 'critique', label: '质疑' },
  { id: 'translate', label: '翻译' },
  { id: 'chat', label: '对话' },
  { id: 'related', label: '相关论文' },
];

/** @type {HTMLElement | null} */
let root = null;

/** @type {AbortController | null} */
let currentController = null;
// Stop queued DOM writes when the document changes.
let paneVersion = 0;
let currentRenderer = null;

/** 相关论文结果条目徽标元素映射：paperId → 徽标 <a>。 */
const badgeEls = /** @type {Map<string, HTMLElement>} */ (new Map());

/** 代码徽标后台任务的中止控制器（切换论文 / 重新检索时中止）。 */
let badgeAbort = null;

/** 上次已预填相关论文搜索框的论文名（用于检测 paper 切换）。 */
let lastPrefillPaper = null;

// ---------- 存档功能接口 ----------

/**
 * 获取当前所有分析 tab 的已生成结果快照（供存档使用）。
 * @returns {Record<string, string>}
 */
export function getSavedResults() {
  return { ...getState().savedResults };
}

/**
 * 恢复分析 tab 结果（供存档恢复使用）。
 * 写入后同步各 tab 保存按钮状态。
 * @param {Record<string, string>} rs
 */
export function setSavedResults(rs) {
  const results = {};
  const tasks = /** @type {const} */ (['summarize', 'explainConcepts', 'critique', 'translate']);
  for (const t of tasks) {
    results[t] = typeof rs[t] === 'string' ? rs[t] : '';
    const result = root?.querySelector(`[data-section="${t}"] [data-result]`);
    if (result) renderMarkdown(result, results[t]);
  }
  setState({ savedResults: results });
  for (const t of tasks) syncSaveButton(t);
}

/**
 * 存档恢复后刷新 UI：重渲染对话列表、更新保存按钮、切到有内容的 tab。
 */
export function refreshAfterRestore() {
  renderChatList();
  const tasks = /** @type {const} */ (['summarize', 'explainConcepts', 'critique', 'translate']);
  for (const t of tasks) syncSaveButton(t);
  syncChatSaveButton();

  // 切换到第一个有内容的 tab（优先分析 tab，其次对话）
  for (const t of tasks) {
    if (getState().savedResults[t]) {
      setState({ ui: { ...getState().ui, activeTab: t } });
      return;
    }
  }
  if (getState().messages.length > 0) {
    setState({ ui: { ...getState().ui, activeTab: 'chat' } });
  }
}

/** 同步分析 Tab 保存按钮状态。 */
function syncSaveButton(task) {
  if (!root) return;
  const btn = root.querySelector(`[data-action="save"][data-task="${task}"]`);
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = !getState().savedResults[task] || getState().ui.busy;
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
 * 同步对话状态栏：显示检索/摘要的运行状态。
 * @param {null | { text: string }} status
 */
function syncChatStatus(status) {
  if (!root) return;
  const el = root.querySelector('[data-chat-status]');
  if (!el) return;
  if (status && status.text) {
    el.textContent = status.text;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
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
          id="tab-${t.id}" aria-controls="panel-${t.id}" data-tab="${t.id}" aria-selected="false">${t.label}</button>`,
      ).join('')}
    </div>
    <div class="chat-status" data-chat-status role="status" aria-live="polite" hidden></div>
    <div class="ai-body">
      ${renderAnalyzeTab('summarize', '总结', '生成结构化的全文总结（一句话/背景/方法/结果/局限）。')}
      ${renderAnalyzeTab('explainConcepts', '解释概念', '抽取并解释论文中的关键概念（含官方定义 + 通俗解释）。')}
      ${renderAnalyzeTab('critique', '批判质疑', '从方法/结果/论证三个层面对论文提出质疑并给改进建议。')}
      ${renderAnalyzeTab('translate', '翻译', '把论文全文忠实翻译成中文，保留公式/代码/结构与引用标记。')}
      ${renderChatTab()}
      ${renderRelatedTab()}
    </div>
  `;
  paneAi.appendChild(root);

  bindTabs();
  bindAnalyzeButtons();
  bindChat();
  bindRelated();

  let previousPaper = getState().paper;
  subscribe((s) => {
    if (s.paper === previousPaper) return;
    previousPaper = s.paper;
    paneVersion++;
    abortCurrent();
    currentController = null;
    currentRenderer?.finalize();
    currentRenderer = null;
    abortBadgePass();
    const relatedStatus = root.querySelector('[data-related-status]');
    if (relatedStatus) relatedStatus.hidden = true;
    const searchButton = root.querySelector('[data-action="related-search"]');
    if (searchButton) searchButton.textContent = '检索';
    setSavedResults({});
    renderChatList();
    root.querySelectorAll('[data-error]').forEach(hideError);
    setState({ ui: { ...getState().ui, busy: false, quickAsk: null } });
  });

  // 订阅 store：tab 高亮 + busy 态同步 + 追问联动 + 保存按钮状态
  subscribe((s) => {
    syncTabs(s.ui.activeTab);
    syncBusy(s.ui.busy);
    syncChatSaveButton();
    syncChatStatus(s.chatStatus);
    root.querySelectorAll('[data-result-status]').forEach((element) => {
      const task = element.closest('[data-section]').dataset.section;
      const status = s.resultStatuses[task];
      const progress = s.segmentedTask?.task === task ? s.segmentedTask : null;
      const labels = { generating: '生成中', complete: '已完成', interrupted: '已停止，内容未完成', failed: '生成失败，内容未完成' };
      element.hidden = !status;
      element.textContent = (labels[status] || '') + (progress ? ` · 分段进度 ${progress.nextIndex}/${progress.total}` : '');
    });
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
  // 相关论文搜索框：论文切换时预填标题 + 清空结果
  subscribe((s) => syncRelatedPrefill(s.paper));

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
          <button type="button" class="ai-btn ai-btn--ghost" data-action="segmented" data-task="${id}">分段处理…</button>
          <button type="button" class="ai-btn ai-btn--ghost"
            data-action="stop" hidden>停止</button>
        </div>
      </div>
      <div class="ai-section__desc">${desc}</div>
      <div class="chat-status" data-result-status role="status" hidden></div>
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
    btn.addEventListener('keydown', (event) => {
      const tabs = [...root.querySelectorAll('.ai-tab')];
      const index = tabs.indexOf(btn);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      if (getState().ui.busy) return;
      tabs[next].click();
      tabs[next].focus();
    });
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
    el.tabIndex = active ? 0 : -1;
    el.classList.toggle('ai-tab--active', active);
  });
  root.querySelectorAll('.ai-pane__section').forEach((sec) => {
    const el = /** @type {HTMLElement} */ (sec);
    el.id = `panel-${el.dataset.section}`;
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', `tab-${el.dataset.section}`);
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
  root.querySelectorAll('[data-action="generate"], [data-action="segmented"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = busy;
  });
  root.querySelectorAll('[data-action="send"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = busy;
  });
  root.querySelectorAll('[data-action="related-search"]').forEach((btn) => {
    /** @type {HTMLButtonElement} */ (btn).disabled = busy;
  });
  root.querySelectorAll('[data-action="save"]').forEach((btn) => {
    const el = /** @type {HTMLElement} */ (btn);
    /** @type {HTMLButtonElement} */ (btn).disabled =
      busy || !getState().savedResults[el.dataset.task || ''];
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
  root.querySelectorAll('[data-action="segmented"]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = button.dataset.task;
      const error = root.querySelector(`[data-section="${task}"] [data-error]`);
      showSegmentedDialog(task, () => void runAnalyze(task, true), (err) => showError(error, describeErr(err)));
    });
  });
  root.querySelectorAll('[data-action="generate"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement} */ (e.currentTarget);
      const task = el.dataset.task;
      if (!task) return;
      void runAnalyze(
        /** @type {'summarize' | 'explainConcepts' | 'critique' | 'translate'} */ (task),
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
      if (!task || !getState().savedResults[task]) return;
      showDownloadDialog(
        /** @type {'summarize' | 'explainConcepts' | 'critique' | 'translate'} */ (task),
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
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'translate'} task
 */
async function runAnalyze(task, segmented = false) {
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

  const version = paneVersion;
  currentController = new AbortController();
  setState({ ui: { ...getState().ui, busy: true } });

  saveAnalysis(task, '', 'generating');
  const renderer = currentRenderer = createStreamingRenderer(resultEl, { intervalMs: 80,
    onUpdate: (text) => { if (version === paneVersion) saveAnalysis(task, text, 'generating'); } });
  try {
    const iterable = segmented ? client.runSegmented(task, currentController.signal) :
      task === 'summarize'
        ? client.summarize(currentController.signal)
        : task === 'explainConcepts'
          ? client.explainConcepts(currentController.signal)
          : task === 'critique'
            ? client.critique(currentController.signal)
            : task === 'translate'
              ? client.translate(currentController.signal)
              : client.critique(currentController.signal); // 理论不可达兜底
    for await (const chunk of iterable) {
      if (version !== paneVersion) return;
      renderer.push(chunk);
    }
    if (version !== paneVersion) return;
    renderer.finalize();
    saveAnalysis(task, renderer.getText(), 'complete');
  } catch (err) {
    if (version !== paneVersion) return;
    renderer.finalize();
    saveAnalysis(task, renderer.getText(), err.name === 'AbortError' ? 'interrupted' : 'failed');
    showError(errorEl, describeErr(err));
  } finally {
    if (version !== paneVersion) return;
    currentRenderer = null;
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

  const version = paneVersion;
  currentController = new AbortController();
  setState({ ui: { ...getState().ui, busy: true } });

  const renderer = currentRenderer = createStreamingRenderer(assistantEl, { intervalMs: 80 });
  try {
    for await (const chunk of client.chat(text, currentController.signal)) {
      if (version !== paneVersion) return;
      renderer.push(chunk);
    }
    if (version !== paneVersion) return;
    renderer.finalize();
  } catch (err) {
    if (version !== paneVersion) return;
    renderer.finalize();
    if (renderer.getText()) appendMessageStatus(assistantEl, { status: err.name === 'AbortError' ? 'interrupted' : 'failed' });
    if (!renderer.getText()) {
      if (!input.value) input.value = text;
      renderChatList();
    }
    if (errorEl) showError(errorEl, describeErr(err));
  } finally {
    if (version !== paneVersion) return;
    currentRenderer = null;
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
    appendMessageStatus(bubble, m);
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
// 相关论文 tab
// =========================================================

function renderRelatedTab() {
  return `
    <section class="ai-pane__section ai-pane__section--related" data-section="related" hidden>
      <div class="ai-section__head">
        <div class="ai-section__title">相关论文</div>
      </div>
      <div class="ai-section__desc">基于当前论文（或手动输入）检索相似文献与引用网络。</div>
      <div class="related-search">
        <input class="related-search__input" data-related-input
          placeholder="论文标题 / DOI / arXiv / URL…" autocomplete="off" spellcheck="false" />
        <button type="button" class="ai-btn ai-btn--primary"
          data-action="related-search">检索</button>
      </div>
      <div class="ai-error" data-error hidden></div>
      <div class="related-status" data-related-status hidden></div>
      <div class="related-results" data-related-results>
        <div class="ai-placeholder">加载论文后自动填入标题，或手动输入后点「检索」。</div>
      </div>
    </section>
  `;
}

function bindRelated() {
  if (!root) return;
  const searchBtn = root.querySelector('[data-action="related-search"]');
  const input = root.querySelector('[data-related-input]');
  searchBtn?.addEventListener('click', () => void runRelatedSearch());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void runRelatedSearch();
    }
  });
}

async function runRelatedSearch() {
  if (!root) return;
  if (getState().ui.busy) return;

  const input = /** @type {HTMLInputElement | null} */ (
    root.querySelector('[data-related-input]')
  );
  const searchBtn = /** @type {HTMLButtonElement | null} */ (
    root.querySelector('[data-action="related-search"]')
  );
  const resultsEl = root.querySelector('[data-related-results]');
  const errorEl = root.querySelector('.ai-pane__section--related [data-error]');
  const statusEl = root.querySelector('[data-related-status]');
  const query = input?.value?.trim();
  if (!query) {
    if (errorEl) showError(errorEl, '请输入论文标题 / DOI / arXiv / URL。');
    return;
  }

  if (errorEl) hideError(errorEl);
  badgeEls.clear();
  abortBadgePass();
  if (resultsEl) resultsEl.innerHTML = '<div class="ai-placeholder">检索中…</div>';
  if (statusEl) {
    statusEl.textContent = '检索中…';
    statusEl.hidden = false;
  }

  const version = paneVersion;
  currentController = new AbortController();
  badgeAbort = new AbortController();
  setState({ ui: { ...getState().ui, busy: true } });
  if (searchBtn) searchBtn.textContent = '检索中…';

  try {
    const results = await searchRelated(query, { signal: currentController.signal });
    if (version !== paneVersion) return;
    if (resultsEl) renderRelatedResults(resultsEl, results);
    // 后台跑代码徽标（不阻塞主结果）
    void computeBadges(results, {
      signal: badgeAbort.signal,
      onBadge: applyBadge,
    }).catch((err) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('[related] 代码徽标校验中断：', err);
    });
  } catch (err) {
    if (version !== paneVersion) return;
    if (resultsEl) resultsEl.innerHTML = '';
    if (errorEl) showError(errorEl, describeErr(err));
  } finally {
    if (version !== paneVersion) return;
    currentRenderer = null;
    setState({ ui: { ...getState().ui, busy: false } });
    currentController = null;
    if (statusEl) statusEl.hidden = true;
    if (searchBtn) searchBtn.textContent = '检索';
  }
}

function renderRelatedResults(container, results) {
  if (!container) return;
  container.innerHTML = '';
  const groups = [
    ['⭐ 相似推荐', results.recommendations],
    ['🔗 参考文献（前人工作）', results.references],
    ['📖 被引论文（后续工作）', results.citations],
  ];
  for (const [label, papers] of groups) {
    const group = document.createElement('div');
    group.className = 'related-group';

    const head = document.createElement('div');
    head.className = 'related-group__title';
    head.textContent = label;
    group.appendChild(head);

    if (!papers || papers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'related-empty';
      empty.textContent = '（无结果）';
      group.appendChild(empty);
    } else {
      for (const p of papers) {
        group.appendChild(buildRelatedItem(p));
      }
    }
    container.appendChild(group);
  }
}

function buildRelatedItem(p) {
  const item = document.createElement('div');
  item.className = 'related-item';

  const title = document.createElement('a');
  title.className = 'related-item__title';
  title.textContent = p.title || '(无标题)';
  const href = safeHref(p.url);
  if (href) {
    title.href = href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
  }

  const meta = document.createElement('div');
  meta.className = 'related-item__meta';
  const parts = [];
  if (p.authors?.length) {
    parts.push(
      p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' 等' : ''),
    );
  }
  if (p.year) parts.push(String(p.year));
  if (p.venue) parts.push(p.venue);
  if (p.citationCount > 0) parts.push(`被引 ${p.citationCount}`);
  meta.textContent = parts.length ? parts.join(' · ') : '—';

  item.appendChild(title);
  item.appendChild(meta);

  if (p.abstract) {
    const abs = document.createElement('div');
    abs.className = 'related-item__abstract';
    abs.textContent =
      p.abstract.length > 200 ? p.abstract.slice(0, 200) + '…' : p.abstract;
    item.appendChild(abs);
  }

  // 徽标占位：命中时由 applyBadge 填充
  const badge = document.createElement('a');
  badge.className = 'related-badge';
  badge.hidden = true;
  badge.target = '_blank';
  badge.rel = 'noopener noreferrer';
  item.appendChild(badge);
  if (p.paperId) badgeEls.set(p.paperId, badge);

  return item;
}

function applyBadge(paperId, repo) {
  if (!paperId) return;
  const el = badgeEls.get(paperId);
  if (!el) return;
  el.textContent = '有代码';
  el.title = repo.repo + (repo.stars ? ` ⭐${repo.stars}` : '');
  el.href = `https://github.com/${repo.repo}`;
  el.hidden = false;
}

function abortBadgePass() {
  if (badgeAbort) {
    try {
      badgeAbort.abort();
    } catch {
      /* ignore */
    }
    badgeAbort = null;
  }
}

/**
 * 论文切换时：预填搜索框标题 + 清空结果 + 中止后台徽标。
 * @param {import('../state/store.js').State['paper']} paper
 */
function syncRelatedPrefill(paper) {
  if (!root) return;
  const name = paper;
  if (name === lastPrefillPaper) return;
  lastPrefillPaper = name;

  const input = /** @type {HTMLInputElement | null} */ (
    root.querySelector('[data-related-input]')
  );
  if (input) input.value = paper?.meta?.title || '';

  const resultsEl = root.querySelector('[data-related-results]');
  if (resultsEl) {
    resultsEl.innerHTML =
      '<div class="ai-placeholder">加载论文后自动填入标题，或手动输入后点「检索」。</div>';
  }
  const errorEl = root.querySelector('.ai-pane__section--related [data-error]');
  if (errorEl) hideError(errorEl);
  badgeEls.clear();
  abortBadgePass();
}

/**
 * @param {string | null | undefined} url
 * @returns {string | null} 仅放行 http/https 外链，否则返回 null
 */
function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
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

/** Return analysis completion state for archive compatibility. */
export function getSavedResultStatuses() { return { ...getState().resultStatuses }; }

/** Restore completion state and update its visible labels. */
export function setSavedResultStatuses(statuses) {
  setState({ resultStatuses: { ...statuses } });
}

function saveAnalysis(task, text, status) {
  setState({ savedResults: { ...getState().savedResults, [task]: text },
    resultStatuses: { ...getState().resultStatuses, [task]: status } });
}

function appendMessageStatus(element, message) {
  if (!message.status || message.status === 'complete') return;
  const label = document.createElement('div');
  label.className = 'chat-status';
  label.textContent = message.status === 'generating' ? '生成中' : '未完成：可保留、导出或重新提问';
  element.append(label);
}
