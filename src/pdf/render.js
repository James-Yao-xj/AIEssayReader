/* =========================================================
 * src/pdf/render.js
 *
 * PDF 原版渲染（左栏）：把 PDF 页面逐页 canvas 渲染到容器中，支持滚动浏览。
 * 复用 extract.js 配置好的 pdfjsLib 实例（含 worker 配置）。
 *
 * 渲染策略：
 * - 先为每一页占位（避免布局抖动）。
 * - IntersectionObserver 监测可见性 + rootMargin 提前量，按需渲染。
 * - 单页幂等：renderedZoom 记录每页上次渲染时的 userZoom，zoom 不匹配才重渲染。
 *
 * 缩放（Ctrl/Cmd + 滚轮，仅作用于 PDF 栏）：
 * - 以「适应栏宽」为 1× 基准，按 userZoom 重渲染并显式设定 canvas 显示宽度
 *   （行内 maxWidth:none 解除 CSS max-width:100% 上限，放大可出滚动条）。
 * - wheel 监听绑在 container 上、{ passive:false }，preventDefault 阻止浏览器整页缩放。
 * - 非 Ctrl 滚轮放行，保留普通滚动行为与可访问性（C4）。
 * - 向光标处缩放：重渲染前记录光标在锚定页内的纵向比例与视口 y，
 *   重渲染可见页后用真实 getBoundingClientRect 重算 scrollTop（§3.3）。
 * - 非可见页不即时重渲染（保留旧 canvas → 高度不变 → 上方位移稳定 → 锚点准），
 *   滚动进入视口时由 IO 按当前 userZoom 补渲染。
 *
 * 返回 cleanup() 供 main.js 在切换文件时释放资源；setZoom/getZoom 供外部 UI/测试用。
 * ========================================================= */

import { pdfjsLib } from './extract.js';

// ---- 缩放相关常量 ----
/** .pane__scroll 左右 padding（与 styles.css 中 .pane--pdf .pane__scroll{padding:16px} 对齐） */
const PAD_PX = 16;
/** 用户缩放下限（位图宽 ≈ 0.5×适应栏宽） */
const MIN_ZOOM = 0.5;
/** 用户缩放上限（位图宽 ≈ 3×适应栏宽，单页内存可控） */
const MAX_ZOOM = 3.0;
/** 每 tick 缩放倍率（约 5 tick 到 2×） */
const ZOOM_STEP = 1.15;
/** leading+trailing 节流窗口（ms） */
const ZOOM_THROTTLE_MS = 80;
/** 接近 1.0 时 snap 到 1.0（精确回到「适应栏宽」）的阈值 */
const SNAP_TO_ONE = 0.02;
/** IO rootMargin 提前量（px），isHolderVisible 与之对齐 */
const VISIBLE_MARGIN_PX = 400;

/**
 * 渲染 PDF 到容器（左栏）
 * @param {File} file
 * @param {HTMLElement} container 滚动容器（canvas 会被插入这里）
 * @returns {Promise<{ totalPages: number, cleanup: () => void, setZoom: (z:number) => void, getZoom: () => number }>}
 */
