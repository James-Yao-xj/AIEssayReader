/* =========================================================
 * src/pdf/extract.js
 *
 * PDF 文本提取（中栏数据源）+ pdf.js worker 全局配置。
 *
 * 设计：
 * - 用 pdf.js 的 getPage(k).getTextContent() 逐页提取，
 *   按页保留结构（pages: [{pageNum, text}]），并提供拼接的全文。
 * - worker 配置集中在本文件完成一次（render.js 复用同一个 pdfjsLib 实例）。
 *
 * 最高风险点（design.md §6.1）：pdf.js worker 在单 HTML 内联。
 *   方案：用 Vite 的 `?worker&inline`，worker 代码作为 Blob 内联进主 JS，
 *   经 vite-plugin-singlefile 最终并入单 HTML。
 *   若运行时失败，降级方案 B：workerSrc=''（主线程跑），见汇报说明。
 * ========================================================= */

import * as pdfjsLib from 'pdfjs-dist';
// 关键：?worker&inline 让 Vite 把 worker 代码内联为 Blob URL，
// 不依赖外部文件，可被 vite-plugin-singlefile 正确内联进单 HTML。
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';

// 配置一次，全局生效
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfjsWorker();

// 同时导出已配置好的 pdfjsLib 供 render.js 复用，避免重复初始化 worker
export { pdfjsLib };

/**
 * 从 PDF 文件提取全文文本（按页保留结构）
 * @param {File} file
 * @returns {Promise<{
 *   meta: { title?: string, authors?: string[], nPages: number },
 *   fullText: string,
 *   pages: Array<{ pageNum: number, text: string }>
 * }>}
 */
export async function extractText(file) {
  // File.arrayBuffer() 每次返回新的 buffer，与 renderPdf 并行调用互不影响
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: buf,
  });
  const pdf = await loadingTask.promise;

  // ---- 元信息 ----
  /** @type {{ title?: string, authors?: string[], nPages: number }} */
  const meta = { nPages: pdf.numPages };
  try {
    const m = await pdf.getMetadata();
    const info = m?.info || {};
    if (typeof info.Title === 'string' && info.Title.trim()) {
      meta.title = info.Title.trim();
    }
    if (typeof info.Author === 'string' && info.Author.trim()) {
      meta.authors = [info.Author.trim()];
    }
  } catch (err) {
    // 元信息提取失败不阻塞主流程
    console.warn('[pdf] 元信息提取失败：', err);
  }

  // ---- 逐页提取文本 ----
  /** @type {Array<{ pageNum: number, text: string }>} */
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = textContentToString(tc);
    pages.push({ pageNum: i, text });
    page.cleanup(); // 释放页内缓存
  }

  const fullText = pages
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n\n');

  // 清理：销毁文档对象释放 worker 端资源
  try {
    await pdf.destroy();
  } catch {
    /* ignore */
  }

  return { meta, fullText, pages };
}

/**
 * 把 pdf.js 的 TextContent（一组带坐标的 text item）拼成可读字符串。
 *
 * 算法（design.md §1.2）：
 *   Phase 1 — 字号感知行分组：用 item.height 计算阈值，ΔY > 0.5×字号才视为换行；
 *             较小的 Y 偏移（上下标、符号位移）保留在同一逻辑行内。
 *   Phase 2 — 同行内 X 排序：保证左→右阅读顺序。
 *   Phase 3 — 智能间距拼接：相邻 item X 间距超过平均字符宽时插入空格。
 *
 * @param {{ items: Array<any> }} textContent
 * @returns {string}
 */
function textContentToString(textContent) {
  if (!textContent?.items?.length) return '';

  // ---- Phase 1: 字号感知行分组 ----
  /** @type {Array<Array<typeof textContent.items[0]>>} */
  const lineGroups = [];
  /** @type {Array<typeof textContent.items[0]>} */
  let curGroup = [];
  let lastY = null;
  let lastH = null;

  for (const item of textContent.items) {
    if (!item || typeof item.str !== 'string') continue;
    const y = item.transform?.[5];
    const h = item.height || lastH || 12; // 降级：取上一项高度或 12px 默认
    const threshold = h * 0.5;

    if (
      lastY !== null &&
      typeof y === 'number' &&
      Math.abs(y - lastY) > threshold
    ) {
      // 真换行：Y 偏移超过半行高
      if (curGroup.length) lineGroups.push(curGroup);
      curGroup = [];
    }
    curGroup.push(item);

    if (item.hasEOL) {
      if (curGroup.length) lineGroups.push(curGroup);
      curGroup = [];
      lastY = null;
      lastH = null;
    } else if (typeof y === 'number') {
      lastY = y;
      lastH = h;
    }
  }
  if (curGroup.length) lineGroups.push(curGroup);

  // ---- Phase 2 + 3: 同行 X 排序 → 智能间距拼接 ----
  const NUL = String.fromCharCode(0);
  const lines = lineGroups.map((group) => {
    // 按 X 坐标升序（transform[4]），缺失 X 的项保持原序
    const sorted = [...group].sort((a, b) => {
      const ax = a.transform?.[4];
      const bx = b.transform?.[4];
      if (typeof ax === 'number' && typeof bx === 'number') return ax - bx;
      return 0;
    });

    // 智能间距拼接
    let result = '';
    let lastX = null;
    let lastW = null;
    for (const item of sorted) {
      const x = item.transform?.[4];
      const w = item.width;
      // 若 X 间距超过阈值（0.3×字高），插入空格
      if (
        typeof x === 'number' &&
        typeof lastX === 'number' &&
        typeof lastW === 'number' &&
        x - (lastX + lastW) > (item.height || 12) * 0.3
      ) {
        result += ' ';
      }
      result += item.str;
      if (typeof x === 'number') lastX = x;
      lastW = typeof w === 'number' ? w : null;
    }
    return result;
  });

  // 后处理：清理 NUL、行尾空白、多余空行
  return lines
    .join('\n')
    .split(NUL)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
