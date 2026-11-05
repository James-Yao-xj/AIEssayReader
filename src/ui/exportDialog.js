import { getState } from '../state/store.js';
import { renderMarkdown } from './render.js';
import { activateDialog } from './dialog.js';

/** Tab id → 中文短标签（用于文件名）。 */
const TAB_LABEL = /** @type {Record<string, string>} */ ({
  summarize: '总结',
  explainConcepts: '概念解释',
  critique: '质疑',
  translate: '翻译',
  chat: '对话',
});

// ---------- 保存/下载工具 ----------

/**
 * 生成合法的下载文件名（不含扩展名）。
 * @param {string} paperTitle 论文标题（可能含非法字符）
 * @param {string} tag 类型标签（如"总结""质疑""对话"）
 * @returns {string}
 */
function makeFilename(paperTitle, tag) {
  const safe = (paperTitle || '未命名论文').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  const date = new Date().toISOString().slice(0, 10);
  return `${safe}_${tag}_${date}`;
}

/**
 * 触发浏览器直接下载（Blob 方式，不选路径）。
 * @param {string} content 文件内容
 * @param {string} filename 文件名
 * @param {string} [mimeType]
 */
function downloadFile(content, filename, mimeType) {
  const mime = mimeType || 'text/markdown;charset=utf-8';
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 使用 File System Access API 保存到用户选择的路径。
 * 不可用时回退到直接下载。
 * @param {string} content
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<boolean>} 是否成功（用户取消返回 false）
 */
