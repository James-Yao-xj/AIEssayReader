/* =========================================================
 * src/config/storage.js
 *
 * localStorage 读写设置。
 * - key 固定为 aie:settings，存 JSON。
 * - 读取时与 defaults 合并，保证新增字段有默认值。
 * - Key 明文存（本地工具可接受，见 design.md §6.5），脱敏在 UI 层处理。
 * ========================================================= */

import { DEFAULT_SETTINGS } from './defaults.js';

const STORAGE_KEY = 'aie:settings';

/**
 * 读取设置：与默认值浅合并；任何异常都回退到 defaults，绝不抛错。
 * @returns {Settings}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SETTINGS };
    }
    return {
      ...DEFAULT_SETTINGS,
      ...pickKnownFields(parsed),
    };
  } catch (err) {
    console.warn('[storage] 读取设置失败，使用默认值：', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 保存设置。失败返回 false（调用方可提示用户）。
 * @param {Partial<Settings>} s
 * @returns {boolean}
 */
export function saveSettings(s) {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...pickKnownFields(s) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return true;
  } catch (err) {
    console.warn('[storage] 保存设置失败：', err);
    return false;
  }
}

/**
 * 清除设置（暂未使用，预留给设置面板的"重置"按钮）。
 */
export function clearSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 只保留已知字段，过滤掉意外的 key（localStorage 可能被外部写入脏数据）。
 * @param {any} obj
 */
function pickKnownFields(obj) {
  /** @type {Partial<Settings>} */
  const out = {};
  if (typeof obj.baseUrl === 'string') out.baseUrl = obj.baseUrl;
  if (typeof obj.apiKey === 'string') out.apiKey = obj.apiKey;
  if (typeof obj.model === 'string') out.model = obj.model;
  if (typeof obj.temperature === 'number' && Number.isFinite(obj.temperature)) {
    out.temperature = obj.temperature;
  }
  return out;
}
