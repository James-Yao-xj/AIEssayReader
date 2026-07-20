/* =========================================================
 * src/config/defaults.js
 *
 * 默认设置值（用户可改）。这些是合理示例值，非强制。
 * 真正的 key/baseUrl 由用户在设置面板填写，存 localStorage。
 * 提示词默认值来自 prompts.js 的内置模板——用户可在设置面板中自定义。
 * ========================================================= */

import {
  SUMMARIZE,
  EXPLAIN_CONCEPTS,
  CRITIQUE,
  CHAT,
} from '../ai/prompts.js';

/**
 * @typedef {Object} Settings
 * @property {string} baseUrl    OpenAI 兼容接口的根地址（末尾不要带 /）。
 * @property {string} apiKey     用户 API Key（本地存储，UI 不回显明文）。
 * @property {string} model      模型名。
 * @property {number} temperature 取样温度，0~2。
 * @property {string} promptSummarize       总结论文的提示词模板。
 * @property {string} promptExplainConcepts 解释概念的提示词模板。
 * @property {string} promptCritique        批判质疑的提示词模板。
 * @property {string} promptChat            对话的提示词模板。
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  // OpenAI 官方兼容端点；DeepSeek/OpenRouter/本地 vLLM/Ollama 均兼容此协议。
  // 可改为：https://api.deepseek.com/v1、https://openrouter.ai/api/v1 等。
  baseUrl: 'https://api.openai.com/v1',
  // 默认为空，必须由用户在设置面板填写后才可调用 AI。
  apiKey: '',
  // 示例模型，按各 provider 实际支持调整。
  model: 'gpt-4o-mini',
  // 0 更确定、1+ 更发散；0.3 适合结构化分析任务。
  temperature: 0.3,
  // 以下为任务提示词默认值（来自 prompts.js 内置模板，用户可覆盖）
  promptSummarize: SUMMARIZE,
  promptExplainConcepts: EXPLAIN_CONCEPTS,
  promptCritique: CRITIQUE,
  promptChat: CHAT,
};
