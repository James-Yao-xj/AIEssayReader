/* =========================================================
 * src/ui/render.js
 *
 * Markdown + KaTeX 渲染（design.md §2、§6.2）。
 *
 * 暴露：
 *   - renderMarkdown(element, markdownText, { finalize })
 *       marked 把 markdown 转 HTML 写入 element；数学公式由 marked 扩展
 *       直接交 katex 渲染（throwOnError:false，单公式失败不影响整体）。
 *       （finalize 参数保留为 API 约定，实际始终做完整渲染。）
 *   - createStreamingRenderer(element, { intervalMs=80 })
 *       返回 { push(chunk), finalize() }。push 累积文本按 intervalMs 节流渲染；
 *       finalize 做最后一次完整渲染并强制滚动到底。
 *
 * 流式节流策略（design.md §6.2，核心性能点）：
 *   - 不每个 token 都重渲染：push 只累加到 buffer，按 intervalMs（默认 80ms）
 *     调度一次 marked.parse + KaTeX。这样最坏每秒约 12 次重渲染，远低于 token 粒度。
 *   - 由于 marked 数学扩展已把 KaTeX 渲染合并到 marked.parse 一次过，节流后 KaTeX
 *     也只会在每次节流触发时跑一次，避免每 token 全量 KaTeX 卡顿。
 *
 * 单 HTML 兼容：
 *   - 通过 `import 'katex/dist/katex.min.css'` 让 Vite 在构建期把 CSS 抽出并内联；
 *     assetsInlineLimit=100MB 让 CSS 里引用的 woff2 字体也被内联为 data URL。
 * ========================================================= */

import { marked } from 'marked';
import katex from 'katex';
// 让 Vite 在构建期把 KaTeX 的 CSS（含 @font-face 引用的 woff2 字体）一并打进
// 单 HTML。dev 模式下走 <style> 注入；build 模式下经 viteSingleFile 内联进 HTML。
import 'katex/dist/katex.min.css';

// ---------- 安装 marked 数学扩展 ----------
// 行内 $...$、块级 $$...$$ 直接由 katex 渲染。
// 单个公式渲染失败（throwOnError:false）只会原地显示红色错误标记，不影响其他公式。
const inlineMathExt = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.search(/\$[^\s$]/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const match = /^\$([^\n$]+?)\$/.exec(src);
    if (match && match[1].trim()) {
      return {
        type: 'inlineMath',
        raw: match[0],
        latex: match[1],
      };
    }
    return undefined;
  },
  renderer(token) {
    try {
      return katex.renderToString(token.latex, {
        throwOnError: false,
        displayMode: false,
        output: 'html',
      });
    } catch (err) {
      console.warn('[render] inline KaTeX 失败：', err);
      return escapeHtml(token.raw);
    }
  },
};

const blockMathExt = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const i = src.indexOf('$$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
    if (match) {
      return {
        type: 'blockMath',
        raw: match[0],
        latex: match[1],
      };
    }
    return undefined;
  },
  renderer(token) {
    try {
      return (
        '<p class="katex-block">' +
        katex.renderToString(token.latex, {
          throwOnError: false,
          displayMode: true,
          output: 'html',
        }) +
        '</p>'
      );
    } catch (err) {
      console.warn('[render] block KaTeX 失败：', err);
      return '<p>' + escapeHtml(token.raw) + '</p>';
    }
  },
};

marked.use({ extensions: [blockMathExt, inlineMathExt] });

// ---------- 对外渲染 API ----------

/**
 * 把 markdown 渲染到 element（含 KaTeX）。
 * @param {HTMLElement} element
 * @param {string} markdownText
 * @param {{ finalize?: boolean }} [_opts] API 兼容；无论何值都做完整渲染
 */
export function renderMarkdown(element, markdownText, _opts) {
  element.classList.add('md-body');
  element.innerHTML = toHtml(markdownText || '');
}

/**
 * 创建一个流式渲染器：push 累积文本按节流渲染；finalize 做最终完整渲染。
 *
 * @param {HTMLElement} element
 * @param {{ intervalMs?: number }} [opts]
 * @returns {{ push: (chunk: string) => void, finalize: () => void }}
 */
export function createStreamingRenderer(element, opts) {
  const intervalMs = opts?.intervalMs ?? 80;
  let buffer = '';
  /** @type {number | null} */
  let timer = null;
  let finalized = false;

  function flush() {
    timer = null;
    if (finalized) return;
    element.classList.add('md-body');
    element.innerHTML = toHtml(buffer);
    autoScroll(element);
  }

  return {
    push(chunk) {
      if (finalized) return;
      if (!chunk) return;
      buffer += chunk;
      // 只在没有待触发的渲染时才排队，保证最多 intervalMs 一次
      if (timer == null) {
        timer = window.setTimeout(flush, intervalMs);
      }
    },
    finalize() {
      if (finalized) return;
      finalized = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      element.classList.add('md-body');
      element.innerHTML = toHtml(buffer);
      autoScroll(element);
    },
    /** 返回当前已累积的原始 markdown 文本（用于保存/导出）。 */
    getText() {
      return buffer;
    },
  };
}

// ---------- 内部工具 ----------

/**
 * markdown → html（marked）。失败时退化为转义文本，绝不抛错。
 * @param {string} md
 * @returns {string}
 */
function toHtml(md) {
  try {
    const out = marked.parse(md);
    // marked v12 默认同步返回 string；保险起见处理异常类型
    return typeof out === 'string' ? out : escapeHtml(md);
  } catch (err) {
    console.warn('[render] marked 解析失败：', err);
    return escapeHtml(md);
  }
}

/**
 * 让元素所在滚动容器滚到底（流式输出体验）。
 * 仅当用户已接近底部（120px 内）时自动滚，避免抢用户滚动。
 * @param {HTMLElement} el
 */
function autoScroll(el) {
  try {
    const scroller = findScrollParent(el);
    if (!scroller) return;
    const distance =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance < 120) scroller.scrollTop = scroller.scrollHeight;
  } catch {
    /* ignore */
  }
}

/**
 * 找最近的可滚动祖先。
 * @param {HTMLElement} el
 * @returns {HTMLElement | null}
 */
function findScrollParent(el) {
  let p = el.parentElement;
  while (p) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY)) return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * 转义 HTML 特殊字符。
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