export async function renderPdf(file, container) {
  // 清空旧内容（main.js 在调用前应已调用上一个 cleanup，这里再保险一次）
  container.innerHTML = '';

  // File.arrayBuffer() 返回新 buffer，与 extractText 互不影响
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  const total = pdf.numPages;

  // ---- 为每页占位 ----
  // 占位高度取一个接近真实 PDF 页（letter @ scale 1.0 ≈ 792px）的值，
  // 渲染后会被实际 canvas 高度替换。
  /** @type {HTMLDivElement[]} */
  const holders = [];
  for (let i = 1; i <= total; i++) {
    const holder = document.createElement('div');
    holder.className = 'pdf-page-holder';
    holder.dataset.pageNum = String(i);
    holder.style.minHeight = '600px';
    container.appendChild(holder);
    holders.push(holder);
  }

  // ---- 缩放状态 ----
  /** 用户缩放倍率（1.0 = 适应栏宽，等价现状默认体验） */
  let userZoom = 1.0;
  /** pageNum -> 上次渲染该页时使用的 userZoom；zoom 不匹配才需重渲染 */
  const renderedZoom = new Map();

  // ---- 单页渲染（幂等：zoom 不变则跳过）----
  const renderPageInto = async (/** @type {HTMLDivElement} */ holder) => {
    const num = Number(holder.dataset.pageNum);
    // 捕获本次渲染目标 zoom：await 期间 userZoom 可能再变
    const zoom = userZoom;
    if (renderedZoom.get(num) === zoom) return;
    try {
      const page = await pdf.getPage(num);
      // getPage 期间 zoom 可能已变；若已变则放弃本次（让调用方按新 zoom 再来）
      if (userZoom !== zoom) return;
      // 倍率模型（§3.1）：以「适应栏宽」为 1× 基准
      const baseVp = page.getViewport({ scale: 1 });
      const contentW = Math.max(1, container.clientWidth - 2 * PAD_PX);
      const fitScale = contentW / baseVp.width;
      const viewport = page.getViewport({ scale: fitScale * zoom });
      // 清旧 canvas（支持按新 zoom 重渲染）
      holder.replaceChildren();
      const canvas = document.createElement('canvas');
      const w = Math.round(viewport.width);
      const h = Math.round(viewport.height);
      canvas.width = w; // 位图宽 = 显示宽（1:1，文字锐利）
      canvas.height = h;
      canvas.style.width = w + 'px'; // 显式显示宽
      canvas.style.maxWidth = 'none'; // 解除 CSS max-width:100% 上限，允许超出栏宽
      holder.style.minHeight = ''; // 清除占位高度
      holder.appendChild(canvas);
      const ctx = /** @type {CanvasRenderingContext2D | null} */ (
        canvas.getContext('2d')
      );
      if (!ctx) throw new Error('Canvas 2D context 不可用');
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      // 仅当本次渲染目标 zoom 仍是当前 zoom 时才标记完成
      // （若期间又变，不写入——让后续 applyZoom/IO 按新 zoom 重渲染）
      if (userZoom === zoom) renderedZoom.set(num, zoom);
    } catch (err) {
      // 不吞异常：打印明细便于诊断；单页失败不阻塞其它页
      console.error('[pdf] 渲染页', num, '失败：', err);
    }
  };

  // ---- 按需渲染：可见（含 400px 提前量）时触发 ----
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          // 异步渲染，不阻塞观察回调；并发安全由 pdf.js 内部队列保证
          void renderPageInto(/** @type {HTMLDivElement} */ (e.target));
        }
      }
    },
    { root: container, rootMargin: '400px 0px' },
  );

  holders.forEach((h) => io.observe(h));

  // ---- 可见页判定（用于缩放时只重渲染视口内的页）----
  const isHolderVisible = (/** @type {HTMLDivElement} */ holder) => {
    const c = container.getBoundingClientRect();
    const h = holder.getBoundingClientRect();
    // 与 IO 的 400px rootMargin 对齐：含提前量近似
    return h.bottom > c.top - VISIBLE_MARGIN_PX &&
           h.top < c.bottom + VISIBLE_MARGIN_PX;
  };

  // ---- 缩放：clamp + snap + 重渲染可见页 + 锚点 ----
  /**
   * 应用新的 userZoom：clamp/snap → 重渲染可见页 → 按锚点重算 scrollTop。
   * @param {number} nextZoom 期望的下一 zoom
   * @param {WheelEvent | null} anchorEv 锚点事件（null 则保持当前 scrollTop）
   * @returns {Promise<void>}
   */
  const applyZoom = async (nextZoom, anchorEv) => {
    if (destroyed) return; // PDF 已切换/销毁：放弃本次，避免对已 destroy 的 pdf 操作产生异常/噪声
    if (!Number.isFinite(nextZoom)) return;
    let z = nextZoom;
    if (z < MIN_ZOOM) z = MIN_ZOOM;
    if (z > MAX_ZOOM) z = MAX_ZOOM;
    if (Math.abs(z - 1) < SNAP_TO_ONE) z = 1.0; // snap 到「适应栏宽」
    if (z === userZoom) return; // 已是目标 zoom（含 clamp 到边界）→ no-op

    // 记录锚点（重渲染前）
    /** @type {HTMLDivElement | null} */
    let anchoredHolder = null;
    let f = 0; // 光标在锚定页内的纵向比例 [0,1]
    let viewportY = 0; // 光标在容器视口内的 y
    if (anchorEv) {
      const target = anchorEv.target;
      const holder =
        target instanceof Element
          ? /** @type {HTMLDivElement | null} */ (
              target.closest('.pdf-page-holder')
            )
          : null;
      const canvas = holder ? holder.querySelector('canvas') : null;
      if (holder && canvas) {
        const cr = canvas.getBoundingClientRect();
        if (cr.height > 0) {
          let ratio = (anchorEv.clientY - cr.top) / cr.height;
          if (ratio < 0) ratio = 0;
          else if (ratio > 1) ratio = 1;
          f = ratio;
          viewportY =
            anchorEv.clientY - container.getBoundingClientRect().top;
          anchoredHolder = holder;
        }
      }
    }

    userZoom = z;

    // 重渲染当前可见页（非可见页保留旧 canvas → 高度不变 → 锚点 offsetTop 稳定）
    const tasks = [];
    for (const holder of holders) {
      if (isHolderVisible(holder)) tasks.push(renderPageInto(holder));
    }
    if (tasks.length > 0) await Promise.all(tasks);

    // 锚点重算（重渲染后用真实 getBoundingClientRect 自动吸收上方可见页的高度变化）
    if (anchoredHolder) {
      const canvas = anchoredHolder.querySelector('canvas');
      if (canvas) {
        const newH = canvas.getBoundingClientRect().height;
        const containerRect = container.getBoundingClientRect();
        const holderTopInScroll =
          anchoredHolder.getBoundingClientRect().top -
          containerRect.top +
          container.scrollTop;
        const next = Math.max(0, holderTopInScroll + f * newH - viewportY);
        container.scrollTop = next;
      }
    }
  };

  // ---- Ctrl+滚轮缩放：leading+trailing 节流 ----
  /** 非 0 表示有 pending trailing timer */
  let throttleTimer = 0;
  /** 窗口内累积的目标 zoom（非 null 表示有未应用的累积） */
  let pendingTarget = null;
  /** @type {WheelEvent | null} 窗口内最后一次 wheel 事件（取其坐标做锚点） */
  let pendingAnchor = null;
  /** 串行化 applyZoom，防止 leading 与 trailing 并发渲染竞态 */
  let applyChain = Promise.resolve();

    /**
     * 把一次 applyZoom 排入串行队列。
     * @param {number} target
     * @param {WheelEvent | null} anchor
     */
  const scheduleApply = (target, anchor) => {
    applyChain = applyChain
      .then(() => applyZoom(target, anchor))
      .catch((err) => console.error('[pdf] applyZoom 失败：', err));
  };

  /**
   * wheel 监听：仅 Ctrl/Cmd 触发缩放，否则放行普通滚动。
   * 每个 Ctrl+wheel tick 都 preventDefault（即便节流未触发渲染），杜绝整页缩放。
   * @param {WheelEvent} e
   */
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // 非 Ctrl 放行（AC6：普通滚动行为不变）
    e.preventDefault();
    const dir = e.deltaY < 0 ? +1 : -1; // 上滚=放大；触控板 pinch 同样合成 ctrlKey
    const step = dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const base = pendingTarget !== null ? pendingTarget : userZoom;
    const target = base * step;
    pendingTarget = target;
    pendingAnchor = e;
    if (throttleTimer === 0) {
      // leading：窗口首事件立即应用，响应跟手
      const leadTarget = target;
      const leadAnchor = e;
      throttleTimer = setTimeout(() => {
        throttleTimer = 0;
        if (pendingTarget !== null) {
          const t = pendingTarget;
          const a = pendingAnchor;
          pendingTarget = null;
          pendingAnchor = null;
          // trailing：窗口末尾按最终累积 zoom 补一次（用最后一次 wheel 坐标）
          scheduleApply(t, a);
        }
      }, ZOOM_THROTTLE_MS);
      scheduleApply(leadTarget, leadAnchor);
    }
  };

  // 必须非 passive 才能 preventDefault 阻止浏览器整页缩放
  container.addEventListener('wheel', onWheel, { passive: false });

  // ---- 清理 ----
  let destroyed = false;
  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    // 先解绑 wheel（防 trailing 在 destroy 后触发）
    container.removeEventListener('wheel', onWheel);
    if (throttleTimer !== 0) {
      clearTimeout(throttleTimer);
      throttleTimer = 0;
    }
    pendingTarget = null;
    pendingAnchor = null;
    io.disconnect();
    try {
      pdf.destroy();
    } catch {
      /* ignore */
    }
  };

  return {
    totalPages: total,
    cleanup,
    /** 外部（UI 控件/测试）设缩放：绕过节流，无锚点（保持当前 scrollTop）。 */
    setZoom: (z) => {
      const target =
        typeof z === 'number' && Number.isFinite(z) ? z : userZoom;
      void scheduleApply(target, null);
    },
    /** 读取当前 userZoom。 */
    getZoom: () => userZoom,
  };
}
