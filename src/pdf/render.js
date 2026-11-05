/**
 * Render PDF pages on demand with bounded raster memory.
 *
 * A two-job queue prevents duplicate page renders. Keep up to eight cached
 * pages plus visible pages. Each raster uses at most four million pixels.
 * Zoom and pane width changes invalidate render keys. Private canvases keep
 * stale jobs from replacing the current page view.
 */

import { pdfjsLib, pdfWorker } from './extract.js';

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
 * @param {() => boolean} [isCurrent] Return false after a newer load starts.
 * @returns {Promise<{ totalPages: number, cleanup: () => void, setZoom: (z:number) => void, getZoom: () => number }>}
 */
export async function renderPdf(file, container, isCurrent = () => true) {
  // 清空旧内容（main.js 在调用前应已调用上一个 cleanup，这里再保险一次）
  container.innerHTML = '';

  // File.arrayBuffer() 返回新 buffer，与 extractText 互不影响
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buf, worker: pdfWorker });
  const pdf = await loadingTask.promise;
  if (!isCurrent()) {
    await pdf.destroy();
    throw new DOMException('Document changed', 'AbortError');
  }
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

  let userZoom = 1;
  let destroyed = false;
  // Keep at most two raster jobs active. Queue entries refer to page holders.
  const queue = new Set();
  const active = new Map();
  const visible = new Set();
  const renderedKeys = new Map();
  let running = 0;
  const idleWaiters = [];
  const maxPixels = 4_000_000;
  const maxCachedPages = 8;
  const cacheOrder = new Set();
  let contentWidth = Math.max(1, container.clientWidth - 2 * PAD_PX);
  const key = () => `${userZoom}:${contentWidth}:${window.devicePixelRatio || 1}`;

  /** Release raster memory but keep page geometry for stable scrolling. */
  function releaseCanvas(holder) {
    const canvas = holder.querySelector('canvas');
    if (canvas) {
      holder.style.minHeight = canvas.style.height;
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    renderedKeys.delete(holder);
    cacheOrder.delete(holder);
  }

  /** Evict old offscreen rasters without removing layout placeholders. */
  function trimCache() {
    for (const holder of cacheOrder) {
      if (cacheOrder.size <= maxCachedPages) break;
      if (!visible.has(holder)) releaseCanvas(holder);
    }
  }

  /** Add or refresh one page job. Repeated observer events share one job. */
  function requestPage(holder) {
    if (destroyed || renderedKeys.get(holder) === key()) return;
    queue.add(holder);
    pump();
  }

  function pump() {
    if (destroyed) return;
    for (const holder of queue) {
      if (running >= 2) break;
      if (active.has(holder)) continue;
      queue.delete(holder);
      if (!visible.has(holder) || renderedKeys.get(holder) === key()) continue;
      running++;
      active.set(holder, null);
      void renderPageInto(holder).finally(() => {
        running--;
        active.delete(holder);
        if (!destroyed && visible.has(holder) && renderedKeys.get(holder) !== key()) {
          // A zoom or width change during this job requires one new render.
          if (queue.has(holder)) requestPage(holder);
        }
        pump();
        if (running === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
      });
    }
  }

  /** Render to a private canvas, then publish only the current geometry. */
  async function renderPageInto(holder) {
    const renderKey = key();
    const zoom = userZoom;
    const width = contentWidth;
    let page;
    let canvas;
    try {
      page = await pdf.getPage(Number(holder.dataset.pageNum));
      if (destroyed || renderKey !== key()) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width * zoom });
      const w = Math.max(1, Math.round(viewport.width));
      const h = Math.max(1, Math.round(viewport.height));
      // Bound each raster to 16 MB even on high-density displays.
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(maxPixels / (w * h)));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(w * ratio));
      canvas.height = Math.max(1, Math.floor(h * ratio));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.maxWidth = 'none';
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) throw new Error('Canvas 2D context unavailable');
      const task = page.render({ canvasContext, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      active.set(holder, task);
      await task.promise;
      if (destroyed || renderKey !== key() || !visible.has(holder)) return;
      releaseCanvas(holder);
      holder.style.minHeight = '';
      holder.appendChild(canvas);
      canvas = null;
      renderedKeys.set(holder, renderKey);
      cacheOrder.add(holder);
      trimCache();
    } catch (err) {
      if (!destroyed && err?.name !== 'RenderingCancelledException') {
        console.error('[pdf] Page render failed', holder.dataset.pageNum, err);
      }
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      page?.cleanup();
    }
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visible.add(entry.target);
        requestPage(entry.target);
      } else {
        visible.delete(entry.target);
        queue.delete(entry.target);
        active.get(entry.target)?.cancel();
      }
    }
    trimCache();
  }, { root: container, rootMargin: '400px 0px' });
  holders.forEach((holder) => io.observe(holder));

  const resizeObserver = new ResizeObserver(() => {
    const nextWidth = Math.max(1, container.clientWidth - 2 * PAD_PX);
    if (nextWidth === contentWidth) return;
    contentWidth = nextWidth;
    for (const holder of visible) requestPage(holder);
  });
  resizeObserver.observe(container);

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
    for (const holder of holders) {
      if (isHolderVisible(holder)) { visible.add(holder); requestPage(holder); }
    }
    if (running > 0) await new Promise((resolve) => idleWaiters.push(resolve));

    // 锚点重算（重渲染后用真实 getBoundingClientRect 自动吸收上方可见页的高度变化）
    if (!destroyed && anchoredHolder) {
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
    resizeObserver.disconnect();
    queue.clear();
    for (const task of active.values()) task?.cancel();
    for (const holder of holders) releaseCanvas(holder);
    try {
      void pdf.destroy().catch((err) => console.warn('[pdf] cleanup failed', err));
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
