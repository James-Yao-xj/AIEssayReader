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
  TRANSLATE,
  CHAT,
} from '../ai/prompts.js';

/**
 * 单个 AI 模型配置组（recognition 或 reading 共用同一结构）。
 * @typedef {Object} ModelConfig
 * @property {string} baseUrl    OpenAI 兼容接口的根地址（末尾不要带 /）。
 * @property {string} apiKey     用户 API Key（本地存储，UI 不回显明文）。
 * @property {string} model      模型名。
 * @property {number} temperature 取样温度，0~2。
 */

/**
 * @typedef {Object} Settings
 * @property {ModelConfig} recognition 文本识别模型配置（PDF 视觉 OCR，逐页转写）。
 * @property {ModelConfig} reading     文本阅读模型配置（总结/解释/批判/对话）。
 * @property {number} fontSize                    阅读区域字体大小 (px)，范围 12~24，默认 14。
 * @property {string} promptSummarize       总结论文的提示词模板。
 * @property {string} promptExplainConcepts 解释概念的提示词模板。
 * @property {string} promptCritique        批判质疑的提示词模板。
 * @property {string} promptTranslate       翻译论文的提示词模板。
 * @property {string} promptChat            对话的提示词模板。
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  // 文本识别模型配置：用于 AI 视觉识别，将 PDF 页面逐页渲染为图片后转写为文字。
  // vision.js 始终使用 temperature=0 以保证转写一致性，此处的 temperature 仅作默认占位。
  recognition: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
  },
  // 文本阅读模型配置：用于论文总结、概念解释、批判分析和多轮对话。
  reading: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
  },
  // 阅读区域字体大小 (px)，范围 12~24
  fontSize: 14,

  // 以下为任务提示词默认值（来自 prompts.js 内置模板，用户可覆盖）
  promptSummarize: SUMMARIZE,
  promptExplainConcepts: EXPLAIN_CONCEPTS,
  promptCritique: CRITIQUE,
  promptTranslate: TRANSLATE,
  promptChat: CHAT,
};
