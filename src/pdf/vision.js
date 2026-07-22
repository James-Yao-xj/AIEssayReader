/* =========================================================
 * src/pdf/vision.js
 *
 * AI 视觉识别：PDF 页面渲染为图片 → vision 模型识别 → 返回含 LaTeX 的结构化文本。
 *
 * 复用 pdf.js（render）做页面渲染，复用 openai.js 的 createProvider 做 API 调用。
 * 串行逐页处理，支持 AbortSignal 取消 + onProgress 进度回调。
 * 从 settings.recognition 读取文本识别模型配置。
 * ========================================================= */

import { pdfjsLib } from './extract.js';
import { createProvider, buildVisionMessage } from '../ai/openai.js';
import { getState } from '../state/store.js';

/**
 * Vision 识别时的提示词（要求精确转录 + LaTeX 数学）。
 * 注意：不带论文上下文，不带 GLOBAL_STYLE——这里只是 OCR 角色。
 */
const VISION_PROMPT = `你是一个专业的学术论文 OCR 助手。请精确识别此页面的全部文本内容。

要求：
1. **数学公式**全部用 LaTeX 格式输出：
   - 行内公式用 $...$
   - 独立公式块用 $$...$$
   - 多行公式用 \\begin{aligned}...\\end{aligned} 等环境
2. **保留原文段落结构**，不要合并段落
3. **表格**保留 Markdown 表格格式（| 列1 | 列2 |）
4. **图表标题**保留，图片/图表本身标记为 [图：描述]
5. **不要添加原文没有的内容**，不要总结，不要评论
6. 原文语言保持不变（中文输出中文，英文输出英文）
7. **只输出识别结果**，不要加任何开场白或结束语`;

/**
 * 把 pdf.js page 渲染为 base64 PNG data URL。
 * @param {any} page
 * @param {number} scale
 * @returns {Promise<string>} data:image/png;base64,...
 */
async function renderPageToImage(page, scale = 2.0) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  await page.render({ canvasContext: ctx, viewport }).promise;
  // toBlob 是异步的，包装为 Promise
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas toBlob 失败'));
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(new Error('FileReader 读取失败'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

/**
 * 用 vision 模型逐页识别 PDF，返回与 extractText() 相同结构的结果。
 *
 * @param {File} file
 * @param {{
 *   signal?: AbortSignal,
 *   onProgress?: (current: number, total: number) => void,
 * }} [opts]
 * @returns {Promise<{
 *   meta: { title?: string, authors?: string[], nPages: number },
 *   fullText: string,
 *   pages: Array<{ pageNum: number, text: string }>
 * }>}
 */
export async function extractWithVision(file, opts) {
  const signal = opts?.signal;
  const onProgress = opts?.onProgress;

  // 校验 settings —— 从 recognition 配置组取值
  const { settings } = getState();
  const { recognition } = settings;
  if (!recognition?.apiKey?.trim()) {
    throw new Error('请先在设置中配置文本识别模型的 API Key');
  }
  if (!recognition?.baseUrl?.trim()) {
    throw new Error('请先在设置中配置文本识别模型的 Base URL');
  }
  if (!recognition?.model?.trim()) {
    throw new Error('请先在设置中配置文本识别模型的模型名');
  }

  console.warn('[Config:Use] SOURCE=recognition (vision OCR)', {
    model: recognition.model,
    baseUrl: recognition.baseUrl,
    keyLen: recognition.apiKey?.length || 0,
  });

  const provider = createProvider({
    baseUrl: recognition.baseUrl,
    apiKey: recognition.apiKey,
    model: recognition.model,
    temperature: 0, // OCR 任务始终用 0 温度保证一致性
  });

  // ---- Phase 1: 获取 PDF 文档 ----
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;

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
  } catch {
    /* ignore */
  }

  // ---- Phase 2: 逐页渲染 + 识别 ----
  /** @type {Array<{ pageNum: number, text: string, error?: string }>} */
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    // 检查取消
    if (signal?.aborted) {
      try { await pdf.destroy(); } catch { /* ignore */ }
      throw new DOMException('用户取消', 'AbortError');
    }

    onProgress?.(i, pdf.numPages);

    let page;
    try {
      page = await pdf.getPage(i);
      const dataUrl = await renderPageToImage(page, 2.0);
      const msg = buildVisionMessage(VISION_PROMPT, dataUrl);
      const text = await provider.chatOnce([msg], { signal, stream: false });
      pages.push({ pageNum: i, text: text.trim() });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        try { await pdf.destroy(); } catch { /* ignore */ }
        throw err;
      }
      console.error(`[vision] 第 ${i} 页识别失败：`, err);
      pages.push({
        pageNum: i,
        text: '',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      page?.cleanup();
    }
  }

  try { await pdf.destroy(); } catch { /* ignore */ }

  const fullText = pages
    .map((p) => (p.text ? p.text : `[第 ${p.pageNum} 页识别失败]`))
    .filter(Boolean)
    .join('\n\n');

  return { meta, fullText, pages };
}