async function saveViaFileSystemAPI(content, filename, mimeType) {
  try {
    if (!window.showSaveFilePicker) {
      downloadFile(content, filename, mimeType);
      return true;
    }
    const ext = filename.split('.').pop() || 'md';
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: ext === 'pdf' ? 'PDF 文档' : 'Markdown 文档',
        accept: ext === 'pdf'
          ? { 'application/pdf': ['.pdf'] }
          : { 'text/markdown': ['.md'] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch (err) {
    // AbortError = 用户点了取消
    if (/** @type {DOMException} */ (err).name === 'AbortError') return false;
    // 其他错误回退到直接下载
    downloadFile(content, filename, mimeType);
    return true;
  }
}

/**
 * 构建 markdown → 完整 HTML 文档（供打印/PDF 使用）。
 * 复用 renderMarkdown 以得到正确的 KaTeX 渲染结果。
 * @param {string} markdownContent
 * @returns {string} 完整的 HTML 文档字符串
 */
function buildPrintHtml(markdownContent) {
  const temp = document.createElement('div');
  renderMarkdown(temp, markdownContent || '');
  const bodyHtml = temp.innerHTML;

  // 收集当前页所有 <style>（含 KaTeX 字体/样式），保证打印窗口排版一致
  const styles = Array.from(document.querySelectorAll('style'))
    .map((s) => s.outerHTML)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>AI 阅读导出</title>
  ${styles}
  <style>
    body {
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.8;
      color: #1f2328;
    }
    @media print {
      body { margin: 0; padding: 20px; }
    }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/**
 * 执行实际下载。
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat'} task
 * @param {'md' | 'pdf'} format
 * @param {string} filename
 * @param {boolean} useFileSystemAPI 是否使用 File System Access API 选择路径
 * @returns {Promise<boolean>}
 */
async function executeDownload(task, format, filename, useFileSystemAPI) {
  // 获取 markdown 内容
  let markdownContent;
  if (task === 'chat') {
    markdownContent = buildChatMarkdown();
  } else {
    markdownContent = buildAnalyzeMarkdown(
      /** @type {'summarize' | 'explainConcepts' | 'critique' | 'translate'} */ (task),
      getState().savedResults[task] || '',
    );
  }

  if (format === 'md') {
    if (useFileSystemAPI) {
      return await saveViaFileSystemAPI(markdownContent, filename, 'text/markdown;charset=utf-8');
    }
    downloadFile(markdownContent, filename, 'text/markdown;charset=utf-8');
    return true;
  }

  // PDF：打开打印窗口（用户可在打印对话框中选择"另存为 PDF"并指定路径）
  const html = buildPrintHtml(markdownContent);
  const w = window.open('', '_blank');
  if (!w) {
    throw new Error('弹窗被浏览器拦截，请允许本站弹窗后重试。');
    return false;
  }
  w.document.write(html);
  w.document.close();
  let printed = false;
  const printOnce = async () => {
    if (printed || w.closed) return;
    printed = true;
    await w.document.fonts?.ready;
    if (!w.closed) w.print();
  };
  w.addEventListener('load', () => { void printOnce(); }, { once: true });
  if (w.document.readyState === 'complete') void printOnce();
  return true;
}

/**
 * 构建分析 Tab 的 markdown 文件内容。
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'translate'} task
 * @param {string} rawText AI 原始输出
 * @returns {string}
 */
function buildAnalyzeMarkdown(task, rawText) {
  const { paper } = getState();
  const title = paper?.meta?.title || paper?.name || '未命名论文';
  const now = new Date().toLocaleString('zh-CN');
  const tag = TAB_LABEL[task] || task;
  return [
    `# ${title}`,
    '',
    `> **${tag}**  |  生成时间：${now}`,
    '',
    '---',
    '',
    `> 状态：${({ complete: '已完成', failed: '失败，未完成', interrupted: '已中断，未完成', generating: '生成中，未完成' })[getState().resultStatuses?.[task] || 'complete']}`,
    (rawText || '').trim(),
  ].join('\n');
}

/**
 * 构建对话记录的 markdown 文件内容。
 * @returns {string}
 */
function buildChatMarkdown() {
  const { paper, messages } = getState();
  const title = paper?.meta?.title || paper?.name || '未命名论文';
  const now = new Date().toLocaleString('zh-CN');
  const lines = [
    `# ${title}`,
    '',
    `> **对话记录**  |  导出时间：${now}`,
    '',
    '---',
    '',
  ];
  for (const m of messages) {
    const roleLabel = m.role === 'user' ? '**🧑 你**' : '**🤖 AI**';
    lines.push(`### ${roleLabel}${m.status && m.status !== 'complete' ? `（${m.status}，未完成）` : ''}`);
    lines.push('');
    lines.push((m.content || '').trim());
    lines.push('');
  }
  return lines.join('\n');
}

// =========================================================
// 下载选项对话框
// =========================================================

/** 关闭已存在的下载对话框。 */
let releaseExportFocus = null;

function closeDownloadDialog() {
  const release = releaseExportFocus;
  releaseExportFocus = null;
  document.querySelectorAll('[data-export-dialog]').forEach((el) => el.remove());
  release?.();
}

/**
 * 弹出下载选项对话框。
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat'} task
 */
export function showDownloadDialog(task) {
  closeDownloadDialog();

  const tag = TAB_LABEL[task] || task;
  const baseName = makeFilename(
    getState().paper?.meta?.title || getState().paper?.name || '',
    tag,
  );

  const overlay = document.createElement('div');
  overlay.className = 'download-dialog-overlay';
  overlay.dataset.exportDialog = '';
  overlay.innerHTML = `
    <div class="download-dialog" role="dialog" aria-modal="true" aria-labelledby="download-title" tabindex="-1">
      <div class="download-dialog__header">
        <h3 id="download-title">保存「${escapeHtml(tag)}」</h3>
        <button type="button" class="download-dialog__close"
          data-action="dl-close">&times;</button>
      </div>
      <div class="download-dialog__body">
        <label class="download-dialog__label">文件格式</label>
        <div class="download-dialog__format">
          <label class="download-dialog__radio">
            <input type="radio" name="dl-format" value="md" checked>
            <span class="download-dialog__radio-text">
              <strong>Markdown (.md)</strong>
              <small>纯文本格式，兼容性好，可再次编辑</small>
            </span>
          </label>
          <label class="download-dialog__radio">
            <input type="radio" name="dl-format" value="pdf">
            <span class="download-dialog__radio-text">
              <strong>PDF (.pdf)</strong>
              <small>排版固定，适合打印和分享</small>
            </span>
          </label>
        </div>
        <label class="download-dialog__label" for="dl-filename">文件名</label>
        <input id="dl-filename" type="text"
          class="download-dialog__filename-input"
          value="${escapeHtml(baseName)}.md" data-dl-filename>
      </div>
      <div class="download-dialog__actions">
        <button type="button" class="ai-btn ai-btn--ghost"
          data-action="dl-close">取消</button>
        <button type="button" class="ai-btn ai-btn--ghost"
          data-action="dl-direct">直接下载</button>
        <button type="button" class="ai-btn ai-btn--primary"
          data-action="dl-path">选择路径保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = document.createElement('p');
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  overlay.querySelector('.download-dialog__body').append(errorEl);
  function showExportError(error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
  // --- 事件绑定 ---
  const close = () => closeDownloadDialog();
  const filenameInput = /** @type {HTMLInputElement | null} */ (
    overlay.querySelector('[data-dl-filename]')
  );

  // 关闭按钮 + 点击遮罩关闭
  overlay.querySelectorAll('[data-action="dl-close"]').forEach((b) =>
    b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  releaseExportFocus = activateDialog(overlay, close);

  // 直接下载
  overlay.querySelector('[data-action="dl-direct"]')?.addEventListener('click', () => {
    const format = /** @type {HTMLInputElement} */ (
      overlay.querySelector('input[name="dl-format"]:checked')
    ).value;
    const fname = filenameInput?.value || `${baseName}.${format}`;
    void executeDownload(task, /** @type {'md' | 'pdf'} */ (format), fname, false).then(close).catch(showExportError);
  });

  // 选择路径保存
  overlay.querySelector('[data-action="dl-path"]')?.addEventListener('click', async () => {
    const format = /** @type {HTMLInputElement} */ (
      overlay.querySelector('input[name="dl-format"]:checked')
    ).value;
    const fname = filenameInput?.value || `${baseName}.${format}`;
    try {
      const ok = await executeDownload(task, /** @type {'md' | 'pdf'} */ (format), fname, true);
      if (ok) close();
    } catch (error) { showExportError(error); }
  });

  // 切换格式时同步扩展名
  overlay.querySelectorAll('input[name="dl-format"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!filenameInput) return;
      const fmt = /** @type {HTMLInputElement} */ (
        overlay.querySelector('input[name="dl-format"]:checked')
      ).value;
      filenameInput.value = filenameInput.value.replace(/\.(md|pdf)$/, `.${fmt}`);
    });
  });

  // 聚焦并全选文件名
  if (filenameInput) {
    filenameInput.focus();
    filenameInput.select();
  }
}

// ---------- escapeHtml ----------

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

