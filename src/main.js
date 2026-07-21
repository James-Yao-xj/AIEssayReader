/* =========================================================
 * src/main.js
 *
 * 入口：装配各模块、绑定全局事件。
 *
 * 当前范围（Step 0 ~ 3）：
 * - 三栏布局的空壳骨架（index.html 中已就位）
 * - 拖拽 + 文件选择 PDF
 * - 并行调用 extractText + renderPdf，渲染到左栏（PDF）与中栏（临时文本）
 * - 简单状态条（loading / 错误）
 * - 启动时加载设置写入 store（Step 2）
 * - 顶栏设置按钮：打开设置面板（Step 2）
 * - 未填 API Key 时，顶栏给提示徽标
 * - 加载 PDF 后把 paper 写入 store（Step 3 client.js 依赖）
 *
 * 后续 Step（不在本次范围）：
 * - 右栏 AI 面板 UI（Step 4，aiPane.js + render.js 流式渲染）
 * - 中栏追问联动（Step 5）
 * ========================================================= */

import './styles.css';

import { extractText } from './pdf/extract.js';
import { renderPdf } from './pdf/render.js';
import { getState, setState, subscribe } from './state/store.js';
import { loadSettings } from './config/storage.js';
import { initSettings, openSettings } from './ui/settings.js';
import { initAiPane } from './ui/aiPane.js';
import { initTextPane, renderText, renderVisionResult, setVisionHandler, setVisionAbort, setVisionProgress, hideVisionProgress } from './ui/textPane.js';
import { initPaneResize } from './ui/paneResize.js';
import { extractWithVision } from './pdf/vision.js';
import { describeErr } from './utils/errors.js';

// ---- DOM 引用 ----
const dropzone = /** @type {HTMLElement} */ (
  document.getElementById('dropzone')
);
const pdfScroll = /** @type {HTMLElement} */ (
  document.getElementById('pdf-scroll')
);
const panePdf = /** @type {HTMLElement} */ (document.getElementById('pane-pdf'));
const textScroll = /** @type {HTMLElement} */ (
  document.getElementById('text-scroll')
);
const paneText = /** @type {HTMLElement} */ (
  document.getElementById('pane-text')
);
const statusBar = /** @type {HTMLElement} */ (
  document.getElementById('status-bar')
);
const statusText = /** @type {HTMLElement} */ (
  document.getElementById('status-text')
);
const btnSettings = /** @type {HTMLElement | null} */ (
  document.getElementById('btn-settings')
);
const keyHint = /** @type {HTMLElement | null} */ (
  document.getElementById('key-hint')
);

// ---- 当前渲染状态（用于切换文件时清理）----
/** @type {{ cleanup: () => void } | null} */
let currentPdfHandle = null;
/** @type {AbortController | null} */
let activeVisionAbort = null;

// =========================================================
// 状态条
// =========================================================

/** @type {ReturnType<typeof setTimeout> | 0} */
let statusTimer = 0;

/**
 * 显示底部状态条。
 * @param {'info' | 'error' | 'success'} kind
 * @param {string} msg
 * @param {number} [duration] 毫秒，0 表示不自动隐藏
 */
function showStatus(kind, msg, duration = 3000) {
  statusBar.classList.remove(
    'status-bar--error',
    'status-bar--success',
  );
  if (kind === 'error') statusBar.classList.add('status-bar--error');
  else if (kind === 'success') statusBar.classList.add('status-bar--success');
  statusText.textContent = msg;
  statusBar.hidden = false;
  if (duration > 0) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusBar.hidden = true;
    }, duration);
  }
}

function hideStatus() {
  statusBar.hidden = true;
}

// =========================================================
// 加载 PDF 主流程
// =========================================================

/**
 * 处理一个 PDF 文件：并行 extract + render，渲染到左/中栏。
 * @param {File} file
 */
