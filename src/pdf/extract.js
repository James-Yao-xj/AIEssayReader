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
 * 启发式：Y 坐标显著变化时插入换行；item.hasEOL 也作为换行信号。
 * 不强求 100% 还原排版，目标是给 AI 一份结构大致正确的纯文本。
 *
 * @param {{ items: Array<any> }} textContent
 * @returns {string}
 */
function textContentToString(textContent) {
  if (!textContent?.items?.length) return '';
  /** @type {string[]} */
  const lines = [];
  let lastY = null;
  let cur = '';
  const EPS = 2; // 像素级容差：Y 差异大于此值视为换行

  for (const item of textContent.items) {
    if (!item || typeof item.str !== 'string') continue;
    const ty = item.transform?.[5];
    if (
      lastY !== null &&
      typeof ty === 'number' &&
      Math.abs(ty - lastY) > EPS
    ) {
      lines.push(cur);
      cur = '';
    }
    cur += item.str;
    if (item.hasEOL) {
      lines.push(cur);
      cur = '';
      lastY = null;
    } else if (typeof ty === 'number') {
      lastY = ty;
    }
  }
  if (cur) lines.push(cur);

  // pdf.js 偶尔返回 NUL 字符（U+0000），统一清掉；再处理行尾空白与多余空行
  const NUL = String.fromCharCode(0);
  return lines
    .join('\n')
    .split(NUL)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
