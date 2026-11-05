/* =========================================================
 * src/ui/textPane.js
 *
 * 中栏——提取文本展示 + 选中文本追问联动 + 识别模式切换开关。
 *
 * 暴露：initTextPane() / renderText(result) / renderVisionResult(result) /
 *       setVisionHandler(fn) / setVisionProgress(current, total) /
 *       hideVisionProgress().
 *
 * 模式切换：
 *   pdf.js 提取（默认） ←→ AI 视觉识别
 *   开关拨到 AI 侧时触发 visionHandler，识别完成后自动切换显示。
 *   两种结果都缓存，来回切换无需重新识别。
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { renderMarkdown } from './render.js';

/** @type {HTMLElement | null} */
let askBtn = null;
/** @type {HTMLElement | null} */
let scrollEl = null;
/** @type {string | null} */
let selectedText = null;

// ---- 模式切换 ----
/** @type {(() => void) | null} */
let visionHandler = null;
/** @type {AbortController | null} */
let visionAbort = null;
let visionRunning = false;
/** @type {string} */
let currentMode = 'pdfjs'; // 'pdfjs' | 'vision'

// 缓存两种结果
/** @type {{ meta: any, pages: Array<{pageNum:number, text:string}> } | null} */
let cachedPdfJsResult = null;
/** @type {{ meta: any, pages: Array<{pageNum:number, text:string}> } | null} */
let cachedVisionResult = null;

// DOM 引用（在 renderText 中创建，模式切换时复用）
/** @type {HTMLElement | null} */
let toggleTrack = null;
/** @type {HTMLElement | null} */
let toggleThumb = null;
/** @type {HTMLElement | null} */
let progressLabel = null;
/** @type {HTMLElement | null} */
let cancelLabel = null;

/**
 * 初始化：创建浮层"追问"按钮，绑定 selection 事件。幂等。
 */
export function initTextPane() {
  if (askBtn) return;
  scrollEl = document.getElementById('text-scroll');
  if (!scrollEl) return;

  // 浮层追问按钮
  askBtn = document.createElement('button');
  askBtn.className = 'text-ask-btn';
  askBtn.textContent = '追问';
  askBtn.hidden = true;
  askBtn.addEventListener('click', () => {
    if (!selectedText) return;
    const text = selectedText.trim();
    if (!text) return;
    const prompts = [
      `请帮我分析论文中的这一段内容：\n\n> ${sliceText(text, 800)}\n\n请解释这段的核心含义，并在合适的情况下给出批判性分析。`,
    ];
    setState({
      ui: { ...getState().ui, activeTab: 'chat', quickAsk: prompts[0] },
    });
    hideAskBtn();
  });
  document.body.appendChild(askBtn);

  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mousedown', (e) => {
    if (askBtn && !askBtn.contains(/** @type {Node} */ (e.target))) {
      hideAskBtn();
    }
  });
}

// ---- 对外 API ----

/** Clear text and OCR state before a new document load. */
export function resetTextPane() {
  cachedPdfJsResult = null;
  cachedVisionResult = null;
  visionHandler = null;
  hideVisionProgress();
  hideAskBtn();
  if (toggleTrack) toggleTrack.classList.remove('text-mode-toggle--vision');
  currentMode = 'pdfjs';
}


/**
 * 注册 AI 视觉识别的回调。main.js 调用。
 * @param {((retryFailedOnly?: boolean) => Promise<void>) | null} fn
 */
export function setVisionHandler(fn) {
  visionHandler = fn;
  const retry = scrollEl?.querySelector('.text-mode-retry');
  if (retry) retry.disabled = !fn || visionRunning;
}

/**
 * 设置 AbortController。
 * @param {AbortController} ctrl
 */
export function setVisionAbort(ctrl) {
  visionAbort = ctrl;
}

/**
 * 更新 AI 识别进度。
 * @param {number} current
 * @param {number} total
 */
export function setVisionProgress(current, total) {
  visionRunning = true;
  if (progressLabel) {
    progressLabel.textContent = `识别中 ${current}/${total}`;
    progressLabel.hidden = false;
  }
  if (cancelLabel) cancelLabel.hidden = false;
}

