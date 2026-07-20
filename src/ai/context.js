/* =========================================================
 * src/ai/context.js
 *
 * 上下文装配（design.md §5 context 装配）：
 * - 装配顺序固定：GLOBAL_STYLE → 论文全文 → 任务模板（拼成单条 system）
 * - summarize/explainConcepts/critique：不走 messages 历史，
 *   只 [system, 单条 user 触发指令]
 * - chat：[system, ...最近 recentN 轮 messages]，滑窗裁剪：
 *   ① 默认最近 recentN*2 条（user+assistant 成对）
 *   ② 总字符数硬上限 MAX_TOTAL_CHARS，超限时继续丢最旧，保留 system
 *
 * token 估算：粗略按 chars/4，仅用于日志与决策，不发送给 API。
 * ========================================================= */

import {
  GLOBAL_STYLE,
  SUMMARIZE,
  EXPLAIN_CONCEPTS,
  CRITIQUE,
  CHAT,
} from './prompts.js';

/**
 * 总字符硬上限（system + messages 一并算）。
 * 100k 字符 ≈ 25k tokens，对 32k 上下文模型仍有余量。
 */
const MAX_TOTAL_CHARS = 100_000;

/** 粗略 token 估算：英文 ~4 字符/token，中文偏多，这里统一按 4 估。 */
const CHARS_PER_TOKEN = 4;

/** @type {Record<string, string>} */
const TASK_TEMPLATES = {
  summarize: SUMMARIZE,
  explainConcepts: EXPLAIN_CONCEPTS,
  critique: CRITIQUE,
  chat: CHAT,
};

/**
 * @typedef {'summarize' | 'explainConcepts' | 'critique' | 'chat'} Task
 */

/**
 * 装配 OpenAI messages 数组。
 *
 * @param {{
 *   task: Task,
 *   paper?: { fullText?: string } | null,
 *   messages?: Array<{ role: 'user' | 'assistant', content: string }>,
 *   recentN?: number,
 * }} args
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function assemble({ task, paper, messages = [], recentN = 8 }) {
  const taskTemplate = TASK_TEMPLATES[task] || '';
  const paperText = paper?.fullText || '';

  const systemContent = buildSystem({ paperText, taskTemplate });

  if (task === 'chat') {
    const budget = Math.max(0, MAX_TOTAL_CHARS - systemContent.length);
    const recent = slideWindow(messages, recentN, budget);
    return [{ role: 'system', content: systemContent }, ...recent];
  }

  // 一次性任务：system + 一条 user 触发指令（OpenAI 要求至少 1 条 user）
  return [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: '请按照上述任务说明，针对给定论文开始处理，用中文输出。',
    },
  ];
}

/**
 * 拼接 system：GLOBAL_STYLE → 论文全文 → 任务模板。
 * 即便用户后期改写任务模板，全局风格仍前置、不受影响。
 *
 * @param {{ paperText: string, taskTemplate: string }} args
 */
function buildSystem({ paperText, taskTemplate }) {
  /** @type {string[]} */
  const parts = [];
  parts.push(GLOBAL_STYLE);

  parts.push(
    '以下是论文全文，作为你后续回答的唯一依据。若论文为空，请直接告知用户"未加载论文"。',
  );
  if (paperText) {
    parts.push(paperText);
  } else {
    parts.push('（论文全文为空——用户可能尚未加载 PDF。）');
  }

  if (taskTemplate) {
    parts.push(taskTemplate);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * 滑窗：取最近 recentN 轮（user+assistant 配对，即 recentN*2 条）；
 * 若总字符仍超 budget，则继续从最旧丢弃，保留尽可能多的近期对话。
 *
 * @param {Array<{ role: 'user' | 'assistant', content: string }>} messages
 * @param {number} recentN
 * @param {number} budget 字符预算（system 已扣减后剩余）
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
function slideWindow(messages, recentN, budget) {
  if (messages.length === 0) return [];

  const maxPairs = Math.max(0, Math.floor(recentN));
  const maxMessages = maxPairs * 2;
  // 从末尾取最多 maxMessages 条；同时尽量按 user/assistant 配对边界裁剪，
  // 避免把孤立的 assistant 留在窗口最前。
  let start = messages.length - maxMessages;
  if (start < 0) start = 0;
  // 若 start 落在 assistant 上（即第一条留下的是 assistant），向后推一格
  if (start > 0 && messages[start] && messages[start].role === 'assistant') {
    start += 1;
  }
  /** @type {typeof messages} */
  let picked = messages.slice(start);

  // 字符预算裁剪
  let total = picked.reduce((s, m) => s + (m.content?.length || 0), 0);
  while (picked.length > 0 && total > budget) {
    const removed = picked.shift();
    if (!removed) break;
    total -= removed.content?.length || 0;
  }
  return picked;
}

/**
 * 粗略 token 估算（仅用于日志/调试，不参与请求）。
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/** 暴露常量给测试/调试用 */
export const LIMITS = {
  MAX_TOTAL_CHARS,
  CHARS_PER_TOKEN,
};
