/* =========================================================
 * src/ui/textPane.js
 *
 * 中栏——提取文本展示 + 选中文本追问联动。
 *
 * 暴露：initTextPane()（创建浮层按钮 + 绑定事件）、
 *       renderText(result)（把 extractText 结果渲染到中栏）。
 *
 * 追问联动（design.md §4）：
 *   用户选中一段文本 → 浮出"追问"按钮 → 点击后切到对话 tab
 *   → 通过 store.ui.quickAsk 通知 aiPane 自动发送。
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { renderMarkdown } from './render.js';

/** @type {HTMLElement | null} */
let askBtn = null;
/** @type {HTMLElement | null} */
let scrollEl = null;
/** @type {string | null} */
let selectedText = null;

/**
 * 初始化：创建浮层"追问"按钮（始终挂在 #text-scroll），绑定 selection 事件。
 * 幂等。
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
    // 构造一段含引用上下文的追问引导语
    const prompts = [
      `请帮我分析论文中的这一段内容：\n\n> ${sliceText(text, 800)}\n\n请解释这段的核心含义，并在合适的情况下给出批判性分析。`,
    ];
    setState({
      ui: { ...getState().ui, activeTab: 'chat', quickAsk: prompts[0] },
    });
    hideAskBtn();
  });
  // 插入到 text-scroll 容器的兄弟位置或 body，用 fixed 定位
  document.body.appendChild(askBtn);

  // 监听 selection 变化
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mousedown', (e) => {
    // 点击浮层按钮以外的地方就隐藏
    if (askBtn && !askBtn.contains(/** @type {Node} */ (e.target))) {
      hideAskBtn();
    }
  });
}

/**
 * 把 extractText 的结果渲染到中栏 #text-scroll。
 * @param {{ meta: any, fullText: string, pages: Array<{pageNum:number, text:string}> }} result
 */
export function renderText(result) {
  if (!scrollEl) {
    scrollEl = document.getElementById('text-scroll');
    if (!scrollEl) return;
  }
  scrollEl.innerHTML = '';
  const pages = result.pages || [];
  if (pages.length === 0) {
    scrollEl.appendChild(
      el('div', { class: 'pane__empty' },
        el('div', { class: 'pane__empty-title' }, '未提取到文本'),
        el('div', { class: 'pane__empty-desc' }, '该 PDF 可能是扫描件，没有文本层。'),
      ),
    );
    return;
  }
  // 元信息
  const meta = result.meta || {};
  if (meta.title || meta.authors?.length) {
    const parts = [];
    if (meta.title) parts.push(meta.title);
    if (meta.authors?.length) parts.push(meta.authors.join(', '));
    scrollEl.appendChild(
      el('div', { class: 'text-meta' }, parts.join(' · ')),
    );
  }
  // 分页 — 每页正文走 marked+KaTeX 渲染
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const bodyEl = el('div', { class: 'text-page__body' });
    renderMarkdown(bodyEl, p.text || '（无文本）');
    const pageDiv = el('div', { class: 'text-page' },
      el('div', { class: 'text-page__head' }, `第 ${p.pageNum} 页`),
      bodyEl,
    );
    frag.appendChild(pageDiv);
  }
  scrollEl.appendChild(frag);
}

// =========================================================
// 内部：selection → 浮层按钮
// =========================================================

function onSelectionChange() {
  if (!askBtn || !scrollEl) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    // 短暂延迟再隐藏，避免快速双击选中时闪烁
    return;
  }
  const range = sel.getRangeAt(0);
  // 必须在中栏文本区（#text-scroll 内）才显示追问按钮
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

  // 把按钮定位到选中文字末尾附近
  const rect = range.getBoundingClientRect();
  const btnW = 64;
  const btnH = 32;
  let top = rect.bottom + 4;
  let left = rect.right - btnW / 2;
  // 边界修正
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

/**
 * 截断文本（保留前后各一部分，中间加省略号）。
 * @param {string} text
 * @param {number} maxLen
 */
function sliceText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return text.slice(0, half) + '\n…[省略中间]…\n' + text.slice(-half);
}

/**
 * @param {string} tag
 * @param {Record<string,string>} attrs
 * @param  {...(string|Node)} children
 * @returns {HTMLElement}
 */
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
