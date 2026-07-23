/* =========================================================
 * src/ui/paneResize.js
 *
 * 三栏可拖拽调整宽度。
 * - 在 PDF-文本、文本-AI 之间各有一条分隔条（gutter）
 * - 鼠标拖拽实时调整相邻两栏宽度，第三栏不受影响
 * - 最小宽度 200px / 15%
 * - 双击分隔条重置为默认比例
 * - 宽度比例持久化到 localStorage（aie:pane-ratios）
 * - 窄屏（≤960px）禁用拖拽
 * ========================================================= */

import { loadPaneRatios, savePaneRatios } from '../config/storage.js';

/** @type {number[]} 默认三栏比例（PDF / 文本 / AI），总和 99%，留约 1% 给两条 gutter */
const DEFAULT_RATIOS = [36, 30, 33];

/** 最小宽度：200px 或 15% 取大值 */
const MIN_WIDTH_PX = 200;
const MIN_WIDTH_PCT = 15;

/** 窄屏断点，与 CSS 响应式保持一致 */
const BREAKPOINT = 960;

/**
 * 初始化三栏可拖拽调整宽度。
 * 由 main.js 在启动阶段调用。
 * 前提：index.html 中已插入两个 `.pane-gutter` 分隔条。
 */
export function initPaneResize() {
  const appMain = document.querySelector('.app-main');
  if (!appMain) return;

  /** @type {HTMLElement[]} */
  const panes = [
    document.getElementById('pane-pdf'),
    document.getElementById('pane-text'),
    document.getElementById('pane-ai'),
  ];
  if (panes.some((p) => !p)) return;

  const gutters = /** @type {HTMLElement[]} */ ([
    ...appMain.querySelectorAll('.pane-gutter'),
  ]);
  if (gutters.length !== 2) return;

  // 加载并应用初始比例
  const ratios = loadPaneRatios();
  panes.forEach((pane, i) => {
    pane.style.width = ratios[i] + '%';
  });

  // 绑定两条分隔条：gutter[0] 在 PDF-文本之间，gutter[1] 在文本-AI 之间
  bindGutter(gutters[0], panes[0], panes[1], appMain);
  bindGutter(gutters[1], panes[1], panes[2], appMain);
}

// ---- 拖拽绑定 ----

/**
 * 为一条分隔条绑定 mousedown → mousemove → mouseup 拖拽流程。
 *
 * @param {HTMLElement} gutterEl - 分隔条元素
 * @param {HTMLElement} leftPane - 左侧 pane
 * @param {HTMLElement} rightPane - 右侧 pane
 * @param {HTMLElement} container - appMain 元素（用于获取容器宽度）
 */
function bindGutter(gutterEl, leftPane, rightPane, container) {
  /** @type {number} */
  let startX = 0;
  /** @type {number} */
  let leftStartPct = 0;
  /** @type {number} */
  let rightStartPct = 0;
  /** @type {number} */
  let containerWidth = 0;
  /** @type {boolean} */
  let dragging = false;

  // ---- mousedown：开始拖拽 ----
  gutterEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 仅左键拖拽
    if (window.innerWidth <= BREAKPOINT) return;
    if (gutterEl.classList.contains('pane-gutter--disabled')) return; // 版面最小化时不拖拽
    e.preventDefault();

    startX = e.clientX;
    containerWidth = container.clientWidth;

    leftStartPct = parseFloat(leftPane.style.width) || 0;
    rightStartPct = parseFloat(rightPane.style.width) || 0;

    dragging = true;

    // 视觉反馈：分隔条高亮 + body 禁止选中 + 全局 col-resize 光标
    gutterEl.classList.add('pane-gutter--dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // 在 document 上绑定，防快速移动时鼠标脱离分隔条
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // ---- mousemove：实时调整两侧 pane 宽度 ----
  function onMouseMove(e) {
    if (!dragging) return;

    const deltaX = e.clientX - startX;
    const deltaPct = (deltaX / containerWidth) * 100;

    let newLeft = leftStartPct + deltaPct;
    let newRight = rightStartPct - deltaPct;

    // 最小宽度约束：像素值或百分比取大者
    const minPct = Math.max(MIN_WIDTH_PCT, (MIN_WIDTH_PX / containerWidth) * 100);

    // 两侧总百分比保持不变（leftStartPct + rightStartPct）
    const total = leftStartPct + rightStartPct;

    if (newLeft < minPct) {
      newLeft = minPct;
      newRight = total - minPct;
    }
    if (newRight < minPct) {
      newRight = minPct;
      newLeft = total - minPct;
    }

    // 二次兜底：两边同时碰边界时不做超限调整
    if (newLeft < minPct) newLeft = minPct;
    if (newRight < minPct) newRight = minPct;

    leftPane.style.width = newLeft + '%';
    rightPane.style.width = newRight + '%';
  }

  // ---- mouseup：结束拖拽 ----
  function onMouseUp() {
    if (!dragging) return;
    dragging = false;

    // 恢复视觉
    gutterEl.classList.remove('pane-gutter--dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    // 解绑事件
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // 持久化当前比例
    savePaneRatios(readCurrentRatios());
  }

  // ---- dblclick：重置为默认比例 ----
  gutterEl.addEventListener('dblclick', () => {
    if (window.innerWidth <= BREAKPOINT) return;
    if (gutterEl.classList.contains('pane-gutter--disabled')) return; // 版面最小化时不重置

    /** @type {(HTMLElement | null)[]} */
    const ids = ['pane-pdf', 'pane-text', 'pane-ai'];
    const allPanes = ids
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (allPanes.length !== 3) return;

    allPanes.forEach((p, i) => {
      p.style.width = DEFAULT_RATIOS[i] + '%';
    });
    savePaneRatios(DEFAULT_RATIOS);
  });
}

// ---- 辅助 ----

/**
 * 从当前 DOM 读取三个 pane 的宽度百分比。
 * @returns {number[]}
 */
function readCurrentRatios() {
  const ids = ['pane-pdf', 'pane-text', 'pane-ai'];
  return ids.map((id, i) => {
    const el = document.getElementById(id);
    if (!el || !el.style.width) return DEFAULT_RATIOS[i];
    const val = parseFloat(el.style.width);
    return Number.isFinite(val) ? val : DEFAULT_RATIOS[i];
  });
}