/**
 * 隐藏 AI 识别进度。
 */
export function hideVisionProgress() {
  visionRunning = false;
  visionAbort = null;
  if (progressLabel) progressLabel.hidden = true;
  if (cancelLabel) cancelLabel.hidden = true;
  const retry = scrollEl?.querySelector('.text-mode-retry');
  if (retry) retry.disabled = !visionHandler;
}

/**
 * 渲染 pdf.js 提取结果（默认模式）。同时缓存结果供切换回时复用。
 * @param {{ meta: any, fullText: string, pages: Array<{pageNum:number, text:string}> }} result
 */
export function renderText(result) {
  if (!scrollEl) {
    scrollEl = document.getElementById('text-scroll');
    if (!scrollEl) return;
  }
  cachedVisionResult = null;
  hideVisionProgress();
  if (toggleTrack) toggleTrack.classList.remove('text-mode-toggle--vision');
  cachedPdfJsResult = { meta: result.meta, pages: result.pages || [] };
  currentMode = 'pdfjs';
  renderCurrent();
}

/**
 * 渲染 AI 视觉识别结果。缓存结果并切换到 vision 模式。
 * @param {{ meta: any, pages: Array<{pageNum:number, text:string}> }} result
 */
export function renderVisionResult(result) {
  cachedVisionResult = { meta: result.meta, pages: result.pages || [] };
  hideVisionProgress();
  // 确保开关在 vision 侧
  if (toggleTrack) toggleTrack.classList.add('text-mode-toggle--vision');
  currentMode = 'vision';
  renderCurrent();
}

// ---- 内部渲染 ----

/** Focus a cited text page when its PDF binary is not available. */
export function focusTextPage(pageNum) {
  const page = scrollEl?.querySelector(`[data-page-num="${pageNum}"]`);
  if (!page) return;
  page.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  page.setAttribute('tabindex', '-1');
  page.focus({ preventScroll: true });
}

function renderCurrent() {
  if (!scrollEl) return;
  scrollEl.innerHTML = '';

  const pages = currentMode === 'vision' && cachedVisionResult
    ? cachedVisionResult.pages
    : cachedPdfJsResult?.pages || [];
  const meta = (currentMode === 'vision' && cachedVisionResult
    ? cachedVisionResult.meta
    : cachedPdfJsResult?.meta) || {};

  if (pages.length === 0) {
    scrollEl.appendChild(
      el('div', { class: 'pane__empty' },
        el('div', { class: 'pane__empty-title' }, '未提取到文本'),
        el('div', { class: 'pane__empty-desc' }, '该 PDF 可能是扫描件，没有文本层。'),
      ),
    );
    return;
  }

  // 元信息 + 模式切换开关
  const metaDiv = el('div', { class: 'text-meta' });
  const parts = [];
  if (meta.title) parts.push(meta.title);
  if (meta.authors?.length) parts.push(meta.authors.join(', '));
  if (parts.length) {
    metaDiv.appendChild(document.createTextNode(parts.join(' · ')));
  }

  // 模式切换开关
  metaDiv.appendChild(buildToggle());
  const failed = cachedVisionResult?.pages.filter((page) => page.error || !page.text.trim()).length || 0;
  if (failed) {
    const retry = el('button', { type: 'button', class: 'text-mode-retry' }, `重试失败页（${failed} 页）`);
    retry.disabled = !visionHandler || visionRunning;
    retry.addEventListener('click', () => startVision(true));
    metaDiv.appendChild(retry);
  }
  scrollEl.appendChild(metaDiv);

  // 分页 — 每页正文走 marked+KaTeX 渲染
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const bodyEl = el('div', { class: 'text-page__body' });
    renderMarkdown(bodyEl, p.text || (p.error ? `识别失败：${p.error}` : '（无文本）'));
    const pageDiv = el('div', { class: 'text-page' },
      el('div', { class: 'text-page__head' }, `第 ${p.pageNum} 页`),
      bodyEl,
    );
    pageDiv.dataset.pageNum = String(p.pageNum);
    frag.appendChild(pageDiv);
  }
  scrollEl.appendChild(frag);
}

