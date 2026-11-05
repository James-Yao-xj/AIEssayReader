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

import { textContentToString, cleanRepeatedMargins } from './layout.js';
import * as pdfjsLib from 'pdfjs-dist';
// 关键：?worker&inline 让 Vite 把 worker 代码内联为 Blob URL，
// 不依赖外部文件，可被 vite-plugin-singlefile 正确内联进单 HTML。
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';

// The application owns this worker. Pass it explicitly so document cleanup
// destroys only its transport and does not destroy the shared worker wrapper.
export const pdfWorker = new pdfjsLib.PDFWorker({ port: new PdfjsWorker() });

// 同时导出已配置好的 pdfjsLib 供 render.js 复用，避免重复初始化 worker
export { pdfjsLib };

/**
 * 从 PDF 文件提取全文文本（按页保留结构）
 * @param {File} file
 * @param {{signal?: AbortSignal}} [options] Cancel the document transport on abort.
 * @returns {Promise<{
 *   meta: { title?: string, authors?: string[], nPages: number },
 *   fullText: string,
 *   pages: Array<{ pageNum: number, text: string }>
 * }>}
 */
export async function extractText(file, { signal } = {}) {
  signal?.throwIfAborted();
  // File.arrayBuffer() 每次返回新的 buffer，与 renderPdf 并行调用互不影响
  const buf = await file.arrayBuffer();
  signal?.throwIfAborted();
  const loadingTask = pdfjsLib.getDocument({
    data: buf,
    worker: pdfWorker,
  });
  const abort = () => { void loadingTask.destroy().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      const page = await pdf.getPage(i);
      try {
        const tc = await page.getTextContent();
        signal?.throwIfAborted();
        const text = textContentToString(tc, page.getViewport({ scale: 1 }).width);
        pages.push({ pageNum: i, text });
      } finally { page.cleanup(); }
    }

    const cleanedPages = cleanRepeatedMargins(pages);
    const fullText = cleanedPages
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n\n');

    return { meta, fullText, pages: cleanedPages, fingerprint: pdf.fingerprints?.[0] || '' };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await loadingTask.destroy();
  }
}