async function loadPdf(file) {
  // 兜底：确保拖拽遮罩已隐藏（dragCounter 可能不同步）
  dropzone.hidden = true;
  dragCounter = 0;

  // 基础校验：必须是 pdf
  const isPdf =
    file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    showStatus('error', `不支持的文件类型：${file.name || file.type}（仅支持 .pdf）`);
    return;
  }

  // 清理上一个 PDF（含正在进行的 AI 视觉识别）
  if (currentPdfHandle) {
    try {
      currentPdfHandle.cleanup();
    } catch {
      /* ignore */
    }
    currentPdfHandle = null;
  }
  // 如果 AI 视觉识别正在运行，取消它（避免旧结果覆盖新 PDF）
  if (activeVisionAbort) {
    activeVisionAbort.abort();
    activeVisionAbort = null;
  }
  // 清空中栏
  textScroll.innerHTML = '';

  // 切换空态/内容显示
  setPaneEmpty(panePdf, false);
  setPaneEmpty(paneText, false);
  pdfScroll.hidden = false;
  textScroll.hidden = false;

  showStatus('info', `加载中：${file.name} …`, 0);

  // 并行：extract（中栏文本） + render（左栏原版）
  // 失败互不致命：哪一边失败就单独报错，另一边仍可工作。
  /** @type {Promise<any>[]} */
  const tasks = [];
  tasks.push(
    renderPdf(file, pdfScroll)
      .then((handle) => {
        currentPdfHandle = handle;
        showStatus(
          'info',
          `渲染中：共 ${handle.totalPages} 页（滚动加载更多）`,
          2500,
        );
      })
      .catch((err) => {
        console.error('[pdf] render 失败：', err);
        showStatus('error', `PDF 渲染失败：${describeErr(err)}`);
      }),
  );
  tasks.push(
    extractText(file)
      .then((result) => {
        renderTextToMiddle(result);
        // 写入 store.paper，供 AI 层（client.js → context.js）使用
        setState({
          paper: {
            name: file.name,
            meta: result.meta || { nPages: result.pages?.length || 0 },
            fullText: result.fullText,
            pages: result.pages || [],
          },
        });
        // 注册 AI 视觉识别按钮回调
        setupVisionHandler(file);
        const meta = result.meta || {};
        const titlePart = meta.title ? `《${meta.title}》` : file.name;
        hideStatus();
        showStatus(
          'success',
          `已加载：${titlePart}（${meta.nPages ?? '?'} 页，${result.fullText.length} 字符）`,
          3500,
        );
      })
      .catch((err) => {
        console.error('[pdf] extract 失败：', err);
        showStatus('error', `文本提取失败：${describeErr(err)}`);
      }),
  );

  await Promise.allSettled(tasks);
}

/**
 * 把 extractText 结果渲染到中栏（delegate 到 textPane 模块）。
 *
 * @param {{ meta: any, fullText: string, pages: Array<{pageNum:number, text:string}> }} result
 */
function renderTextToMiddle(result) {
  renderText(result);
}

/**
 * 注册 AI 视觉识别按钮的回调。每个 PDF 加载后调用一次。
 * @param {File} file
 */
function setupVisionHandler(file) {
  setVisionHandler(async () => {
    // 防御：同一时刻只有一个 vision 任务
    if (activeVisionAbort) {
      activeVisionAbort.abort();
    }
    const ctrl = new AbortController();
    activeVisionAbort = ctrl;
    setVisionAbort(ctrl);

    try {
      showStatus('info', 'AI 视觉识别中…', 0);

      const result = await extractWithVision(file, {
        signal: ctrl.signal,
        onProgress: (current, total) => {
          setVisionProgress(current, total);
          showStatus('info', `AI 识别中 ${current}/${total} 页…`, 0);
        },
      });

      // 更新中栏显示（切换到 AI 模式）
      renderVisionResult(result);
      // 更新 store.paper（AI 分析将使用新结果）
      setState({
        paper: {
          name: file.name,
          meta: result.meta || { nPages: result.pages?.length || 0 },
          fullText: result.fullText,
          pages: result.pages || [],
        },
      });

      const meta = result.meta || {};
      const titlePart = meta.title ? `《${meta.title}》` : file.name;
      hideStatus();
      showStatus(
        'success',
        `AI 识别完成：${titlePart}（${meta.nPages ?? '?'} 页，${result.fullText.length} 字符）`,
        5000,
      );
    } catch (err) {
      hideVisionProgress();
      if (err instanceof Error && err.name === 'AbortError') {
        showStatus('info', 'AI 识别已取消', 3000);
      } else {
        console.error('[vision] 识别失败：', err);
        showStatus('error', `AI 识别失败：${describeErr(err)}`);
      }
    } finally {
      if (activeVisionAbort === ctrl) {
        activeVisionAbort = null;
      }
    }
  });
}

