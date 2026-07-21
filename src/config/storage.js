/* =========================================================
 * src/config/storage.js
 *
 * localStorage 读写设置。
 * - key 固定为 aie:settings，存 JSON。
 * - 读取时与 defaults 合并，保证新增字段有默认值；嵌套对象（recognition/reading）
 *   进行子字段级合并，不会丢失已保存的独立子字段。
 * - Key 明文存（本地工具可接受，见 design.md §6.5），脱敏在 UI 层处理。
 * - 自动检测旧版扁平格式（顶层 baseUrl），迁移为新嵌套结构并静默写回。
 * ========================================================= */

import { DEFAULT_SETTINGS } from './defaults.js';

const STORAGE_KEY = 'aie:settings';

/**
 * 读取设置：含旧版迁移、嵌套深合并；任何异常都回退到 defaults，绝不抛错。
 * @returns {import('./defaults.js').Settings}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return deepCopyDefaults();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return deepCopyDefaults();
    }

    // 旧版迁移：顶层有 baseUrl 且没有 recognition/reading → 是旧格式
    if (typeof parsed.baseUrl === 'string' && !parsed.recognition && !parsed.reading) {
      return migrateFromFlat(parsed);
    }

    // 新格式：与默认值做深合并
    return deepMergeSettings(DEFAULT_SETTINGS, parsed);
  } catch (err) {
    console.warn('[storage] 读取设置失败，使用默认值：', err);
    return deepCopyDefaults();
  }
}

/**
 * 保存设置。失败返回 false（调用方可提示用户）。
 * @param {Partial<import('./defaults.js').Settings>} s
 * @returns {boolean}
 */
export function saveSettings(s) {
  try {
    const merged = deepMergeSettings(DEFAULT_SETTINGS, s);
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

// ---- 三栏宽度比例持久化 ----
const RATIO_KEY = 'aie:pane-ratios';
/** 默认三栏比例（PDF / 文本 / AI），总和 99%，留约 1% 给两条 gutter */
const DEFAULT_RATIOS = [36, 30, 33];

/**
 * 从 localStorage 读取三栏宽度比例。
 * 任何异常都回退到默认值，绝不抛错。
 * @returns {number[]}
 */
export function loadPaneRatios() {
  try {
    const raw = localStorage.getItem(RATIO_KEY);
    if (!raw) return [...DEFAULT_RATIOS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return [...DEFAULT_RATIOS];
    const valid = parsed.every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (!valid) return [...DEFAULT_RATIOS];
    return parsed;
  } catch {
    return [...DEFAULT_RATIOS];
  }
}

/**
 * 保存三栏宽度比例到 localStorage。
 * @param {number[]} ratios - 三个百分比数字
 * @returns {boolean}
 */
export function savePaneRatios(ratios) {
  try {
    const rounded = ratios.map((v) => Math.round(v * 100) / 100);
    localStorage.setItem(RATIO_KEY, JSON.stringify(rounded));
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 深拷贝 DEFAULT_SETTINGS（含嵌套 recognition/reading 对象）。
 * 避免返回引用，防止调用方意外修改默认值。
 * @returns {import('./defaults.js').Settings}
 */
function deepCopyDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

/**
 * 深合并设置：以 defaults 为底，user 中的值逐字段覆盖。
 * recognition/reading 做子字段级合并（不会因用户存了一个字段而丢掉其他默认字段）。
 * @param {import('./defaults.js').Settings} defaults
 * @param {Partial<import('./defaults.js').Settings>} user
 * @returns {import('./defaults.js').Settings}
 */
function deepMergeSettings(defaults, user) {
  const result = deepCopyDefaults();

  // 合并 recognition 子字段
  if (typeof user.recognition === 'object' && user.recognition !== null) {
    const src = user.recognition;
    if (typeof src.baseUrl === 'string') result.recognition.baseUrl = src.baseUrl;
    if (typeof src.apiKey === 'string') result.recognition.apiKey = src.apiKey;
    if (typeof src.model === 'string') result.recognition.model = src.model;
    if (typeof src.temperature === 'number' && Number.isFinite(src.temperature)) {
      result.recognition.temperature = src.temperature;
    }
  }

  // 合并 reading 子字段
  if (typeof user.reading === 'object' && user.reading !== null) {
    const src = user.reading;
    if (typeof src.baseUrl === 'string') result.reading.baseUrl = src.baseUrl;
    if (typeof src.apiKey === 'string') result.reading.apiKey = src.apiKey;
    if (typeof src.model === 'string') result.reading.model = src.model;
    if (typeof src.temperature === 'number' && Number.isFinite(src.temperature)) {
      result.reading.temperature = src.temperature;
    }
  }

  // 合并提示词
  if (typeof user.promptSummarize === 'string') result.promptSummarize = user.promptSummarize;
  if (typeof user.promptExplainConcepts === 'string') result.promptExplainConcepts = user.promptExplainConcepts;
  if (typeof user.promptCritique === 'string') result.promptCritique = user.promptCritique;
  if (typeof user.promptChat === 'string') result.promptChat = user.promptChat;

  return result;
}

/**
 * 旧版扁平格式 → 新嵌套格式迁移。
 * 旧值同时复制到 recognition 和 reading 两组，提示词也一并搬运。
 * 迁移结果静默写回 localStorage（失败不阻塞）。
 * @param {any} old
 * @returns {import('./defaults.js').Settings}
 */
function migrateFromFlat(old) {
  const result = deepCopyDefaults();

  // 旧版顶层字段提取
  if (typeof old.baseUrl === 'string') {
    result.recognition.baseUrl = old.baseUrl;
    result.reading.baseUrl = old.baseUrl;
  }
  if (typeof old.apiKey === 'string') {
    result.recognition.apiKey = old.apiKey;
    result.reading.apiKey = old.apiKey;
  }
  if (typeof old.model === 'string') {
    result.recognition.model = old.model;
    result.reading.model = old.model;
  }
  if (typeof old.temperature === 'number' && Number.isFinite(old.temperature)) {
    result.recognition.temperature = old.temperature;
    result.reading.temperature = old.temperature;
  }

  // 提示词也一起搬
  if (typeof old.promptSummarize === 'string') result.promptSummarize = old.promptSummarize;
  if (typeof old.promptExplainConcepts === 'string') result.promptExplainConcepts = old.promptExplainConcepts;
  if (typeof old.promptCritique === 'string') result.promptCritique = old.promptCritique;
  if (typeof old.promptChat === 'string') result.promptChat = old.promptChat;

  // 静默写回 localStorage（失败不阻塞）
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    /* 静默失败——内存中的迁移结果仍然可用 */
  }

  return result;
}
