/* =========================================================
 * src/pdf/render.js
 *
 * PDF 原版渲染（左栏）：把 PDF 页面逐页 canvas 渲染到容器中，支持滚动浏览。
 * 复用 extract.js 配置好的 pdfjsLib 实例（含 worker 配置）。
 *
 * 渲染策略：
 * - 先为每一页占位（避免布局抖动）。
 * - IntersectionObserver 监测可见性 + rootMargin 提前量，按需渲染。
 * - 单页幂等：renderedPages 记录已渲染页，避免重复。
 *
 * 返回 cleanup() 供 main.js 在切换文件时释放资源。
 * ========================================================= */

import { pdfjsLib } from './extract.js';

/**
 * 渲染 PDF 到容器（左栏）
 * @param {File} file
 * @param {HTMLElement} container 滚动容器（canvas 会被插入这里）
 * @returns {Promise<{ totalPages: number, cleanup: () => void }>}
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

  // ---- 单页渲染（幂等）----
  const rendered = new Set();
  const renderPageInto = async (/** @type {HTMLDivElement} */ holder) => {
    const num = Number(holder.dataset.pageNum);
    if (rendered.has(num)) return;
    rendered.add(num);
    try {
      const page = await pdf.getPage(num);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      holder.style.minHeight = ''; // 清除占位高度
      holder.appendChild(canvas);
      const ctx = /** @type {CanvasRenderingContext2D} */ (
        canvas.getContext('2d')
      );
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
    } catch (err) {
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

  // ---- 清理 ----
  let destroyed = false;
  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    io.disconnect();
    try {
      pdf.destroy();
    } catch {
      /* ignore */
    }
  };

  return { totalPages: total, cleanup };
}
