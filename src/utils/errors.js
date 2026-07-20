/* =========================================================
 * src/utils/errors.js
 *
 * 跨模块共享的错误描述工具。
 * ========================================================= */

/**
 * 把任意错误转成一句话；AbortError 单独翻译为"已停止"。
 * @param {any} err
 * @returns {string}
 */
export function describeErr(err) {
  if (!err) return '未知错误';
  if (err instanceof Error && err.name === 'AbortError') {
    return '已停止。';
  }
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