/**
 * 切换某 pane 的空态显示。
 * @param {HTMLElement} pane
 * @param {boolean} isEmpty
 */
function setPaneEmpty(pane, isEmpty) {
  /** @type {HTMLElement | null} */
  const emptyEl = pane.querySelector('[data-empty]');
  if (emptyEl) emptyEl.hidden = !isEmpty;
}

// =========================================================
// 拖拽 + 文件选择
// =========================================================

let dragCounter = 0;

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragCounter++;
  dropzone.hidden = false;
});

window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropzone.hidden = true;
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  // 无条件重置——dragCounter 在跨浏览器下不可靠，drop 即终态
  dragCounter = 0;
  dropzone.hidden = true;
  if (!hasFiles(e)) return;
  const file = pickFirstPdf(e.dataTransfer);
  if (!file) {
    showStatus('error', '请在拖入的文件中包含一个 .pdf');
    return;
  }
  void loadPdf(file);
});

/**
 * 是否携带文件（区分拖文件 vs 拖页面内元素）。
 * @param {DragEvent} e
 */
function hasFiles(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

/**
 * 从 DataTransfer 中挑第一个 pdf。
 * @param {DataTransfer | null} dt
 * @returns {File | null}
 */
function pickFirstPdf(dt) {
  if (!dt) return null;
  const files = dt.files && dt.files.length ? dt.files : dt.items;
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    const f = /** @type {File} */ (files[i]);
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      return f;
    }
  }
  return null;
}

// 点击窗口任意空白处弹出文件选择（占位：Step 5 做 dropzone 内的按钮）
// 这里只挂一个不显眼的快捷方式：右键点击 PDF 空态时触发。
window.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + O：打开文件
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    openFilePicker();
  }
});

/** 通过隐藏 input 触发文件选择 */
function openFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void loadPdf(f);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

// 让左栏 PDF 空态区域点击也能选文件（轻量引导）
panePdf.addEventListener('click', (e) => {
  // 仅在没有 PDF 时点击空态才触发选择
  if (!currentPdfHandle) openFilePicker();
});

// =========================================================
// 启动
// =========================================================

// 1) 初始化设置 modal（创建 DOM、绑定事件）
initSettings();

// 1.5) 初始化右栏 AI 面板（tab / 生成 / 对话 / 流式渲染）
initAiPane();

// 1.6) 初始化中栏追问功能（text selection → 浮层"追问"按钮）
initTextPane();

// 1.7) 初始化三栏可拖拽调整宽度（分隔条 + 比例持久化）
initPaneResize();

// 2) 加载持久化设置写入 store
setState({ settings: loadSettings() });

// 3) 顶栏"设置"按钮 → 打开设置面板
btnSettings?.addEventListener('click', () => openSettings());

// 4) 订阅 settings 变化：两组 API Key 均未填时显示徽标提示
function syncKeyHint(settings) {
  if (!keyHint) return;
  const hasRecKey = !!(settings?.recognition?.apiKey?.trim());
  const hasReadKey = !!(settings?.reading?.apiKey?.trim());
  // 只要有一组配置了 API Key 就隐藏提示（用户可能只用其中一个功能）
  const hasKey = hasRecKey || hasReadKey;
  keyHint.hidden = hasKey;
  if (!hasKey) {
    keyHint.textContent = '未配置 API Key';
    keyHint.style.cursor = 'pointer';
    keyHint.title = '点击打开设置';
    // 点徽标也能打开设置（更醒目的引导）
    keyHint.onclick = () => openSettings();
  } else {
    keyHint.onclick = null;
  }
}
subscribe((s) => syncKeyHint(s.settings));
syncKeyHint(getState().settings);

console.info(
  '[app] AI 论文阅读插件已就绪。' +
    '拖入 PDF 或按 Ctrl/Cmd+O 打开；右上角"设置"填 Base URL/API Key。',
);
