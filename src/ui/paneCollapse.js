/* =========================================================
 * src/ui/paneCollapse.js
 *
 * 版面最小化 / 恢复（design.md §4 §5）。
 * - 「原文 PDF」「文字提取」两栏可最小化：收成一条 36px 竖条，
 *   其余栏按基准比例（loadPaneRatios）加宽填满释放的空间。
 * - 点击竖条本身（标题栏）或「＋」按钮即可恢复。
 * - 最小化状态只存内存，刷新后重置（不持久化）。
 * - 最小化期间所有分隔条禁用拖拽（与 paneResize.js 协调）。
 * - 仅宽屏（>960px）生效；窄屏纵向堆叠时不进入最小化，
 *   且从宽屏最小化状态缩到窄屏会自动恢复全部展开。
 *
 * 与 paneResize.js 的关系（单向依赖）：
 *   - 本模块读 storage.loadPaneRatios() 作为基准比例（paneResize 每次拖拽结束都会保存，始终 fresh）。
 *   - 本模块只写行内 style.width（瞬态）；最小化时给分隔条加 .pane-gutter--disabled，
 *     paneResize 在该 class 下跳过拖拽/双击。
 * ========================================================= */

import { loadPaneRatios } from '../config/storage.js';

/** pane id → 逻辑键。AI 栏（idx 2）不可最小化 */
const PANE_IDS = ['pane-pdf', 'pane-text', 'pane-ai'];
const PANE_KEYS = ['pdf', 'text', 'ai'];
/** 可最小化的栏（仅 PDF / 文字） */
const MINIMIZABLE = new Set(['pdf', 'text']);

/** 最小化竖条像素宽 */
const COLLAPSED_W = 36;
/** 每根分隔条像素宽（与 styles.css 一致），共 2 根 */
const GUTTER_W = 6;
/** 窄屏断点，与 paneResize.js / CSS 响应式一致 */
const BREAKPOINT = 960;

/** 当前被最小化的栏（仅运行期，不持久化） */
const minimized = new Set();

let inited = false;

/**
 * 初始化：绑定「－」按钮与标题栏点击、窗口 resize。幂等。
 * 由 main.js 在 initPaneResize() 之后调用。
 */
export function initPaneCollapse() {
  if (inited) return;
  // 任一关键元素缺失则放弃（不抛错，保持与其它 init 一致的宽容）
  if (!document.getElementById('pane-pdf') || !document.getElementById('pane-text')) return;
  inited = true;

  // 1) 每个「－」按钮：点击切换最小化/恢复
  /** @type {NodeListOf<HTMLButtonElement>} */
  const btns = document.querySelectorAll('.pane__min-btn');
  btns.forEach((btn) => {
    const key = btn.dataset.pane;
    if (!key || !MINIMIZABLE.has(key)) return;
    btn.addEventListener('click', (e) => {
      // 阻止冒泡到 #pane-pdf 的「点空态选文件」监听
      e.stopPropagation();
      togglePane(key);
    });
  });

  // 2) 标题栏：最小化态下点击恢复（实现「点竖条本身恢复」）
  MINIMIZABLE.forEach((key) => {
    const pane = getPaneEl(key);
    if (!pane) return;
    const header = pane.querySelector('.pane__header');
    if (!header) return;
    header.addEventListener('click', (e) => {
      // 按钮自己的 click 已 stopPropagation，不会走到这里
      if (pane.classList.contains('pane--minimized')) {
        e.stopPropagation();
        restorePane(key);
      }
    });
  });

  // 3) 窗口 resize：仅在有最小化时才需要处理
  //    - 宽屏 → 窄屏：自动恢复全部展开
  //    - 宽屏内变化：按新容器宽重算
  //    - 无最小化时不动作，让百分比宽度自然伸缩（与 paneResize 一致）
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (minimized.size === 0) return;
      if (window.innerWidth <= BREAKPOINT) {
        minimized.clear(); // 窄屏：重置，全部展开
        syncButtons();
      }
      applyLayout();
    }, 120);
  });
}