// ---- 模式切换开关 ----

function buildToggle() {
  const wrapper = el('span', { class: 'text-mode-toggle-wrapper' });

  // pdf.js 标签
  const leftLabel = el('span', { class: 'text-mode-label' }, 'pdf.js');

  // 滑动轨道
  toggleTrack = el('button', { type: 'button', class: 'text-mode-toggle', 'aria-label': '切换 PDF 文本与 AI 识别（首次识别会调用配置的模型）' });
  if (currentMode === 'vision') toggleTrack.classList.add('text-mode-toggle--vision');
  toggleThumb = el('span', { class: 'text-mode-toggle__thumb' });
  toggleTrack.appendChild(toggleThumb);
  toggleTrack.addEventListener('click', () => onToggleClick());

  // AI 标签
  const rightLabel = el('span', { class: 'text-mode-label' }, 'AI');

  // 进度文字
  progressLabel = el('span', { class: 'text-mode-progress' });
  progressLabel.hidden = true;

  // 取消按钮
  cancelLabel = el('button', { type: 'button', class: 'text-mode-cancel', 'aria-label': '取消识别' });
  cancelLabel.textContent = '✕';
  cancelLabel.hidden = true;
  cancelLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    if (visionAbort) visionAbort.abort();
  });

  wrapper.appendChild(leftLabel);
  wrapper.appendChild(toggleTrack);
  wrapper.appendChild(rightLabel);
  wrapper.appendChild(progressLabel);
  wrapper.appendChild(cancelLabel);
  return wrapper;
}

function startVision(retryFailedOnly) {
  if (!visionHandler || visionRunning) return;
  setVisionProgress(0, cachedPdfJsResult?.pages.length || cachedVisionResult?.pages.length || 0);
  const retry = scrollEl?.querySelector('.text-mode-retry');
  if (retry) retry.disabled = true;
  void visionHandler(retryFailedOnly);
}

function onToggleClick() {
  if (visionRunning) return;

  if (currentMode === 'pdfjs') {
    // 切换到 AI 模式
    if (cachedVisionResult) {
      // 已经识别过，直接切换
      currentMode = 'vision';
      if (toggleTrack) toggleTrack.classList.add('text-mode-toggle--vision');
      renderCurrent();
    } else if (visionHandler) {
      // 首次切换，触发识别
      toggleTrack?.classList.add('text-mode-toggle--vision');
      startVision(false);
    } else {
      alert('请先在设置中配置 API Key 和支持 vision 的模型。');
    }
  } else {
    // 切换回 pdf.js
    currentMode = 'pdfjs';
    if (toggleTrack) toggleTrack.classList.remove('text-mode-toggle--vision');
    hideVisionProgress();
    if (visionAbort) { visionAbort.abort(); visionAbort = null; }
    renderCurrent();
  }
}

// =========================================================
// 内部：selection → 浮层按钮
// =========================================================

function onSelectionChange() {
  if (!askBtn || !scrollEl) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!scrollEl.contains(range.commonAncestorContainer)) {
    hideAskBtn();
    return;
  }
  const text = sel.toString().trim();
  if (!text || text.length < 10) {
    hideAskBtn();
    return;
  }
  selectedText = text;

  const rect = range.getBoundingClientRect();
  const btnW = 64;
  const btnH = 32;
  let top = rect.bottom + 4;
  let left = rect.right - btnW / 2;
  if (top + btnH > window.innerHeight - 8) top = rect.top - btnH - 4;
  if (left < 8) left = 8;
  if (left + btnW > window.innerWidth - 8) left = window.innerWidth - btnW - 8;

  askBtn.style.top = `${top}px`;
  askBtn.style.left = `${left}px`;
  askBtn.hidden = false;
}

function hideAskBtn() {
  if (askBtn) askBtn.hidden = true;
  selectedText = null;
}

// =========================================================
// 工具
// =========================================================

function sliceText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return text.slice(0, half) + '\n…[省略中间]…\n' + text.slice(-half);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c instanceof Node) e.appendChild(c);
  }
  return e;
}