/**
 * 切换某栏的最小化/展开。
 * @param {'pdf' | 'text'} key
 */
export function togglePane(key) {
  if (!MINIMIZABLE.has(key)) return;
  // 窄屏不进入最小化
  if (window.innerWidth <= BREAKPOINT) return;
  if (minimized.has(key)) minimized.delete(key);
  else minimized.add(key);
  syncButtons();
  applyLayout();
}

/**
 * 恢复某栏（若处于最小化）。
 * @param {'pdf' | 'text'} key
 */
export function restorePane(key) {
  if (!minimized.has(key)) return;
  minimized.delete(key);
  syncButtons();
  applyLayout();
}

// =========================================================
// 布局计算
// =========================================================

/**
 * 依据当前 minimized 集合与基准比例，重算并写入三个 pane 的行内宽度，
 * 切换 .pane--minimized 与 .pane-gutter--disabled。
 * 幂等；窄屏下视为无最小化（不写最小化类、不禁用分隔条）。
 */
function applyLayout() {
  const appMain = document.querySelector('.app-main');
  if (!appMain) return;
  const containerW = appMain.clientWidth;
  if (!containerW) return; // 初始化时序保护

  const base = loadPaneRatios(); // [pdf, text, ai]，始终读最新
  const narrow = window.innerWidth <= BREAKPOINT;
  // 窄屏：最小化不生效，视为空集合（同时 resize 已 clear）
  const activeMin = narrow ? new Set() : minimized;
  const anyMin = activeMin.size > 0;

  // 仅在有最小化时才需要按比例瓜分剩余像素
  let freeW = 0;
  let baseSumNonMin = 1;
  if (anyMin) {
    const fixedW = activeMin.size * COLLAPSED_W + 2 * GUTTER_W;
    freeW = Math.max(0, containerW - fixedW);
    baseSumNonMin = 0;
    PANE_KEYS.forEach((k, i) => {
      const isMin = i < 2 && activeMin.has(k);
      if (!isMin) baseSumNonMin += base[i];
    });
    if (baseSumNonMin <= 0) baseSumNonMin = 1; // 防除零
  }

  PANE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    const isMin = i < 2 && activeMin.has(PANE_KEYS[i]);
    if (isMin) {
      el.style.width = COLLAPSED_W + 'px';
      el.classList.add('pane--minimized');
    } else {
      if (anyMin) {
        const wPx = (base[i] / baseSumNonMin) * freeW;
        el.style.width = (wPx / containerW) * 100 + '%';
      } else {
        // 无最小化：回到基准比例（与 paneResize 一致）
        el.style.width = base[i] + '%';
      }
      el.classList.remove('pane--minimized');
    }
  });

  // 任一栏最小化 → 所有分隔条禁用拖拽
  /** @type {NodeListOf<HTMLElement>} */
  const gutters = appMain.querySelectorAll('.pane-gutter');
  gutters.forEach((g) => {
    g.classList.toggle('pane-gutter--disabled', anyMin);
  });
}

// =========================================================
// 内部工具
// =========================================================

/**
 * 取某栏的 section 元素。
 * @param {'pdf' | 'text' | 'ai'} key
 * @returns {HTMLElement | null}
 */
function getPaneEl(key) {
  const idx = PANE_KEYS.indexOf(key);
  return idx >= 0 ? document.getElementById(PANE_IDS[idx]) : null;
}

/**
 * 同步所有「－/＋」按钮的文案与当前 minimized 状态一致。
 */
function syncButtons() {
  /** @type {NodeListOf<HTMLButtonElement>} */
  const btns = document.querySelectorAll('.pane__min-btn');
  btns.forEach((btn) => {
    const key = btn.dataset.pane;
    if (!key || !MINIMIZABLE.has(key)) return;
    btn.textContent = minimized.has(key) ? '＋' : '－';
    btn.title = minimized.has(key) ? '恢复该版面' : '最小化该版面';
  });
}
